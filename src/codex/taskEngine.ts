import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { AppServer } from "./appServer.js";
import { Store, type TaskRecord, type TaskStatus } from "../store.js";
import { config } from "../config.js";

export type ApprovalKind = "command" | "fileChange" | "permissions";

export interface PendingApproval {
  requestId: number | string;
  method: string;
  kind: ApprovalKind;
  params: any;
  taskId: string;
  task: TaskRecord;
  startedAt: number;
  resultLabel?: string;
  resolve: (result: unknown) => void;
  timer?: NodeJS.Timeout;
}

export interface ApprovalResolvedEvent {
  requestId: number | string;
  taskId: string;
  task: TaskRecord;
  label: string;
}

interface TaskEngineEvents {
  approval: (pending: PendingApproval) => void;
  approvalResolved: (event: ApprovalResolvedEvent) => void;
  taskStarted: (task: TaskRecord) => void;
  taskDone: (task: TaskRecord) => void;
  taskUpdated: (task: TaskRecord) => void;
  warning: (taskId: string | null, message: string) => void;
}

export declare interface TaskEngine {
  on<K extends keyof TaskEngineEvents>(event: K, listener: TaskEngineEvents[K]): this;
  once<K extends keyof TaskEngineEvents>(event: K, listener: TaskEngineEvents[K]): this;
  emit<K extends keyof TaskEngineEvents>(event: K, ...args: Parameters<TaskEngineEvents[K]>): boolean;
}

function sandboxPolicy(cwd: string) {
  switch (config.sandbox) {
    case "read-only":
      return { type: "readOnly" as const, networkAccess: true };
    case "danger-full-access":
      return { type: "dangerFullAccess" as const };
    case "workspace-write":
    default:
      return {
        type: "workspaceWrite" as const,
        writableRoots: [cwd],
        networkAccess: true,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: false,
      };
  }
}

function threadParams(cwd: string) {
  return {
    ...(config.model ? { model: config.model } : {}),
    cwd,
    approvalPolicy: config.approvalPolicy,
    sandbox: config.sandbox,
    serviceName: "codex_discord",
  };
}

export class TaskEngine extends EventEmitter {
  private threadToTask = new Map<string, string>();
  private pending = new Map<string, PendingApproval>();
  private itemSnapshots = new Map<string, any>();
  private appServer: AppServer;

  constructor(appServer: AppServer, private store: Store) {
    super();
    this.appServer = appServer;
  }

  /** Wire server-request/notification handlers to the latest app-server connection. */
  attach(appServer: AppServer): void {
    this.appServer = appServer;
    const approvals: Array<[string, ApprovalKind]> = [
      ["item/commandExecution/requestApproval", "command"],
      ["item/fileChange/requestApproval", "fileChange"],
      ["item/permissions/requestApproval", "permissions"],
    ];
    for (const [method, kind] of approvals) {
      appServer.onServerRequest(method, (id, params) => this.handleApproval(id, params as any, kind));
    }
    // Not the core use case; unblock with a benign default instead of deadlocking the turn.
    appServer.onServerRequest("item/tool/requestUserInput", (id) => {
      void id;
      return Promise.resolve({ answers: {} });
    });
    appServer.onServerRequest("mcpServer/elicitation/request", (id) => {
      void id;
      return Promise.resolve({ action: "cancel", content: null });
    });
    appServer.onServerRequest("item/tool/call", (id) => {
      void id;
      return Promise.resolve({ contentItems: [] });
    });
    appServer.on("notification", (n) => this.onNotification(n));

    // Any approvals still outstanding on the dead connection are now void.
    for (const [reqKey, p] of [...this.pending]) {
      this.pending.delete(reqKey);
      if (p.timer) clearTimeout(p.timer);
      p.resolve({ decision: "cancel" });
      if (this.pendingCountFor(p.taskId) === 0) {
        const task = this.store.getTask(p.taskId);
        if (task && task.status === "awaitingApproval") this.store.patchTask(task.id, { status: "running" });
      }
    }
  }

  start(): void {
    for (const task of this.store.listTasks()) {
      if (task.status === "running" || task.status === "awaitingApproval") {
        this.store.patchTask(task.id, {
          status: "interrupted",
          error: "Server restarted while this task was running.",
        });
        this.emit("taskDone", this.store.getTask(task.id)!);
      }
    }
  }

  // ---- lifecycle ----

  async startTask(opts: { discordUserId: string; prompt: string; cwd?: string }): Promise<TaskRecord> {
    const cwd = opts.cwd && opts.cwd.trim().length > 0 ? opts.cwd.trim() : config.defaultCwd;
    const now = Date.now();

    const result = (await this.appServer.request("thread/start", threadParams(cwd))) as any;
    const threadId = result.thread.id;

    const task: TaskRecord = {
      id: `t_${now.toString(36)}_${randomUUID().slice(0, 6)}`,
      discordUserId: opts.discordUserId,
      prompt: opts.prompt,
      cwd,
      threadId,
      turnId: null,
      status: "running",
      createdAt: now,
      updatedAt: now,
    };
    this.store.saveTask(task);
    this.threadToTask.set(threadId, task.id);
    this.emit("taskStarted", task);

    const turnRes = (await this.appServer.request("turn/start", {
      threadId,
      input: [{ type: "text", text: opts.prompt }],
      approvalPolicy: config.approvalPolicy,
      sandboxPolicy: sandboxPolicy(cwd),
      ...(config.model ? { model: config.model } : {}),
    })) as any;
    this.store.patchTask(task.id, { turnId: turnRes.turn.id as string });

    return this.store.getTask(task.id)!;
  }

