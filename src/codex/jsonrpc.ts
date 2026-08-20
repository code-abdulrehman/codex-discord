export interface RpcNotification {
  method: string;
  params: unknown;
}

export interface RpcServerRequest {
  method: string;
  id: number | string;
  params: unknown;
}

type NotificationHandler = (params: unknown) => void;
type ServerRequestHandler = (id: number | string, params: unknown) => Promise<unknown>;

/**
 * Minimal JSON-RPC 2.0 client over newline-delimited JSON (JSONL).
 *
 * The Codex app-server protocol uses JSON-RPC 2.0 messages with the
 * `jsonrpc` header omitted on the wire. Requests carry `method`, `params`
 * and `id`; responses echo `id` with `result` or `error`; notifications
 * carry only `method` + `params`. Server->client requests are dispatched to
 * registered handlers and answered with the value the handler resolves to.
 */
export class JsonRpcClient {
  private nextId = 0;
  private pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private notificationHandlers = new Map<string, NotificationHandler>();
  private serverRequestHandlers = new Map<string, ServerRequestHandler>();
  private allNotificationHandlers: Array<(params: unknown, method: string) => void> = [];
  private buffer = "";
  private closed = false;

  constructor(
    private input: NodeJS.ReadableStream,
    private output: NodeJS.WritableStream,
  ) {
    input.on("data", (chunk: Buffer) => this.onData(chunk));
    input.on("end", () => {
      this.closed = true;
      for (const [, p] of this.pending) p.reject(new Error("app-server connection closed"));
      this.pending.clear();
    });
    input.on("error", (err: Error) => {
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
    });
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  /** Subscribe to every notification (in addition to any per-method handler). */
  onAllNotifications(handler: (params: unknown, method: string) => void): void {
    this.allNotificationHandlers.push(handler);
  }

  onServerRequest(method: string, handler: ServerRequestHandler): void {
    this.serverRequestHandlers.set(method, handler);
  }

  sendMessage(msg: unknown): void {
    if (this.closed) throw new Error("app-server connection is closed");
    this.output.write(`${JSON.stringify(msg)}\n`);
  }

  request(method: string, params: unknown = {}): Promise<unknown> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.sendMessage({ method, id, params });
      } catch (err) {
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  notify(method: string, params: unknown = {}): void {
    this.sendMessage({ method, params });
  }

  respond(id: number | string, result: unknown): void {
    this.sendMessage({ id, result });
  }

  respondError(id: number | string, error: { code: number; message: string }): void {
    this.sendMessage({ id, error });
  }

  close(): void {
    this.closed = true;
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length === 0) continue;
      try {
        this.onMessage(JSON.parse(line));
      } catch (err) {
        console.error("[jsonrpc] failed to parse line:", line, err);
      }
    }
  }

  private async onMessage(msg: any): Promise<void> {
    if (msg === null || typeof msg !== "object") return;

    if (typeof msg.method === "string") {
      if (msg.id !== undefined && !("result" in msg) && !("error" in msg)) {
        await this.onServerRequestMessage(msg);
      } else {
        this.onNotificationMessage(msg);
      }
      return;
    }

    if (msg.id !== undefined) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(`${msg.error.message ?? "RPC error"}${msg.error.code ? ` (code ${msg.error.code})` : ""}`));
        } else {
          pending.resolve(msg.result);
        }
      }
    }
  }

  private async onServerRequestMessage(msg: any): Promise<void> {
    const handler = this.serverRequestHandlers.get(msg.method);
    if (!handler) {
      this.respondError(msg.id, { code: -32601, message: `method not supported: ${msg.method}` });
      return;
    }
    try {
      const result = await handler(msg.id, msg.params);
      this.respond(msg.id, result);
    } catch (err: any) {
      this.respondError(msg.id, { code: -32000, message: err?.message ?? String(err) });
    }
  }

  private onNotificationMessage(msg: any): void {
    const handler = this.notificationHandlers.get(msg.method);
    if (handler) handler(msg.params);
    for (const all of this.allNotificationHandlers) all(msg.params, msg.method);
  }
}