import {
  ContentLengthDecoder,
  encodeContentLength,
  PendingRequests,
  makeRequest,
  makeNotification,
  isResponse,
  isNotification,
  isRequest,
  type JsonRpcMessage,
} from "../shared/jsonrpc.ts";
import type { InitializeResult, ServerCapabilities } from "../shared/lsp-types.ts";
import { pathToUri } from "../shared/paths.ts";

export type NotificationHandler = (method: string, params: unknown) => void;
export type RequestHandler = (method: string, params: unknown) => unknown | Promise<unknown>;

export class LspConnection {
  private proc: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>;
  private decoder = new ContentLengthDecoder();
  private pending = new PendingRequests();
  private notifHandlers: NotificationHandler[] = [];
  private requestHandlers: Map<string, RequestHandler> = new Map();
  private _capabilities: ServerCapabilities = {};
  private _ready = false;
  private _dead = false;
  private _lastIncomingAt = Date.now();

  constructor(
    private readonly serverId: string,
    private readonly root: string,
    cmd: string[],
    private readonly log: (msg: string) => void,
    env?: Record<string, string>,
  ) {
    const resolved = Bun.which(cmd[0]) ?? cmd[0];
    const mergedEnv = { ...process.env, ...(env ?? {}) } as Record<string, string>;
    this.log(`[${serverId}] spawn: cmd=${JSON.stringify(cmd)} resolved=${resolved} cwd=${root} extraEnv=${JSON.stringify(env ?? {})}`);
    try {
      this.proc = Bun.spawn([resolved, ...cmd.slice(1)], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        cwd: root,
        env: mergedEnv,
        onExit: (_p, code, signal, err) => {
          this._dead = true;
          this.log(`[${serverId}] process exited code=${code} signal=${signal} err=${err ?? ""}`);
          this.pending.rejectAll(`LSP ${serverId} exited (code=${code}, signal=${signal})`);
        },
      });
    } catch (e) {
      this._dead = true;
      this.log(`[${serverId}] spawn threw: ${e}`);
      throw new Error(`Failed to spawn ${cmd[0]}: ${e}. Is it on PATH? (PATH=${process.env.PATH})`);
    }
    this.log(`[${serverId}] spawned pid=${this.proc.pid}`);
    this.readLoop();
    this.readStderr();
  }

  get capabilities(): ServerCapabilities {
    return this._capabilities;
  }

  get ready(): boolean {
    return this._ready;
  }

  get dead(): boolean {
    return this._dead;
  }

  get pid(): number {
    return this.proc.pid;
  }

  /** Timestamp of the last message received from the server (any JSON-RPC message). */
  get lastIncomingAt(): number {
    return this._lastIncomingAt;
  }

  /** Number of requests we've sent that are still awaiting a response. */
  get pendingCount(): number {
    return this.pending.size;
  }

  onNotification(handler: NotificationHandler): void {
    this.notifHandlers.push(handler);
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  private async readLoop(): Promise<void> {
    try {
      const stdout = this.proc.stdout as ReadableStream<Uint8Array>;
      for await (const chunk of stdout) {
        const msgs = this.decoder.push(chunk);
        for (const msg of msgs) {
          this.dispatchMsg(msg);
        }
      }
    } catch (e) {
      this.log(`[${this.serverId}] stdout error: ${e}`);
    } finally {
      this._dead = true;
      this.pending.rejectAll(`LSP ${this.serverId} process exited`);
    }
  }

  private async readStderr(): Promise<void> {
    try {
      const stderr = this.proc.stderr as ReadableStream<Uint8Array>;
      for await (const chunk of stderr) {
        this.log(`[${this.serverId}] stderr: ${new TextDecoder().decode(chunk).trimEnd()}`);
      }
    } catch {
      // ignore
    }
  }

  private dispatchMsg(msg: JsonRpcMessage): void {
    this._lastIncomingAt = Date.now();
    if (process.env.LSP_MCP_DEBUG) {
      const s = JSON.stringify(msg);
      this.log(`[${this.serverId}] <<- ${s.length > 500 ? s.slice(0, 500) + "...(truncated)" : s}`);
    }
    if (isResponse(msg)) {
      this.pending.settle(msg);
      return;
    }
    if (isNotification(msg)) {
      for (const h of this.notifHandlers) {
        h(msg.method, msg.params);
      }
      return;
    }
    if (isRequest(msg)) {
      const reqMsg = msg as { jsonrpc: "2.0"; id: string | number; method: string; params?: unknown };
      const handler = this.requestHandlers.get(reqMsg.method);
      if (handler) {
        Promise.resolve(handler(reqMsg.method, reqMsg.params)).then((result) => {
          this.send({ jsonrpc: "2.0", id: reqMsg.id, result });
        }).catch(() => {
          this.send({ jsonrpc: "2.0", id: reqMsg.id, error: { code: -32603, message: "Internal error" } });
        });
      } else {
        this.send({ jsonrpc: "2.0", id: reqMsg.id, error: { code: -32601, message: "Method not found" } });
      }
    }
  }

  private send(msg: unknown): void {
    if (this._dead) return;
    if (process.env.LSP_MCP_DEBUG) {
      const s = JSON.stringify(msg);
      this.log(`[${this.serverId}] ->> ${s.length > 500 ? s.slice(0, 500) + "...(truncated)" : s}`);
    }
    try {
      (this.proc.stdin as import("bun").FileSink).write(encodeContentLength(msg));
    } catch (e) {
      this.log(`[${this.serverId}] send error: ${e}`);
    }
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.pending.nextRequestId();
    const promise = this.pending.register(id);
    this.send(makeRequest(id, method, params));
    return promise as Promise<T>;
  }

  notify(method: string, params?: unknown): void {
    this.send(makeNotification(method, params));
  }

  async initialize(settings?: unknown, initializationOptions?: unknown): Promise<InitializeResult> {
    this.log(`[${this.serverId}] sending initialize${initializationOptions ? " with initializationOptions" : ""}`);
    const initPromise = this.request<InitializeResult>("initialize", {
      processId: process.pid,
      rootUri: pathToUri(this.root),
      rootPath: this.root,
      initializationOptions,
      capabilities: {
        textDocument: {
          synchronization: { dynamicRegistration: false, willSave: false, didSave: false, willSaveWaitUntil: false },
          publishDiagnostics: { relatedInformation: true, versionSupport: true },
          definition: { dynamicRegistration: false, linkSupport: false },
          references: { dynamicRegistration: false },
          hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
          rename: { dynamicRegistration: false, prepareSupport: true },
          documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
          formatting: { dynamicRegistration: false },
          codeAction: { dynamicRegistration: false },
        },
        workspace: {
          applyEdit: false,
          workspaceFolders: true,
          symbol: { dynamicRegistration: false },
          configuration: true,
        },
      },
      workspaceFolders: [{ uri: pathToUri(this.root), name: this.root.split("/").pop() ?? "root" }],
    });
    const timeout = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error(`initialize timeout after 30s (server didn't respond — check log for stderr)`)), 30000)
    );
    const result = await Promise.race([initPromise, timeout]);
    this.log(`[${this.serverId}] initialize result received`);
    this._capabilities = result.capabilities;
    this.notify("initialized", {});
    if (settings) {
      this.notify("workspace/didChangeConfiguration", { settings });
    }
    this._ready = true;
    return result;
  }

  kill(signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): void {
    try {
      this.proc.kill(signal);
    } catch {
      // already dead
    }
    this._dead = true;
  }

  async waitReady(timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (!this._ready && !this._dead) {
      if (Date.now() - start > timeoutMs) throw new Error(`LSP ${this.serverId} did not become ready`);
      await Bun.sleep(50);
    }
    if (this._dead) throw new Error(`LSP ${this.serverId} died before becoming ready`);
  }
}
