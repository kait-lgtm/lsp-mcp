import { existsSync, readFileSync, openSync } from "fs";
import { mkdirSync } from "fs";
import { socketPath, pidPath, socketDir, logDir } from "../shared/paths.ts";
import { NdJsonDecoder, encodeNdJson, makeRequest, isResponse, type JsonRpcResponse } from "../shared/jsonrpc.ts";
import { PendingRequests } from "../shared/jsonrpc.ts";
import { resolveRoot } from "../daemon/registry.ts";

const DAEMON_BIN = new URL("../../bin/lsp-mcp-daemon.ts", import.meta.url).pathname;
const SPAWN_TIMEOUT_MS = 10000;

/**
 * Bun's Socket.write() caps out at 8192 bytes per call and silently drops the rest
 * (a 60KB response left clients waiting for the trailing newline forever). Loop over
 * the remainder, flushing and yielding between chunks so backpressure resolves.
 */
async function writeAll(socket: import("bun").Socket, data: Uint8Array): Promise<void> {
  let remaining = data;
  while (remaining.length > 0) {
    const n = socket.write(remaining);
    if (n > 0) remaining = remaining.slice(n);
    if (remaining.length === 0) break;
    socket.flush();
    await Bun.sleep(1);
  }
  socket.flush();
}

export class DaemonClient {
  private socket: import("bun").Socket | null = null;
  private decoder = new NdJsonDecoder();
  private pending = new PendingRequests();
  private root: string;

  constructor(projectPath: string, serverId?: string) {
    this.root = resolveRoot(projectPath, serverId);
  }

  private sockPath(): string {
    return socketPath(this.root);
  }

  private async connect(): Promise<void> {
    if (this.socket) return;
    const sock = this.sockPath();

    const self = this;
    this.socket = await Bun.connect({
      unix: sock,
      socket: {
        data(_sock: import("bun").Socket, data: Buffer) {
          const msgs = self.decoder.push(data);
          for (const msg of msgs) {
            if (isResponse(msg)) self.pending.settle(msg as JsonRpcResponse);
          }
        },
        close() {
          self.socket = null;
          self.pending.rejectAll("Daemon connection closed");
        },
        error(_sock: import("bun").Socket, err: Error) {
          self.pending.rejectAll(`Daemon socket error: ${err}`);
        },
      },
    });
  }

  private isDaemonAlive(): boolean {
    const pidFile = pidPath(this.root);
    if (!existsSync(pidFile)) return false;
    try {
      const pid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private async spawnDaemon(): Promise<void> {
    mkdirSync(socketDir(), { recursive: true });
    mkdirSync(logDir(), { recursive: true });
    const bootLog = `${logDir()}/${this.root.replace(/\//g, "_").slice(1)}.log`;
    const fd = openSync(bootLog, "a");
    // Raise FD limit before exec — macOS launchd-spawned procs default to 256,
    // and tsgo + chokidar blow through that on real monorepos (EMFILE).
    // 10240 is the macOS hard cap without sudo. Use `sh -c` so ulimit affects bun.
    const bunBin = Bun.which("bun") ?? "bun";
    // Try raising hard limit first (needs to be available from launchd inheritance),
    // then soft. If hard is already at 256 we can't go higher without sudo launchctl.
    const cmdline = `ulimit -Hn 524288 2>/dev/null; ulimit -n 10240 2>/dev/null; exec '${bunBin}' run '${DAEMON_BIN}' '${this.root}'`;
    const proc = Bun.spawn(["/bin/sh", "-c", cmdline], {
      stdin: "ignore",
      stdout: fd,
      stderr: fd,
    });
    proc.unref();

    const deadline = Date.now() + SPAWN_TIMEOUT_MS;
    while (!existsSync(this.sockPath())) {
      if (Date.now() > deadline) {
        throw new Error(`Daemon did not start within ${SPAWN_TIMEOUT_MS}ms. See log: ${bootLog}`);
      }
      await Bun.sleep(100);
    }
    await Bun.sleep(50);
  }

  async ensureConnected(): Promise<void> {
    if (!existsSync(this.sockPath()) || !this.isDaemonAlive()) {
      await this.spawnDaemon();
    }
    await this.connect();
  }

  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    await this.ensureConnected();
    const id = this.pending.nextRequestId();
    const promise = this.pending.register(id) as Promise<T>;
    const encoded = encodeNdJson(makeRequest(id, method, params));
    await writeAll(this.socket!, encoded);
    return promise;
  }

  disconnect(): void {
    try { this.socket?.end(); } catch {}
    this.socket = null;
  }
}
