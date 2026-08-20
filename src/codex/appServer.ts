import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { JsonRpcClient, type RpcNotification, type RpcServerRequest } from "./jsonrpc.js";

export interface AppServerOptions {
  codexBin: string;
  codexHome: string;
  cwd: string;
  model: string | null;
}

export interface AppServerEvents {
  notification: (n: RpcNotification) => void;
  serverRequest: (r: RpcServerRequest) => void;
  exited: (code: number | null) => void;
}

export declare interface AppServer {
  on<K extends keyof AppServerEvents>(event: K, listener: AppServerEvents[K]): this;
  once<K extends keyof AppServerEvents>(event: K, listener: AppServerEvents[K]): this;
  emit<K extends keyof AppServerEvents>(event: K, ...args: Parameters<AppServerEvents[K]>): boolean;
}

/**
 * Owns a `codex app-server` process (stdio transport) and the JSON-RPC client
 * that talks to it. The app-server is the Codex-side engine: it holds real
 * Codex sessions, streams turn/item notifications, and routes approval
 * requests to connected clients.
 */
export class AppServer extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  client: JsonRpcClient | null = null;
  ready = false;

  constructor(private opts: AppServerOptions) {
    super();
  }

  get pid(): number | null {
    return this.proc?.pid ?? null;
  }

  async start(): Promise<void> {
    const proc = spawn(this.opts.codexBin, ["app-server", "--listen", "stdio://"], {
      cwd: this.opts.cwd,
      env: { ...process.env, CODEX_HOME: this.opts.codexHome },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc = proc;
    const client = new JsonRpcClient(proc.stdout, proc.stdin);
    this.client = client;

    client.onAllNotifications((params, method) => this.emit("notification", { method, params }));

    proc.stderr.on("data", (chunk: Buffer) => {
      console.error("[app-server] stderr:", chunk.toString("utf8").trimEnd());
    });
    proc.on("exit", (code) => {
      this.ready = false;
      client.close();
      this.emit("exited", code);
    });
    proc.on("error", (err) => {
      console.error("[app-server] failed to spawn:", err.message);
      this.emit("exited", null);
    });

    await this.initialize(client);
    this.ready = true;
  }

  private async initialize(client: JsonRpcClient): Promise<void> {
    const result = (await client.request("initialize", {
      clientInfo: {
        name: "codex_discord",
        title: "Codex Discord",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: [
          "item/reasoning/summaryTextDelta",
          "item/reasoning/textDelta",
          "item/reasoning/summaryPartAdded",
          "thread/tokenUsage/updated",
          "account/rateLimits/updated",
          "mcpServer/startupStatus/updated",
          "remoteControl/status/changed",
        ],
      },
    })) as { platformFamily: string; platformOs: string; codexHome: string };
    client.notify("initialized", {});
    console.log(
      `[app-server] connected (${result.platformOs}/${result.platformFamily}, codex home ${result.codexHome}, pid ${this.proc?.pid})`,
    );
  }

  request(method: string, params: unknown = {}): Promise<unknown> {
    if (!this.client || !this.ready) throw new Error("app-server not ready");
    return this.client.request(method, params);
  }

  notify(method: string, params: unknown = {}): void {
    if (!this.client || !this.ready) throw new Error("app-server not ready");
    this.client.notify(method, params);
  }

  respond(id: number | string, result: unknown): void {
    if (!this.client || !this.ready) throw new Error("app-server not ready");
    this.client.respond(id, result);
  }

  /** Subscribe to a per-method server->client request and answer it. */
  onServerRequest(method: string, handler: (id: number | string, params: unknown) => Promise<unknown>): void {
    if (!this.client) throw new Error("app-server not started");
    this.client.onServerRequest(method, handler);
  }

  /** Subscribe to a per-method notification. */
  onNotification(method: string, handler: (params: unknown) => void): void {
    if (!this.client) throw new Error("app-server not started");
    this.client.onNotification(method, handler);
  }

  stop(): void {
    this.proc?.kill("SIGTERM");
  }
}