  async stopTask(taskId: string): Promise<TaskRecord | null> {
    const task = this.store.getTask(taskId);
    if (!task) return null;
    if (task.turnId) {
      try {
        await this.appServer.request("turn/interrupt", { threadId: task.threadId, turnId: task.turnId });
      } catch (err) {
        this.emit("warning", taskId, `Could not interrupt: ${(err as Error).message}`);
      }
    }
    for (const [reqKey, pending] of [...this.pending]) {
      if (pending.taskId === taskId) {
        this.finishApproval(reqKey, { decision: "cancel" }, "cancelled");
      }
    }
    return this.store.patchTask(taskId, { status: "interrupted" });
  }

  // ---- approvals ----

  private async handleApproval(id: number | string, params: any, kind: ApprovalKind): Promise<unknown> {
    const taskId = this.threadToTask.get(params.threadId);
    const task = taskId ? this.store.getTask(taskId) : null;
    if (!task || !taskId) {
      // Unknown thread (e.g. created outside the bot): decline safely.
      return kind === "permissions" ? { permissions: {}, scope: "turn" } : { decision: "cancel" };
    }

    this.store.patchTask(task.id, { status: "awaitingApproval" });

    const reqKey = String(id);
    return new Promise<unknown>((resolve) => {
      const pending: PendingApproval = {
        requestId: id,
        kind,
        method: `item/${kind}/requestApproval`,
        params,
        taskId,
        task: this.store.getTask(taskId)!,
        startedAt: Date.now(),
        resolve,
      };
      this.pending.set(reqKey, pending);
      this.emit("approval", pending);
    });
  }

  resolveApproval(taskId: string, requestId: number | string, result: unknown, label: string): boolean {
    const pending = this.pending.get(String(requestId));
    if (!pending || pending.taskId !== taskId) return false;
    this.finishApproval(String(requestId), result, label);
    return true;
  }

  private finishApproval(reqKey: string, result: unknown, label: string): void {
    const pending = this.pending.get(reqKey);
    if (!pending) return;
    this.pending.delete(reqKey);
    if (pending.timer) clearTimeout(pending.timer);
    pending.resultLabel = label;
    pending.resolve(result);
    this.emit("approvalResolved", { requestId: pending.requestId, taskId: pending.taskId, task: pending.task, label });

    if (this.pendingCountFor(pending.taskId) === 0) {
      const task = this.store.getTask(pending.taskId);
      if (task && task.status === "awaitingApproval") {
        this.store.patchTask(task.id, { status: "running" });
      }
    }
  }

  private pendingCountFor(taskId: string): number {
    let count = 0;
    for (const p of this.pending.values()) if (p.taskId === taskId) count++;
    return count;
  }

  // ---- notifications ----

  private onNotification(n: { method: string; params: any }): void {
    switch (n.method) {
      case "item/started":
      case "item/completed": {
        const item = n.params?.item as any;
        if (item && (item.type === "fileChange" || item.type === "commandExecution")) {
          this.itemSnapshots.set(item.id, item);
        }
        break;
      }
      case "serverRequest/resolved": {
        const taskId = n.params?.threadId ? this.threadToTask.get(n.params.threadId) : undefined;
        const reqId = n.params?.requestId;
        if (taskId && reqId !== undefined) {
          const pending = this.pending.get(String(reqId));
          if (pending) this.finishApproval(String(reqId), { decision: "cancel" }, "cleared");
          this.emit("approvalResolved", {
            requestId: reqId,
            taskId,
            task: this.store.getTask(taskId)!,
            label: pending?.resultLabel ?? "cleared",
          });
        }
        break;
      }
      case "turn/completed":
        this.onTurnCompleted(n.params);
        break;
      case "error":
        this.onError(n.params);
        break;
      case "warning": {
        const taskId = n.params?.threadId ? this.threadToTask.get(n.params.threadId) : null;
        this.emit("warning", taskId ?? null, n.params?.message ?? "unknown warning");
        break;
      }
      default:
        break;
    }
  }

  private onTurnCompleted(params: any): void {
    const threadId = params?.threadId;
    const taskId = threadId ? this.threadToTask.get(threadId) : undefined;
    if (!taskId) return;
    const turn = params.turn as any;
    const task = this.store.getTask(taskId)!;

    const status = (turn?.status ?? "completed") as TaskStatus;
    const finalStatus: TaskStatus = status === "interrupted" ? "interrupted" : status === "failed" ? "failed" : "completed";

    const agentItems: string[] = (turn?.items ?? []).filter((i: any) => i?.type === "agentMessage").map((i: any) => i.text ?? "");
    const finalText = agentItems.filter(Boolean).join("\n").trim() || undefined;

    const patch: Partial<TaskRecord> = { status: finalStatus };
    if (finalText) patch.finalText = finalText;
    if (turn?.error?.message) patch.error = turn.error.message;

    for (const [reqKey, p] of [...this.pending]) {
      if (p.taskId === taskId) {
        this.pending.delete(reqKey);
        if (p.timer) clearTimeout(p.timer);
        p.resolve({ decision: "cancel" });
      }
    }

    this.store.patchTask(taskId, patch);
    this.emit("taskDone", this.store.getTask(taskId)!);
  }

  private onError(params: any): void {
    const threadId = params?.threadId;
    const taskId = threadId ? this.threadToTask.get(threadId) : undefined;
    if (!taskId) return;
    const message = params?.error?.message ?? "codex reported an error";
    const task = this.store.getTask(taskId)!;
    this.store.patchTask(taskId, { status: "failed", error: message });
    this.emit("taskDone", this.store.getTask(taskId)!);
  }

  getPending(taskId: string): PendingApproval[] {
    return [...this.pending.values()].filter((p) => p.taskId === taskId);
  }

  getItemSnapshot(itemId: string): any | null {
    return this.itemSnapshots.get(itemId) ?? null;
  }
}