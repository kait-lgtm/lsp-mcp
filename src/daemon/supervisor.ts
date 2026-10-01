import { readFileSync } from "fs";
import { LspConnection } from "./lsp-conn.ts";
import { DaemonState, hashText } from "./state.ts";
import { getServerDef, languageIdForFile, loadConfig, type ServerDef } from "./registry.ts";
import { pathToUri } from "../shared/paths.ts";
import type { ServerCapabilities } from "../shared/lsp-types.ts";

export interface ServerEntry {
  serverId: string;
  conn: LspConnection;
  def: ServerDef;
  state: "starting" | "ready" | "crashed" | "stopped";
  capabilities: ServerCapabilities;
  startedAt: number;
  restartCount: number;
  restartBackoffMs: number;
  /** Original spawn parameters — reused verbatim on auto-restart (e.g. after a stall kill). */
  spawnArgs: {
    cmdOverride?: string[];
    settings?: unknown;
    initializationOptions?: unknown;
    env?: Record<string, string>;
  };
}

const WATCHDOG_INTERVAL_MS = 5000;
const DEFAULT_STALL_TIMEOUT_MS = 180000;

/**
 * Pure stall predicate. A server is stalled (and should be killed + restarted) when it has
 * sent us nothing for `stallMs` while we are expecting it to do work:
 *  - it is still initializing,
 *  - we have an unanswered request in flight,
 *  - it has open documents whose diagnostics were never delivered (push-model servers
 *    publish after didOpen; a healthy server does so quickly, a stuck one never).
 * A server that is idle (no docs, no pending requests, initialized) is never stalled —
 * silence is healthy then.
 */
export function isServerStalled(opts: {
  state: "starting" | "ready" | "crashed" | "stopped";
  idleMs: number;
  stallMs: number;
  pendingCount: number;
  hasOpenDocs: boolean;
  allDocsHaveDiagnostics: boolean;
}): boolean {
  if (opts.state === "stopped" || opts.state === "crashed") return false;
  if (opts.idleMs < opts.stallMs) return false;
  if (opts.state === "starting") return true;
  if (opts.pendingCount > 0) return true;
  if (!opts.hasOpenDocs) return false;
  return !opts.allDocsHaveDiagnostics;
}

export class Supervisor {
  private servers = new Map<string, ServerEntry>();
  private startedAt = Date.now();

  constructor(
    private readonly root: string,
    private readonly docState: DaemonState,
    private readonly log: (msg: string) => void,
  ) {}

  async startServer(
    serverId: string,
    cmdOverride?: string[],
    settings?: unknown,
    initializationOptionsOverride?: unknown,
    envOverride?: Record<string, string>,
  ): Promise<ServerEntry> {
    const existing = this.servers.get(serverId);
    if (existing && existing.state === "ready") return existing;

    const def = getServerDef(serverId);
    const cmd = cmdOverride ?? def.cmd;
    this.log(`[supervisor] starting ${serverId}: ${cmd.join(" ")}`);

    const conn = new LspConnection(serverId, this.root, cmd, this.log, { ...def.env, ...envOverride });

    // Wire diagnostics notifications
    conn.onNotification((method, params) => {
      if (method === "textDocument/publishDiagnostics") {
        const p = params as { uri: string; diagnostics: unknown[] };
        this.docState.setDiagnostics(p.uri, serverId, p.diagnostics as never);
      }
    });

    // Handle workspace/configuration requests from LSP
    conn.onRequest("workspace/configuration", (_, params) => {
      const items = (params as { items?: Array<{ section?: string }> }).items ?? [];
      return items.map(() => this.resolvedSettings(def.settings));
    });

    conn.onRequest("window/workDoneProgress/create", () => null);

    const entry: ServerEntry = {
      serverId,
      conn,
      def,
      state: "starting",
      capabilities: {},
      startedAt: Date.now(),
      restartCount: 0,
      restartBackoffMs: 1000,
      spawnArgs: { cmdOverride, settings, initializationOptions: initializationOptionsOverride, env: envOverride },
    };
    this.servers.set(serverId, entry);
    this.startStallWatchdog(entry);

    try {
      const initResult = await conn.initialize(
        this.resolvedSettings(settings ?? def.settings),
        initializationOptionsOverride ?? def.initializationOptions,
      );
      entry.capabilities = initResult.capabilities;
      entry.state = "ready";
      this.log(`[supervisor] ${serverId} ready, caps: ${JSON.stringify(Object.keys(initResult.capabilities))}`);

      // Re-open any already-open docs on this new server
      for (const doc of this.docState.allDocs()) {
        if (def.languageIds.includes(doc.languageId)) {
          conn.notify("textDocument/didOpen", {
            textDocument: { uri: doc.uri, languageId: doc.languageId, version: doc.version, text: doc.text },
          });
          doc.openOnServers.add(serverId);
        }
      }

      // Monitor for crashes and auto-restart
      this.watchForCrash(entry);
    } catch (e) {
      entry.state = "crashed";
      this.log(`[supervisor] ${serverId} failed to initialize: ${e}`);
      // Kill the process even if initialize failed/timed out — otherwise a server that
      // never answered initialize lingers forever as a memory-holding zombie.
      conn.kill("SIGKILL");
      throw e;
    }

    return entry;
  }

  /**
   * Periodically checks the server for stalls (no incoming messages while work is
   * expected). A stalled server is SIGKILLed; watchForCrash then auto-restarts it.
   * Healthy idle servers are never touched.
   */
  private startStallWatchdog(entry: ServerEntry): void {
    const interval = setInterval(() => {
      if (entry.state === "stopped" || entry.conn.dead) {
        clearInterval(interval);
        return;
      }
      const stallMs = entry.def.stallTimeoutMs ?? loadConfig().stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
      const conn = entry.conn;
      const docs = this.docState.allDocs().filter((d) => d.openOnServers.has(entry.serverId));
      const stalled = isServerStalled({
        state: entry.state,
        idleMs: Date.now() - conn.lastIncomingAt,
        stallMs,
        pendingCount: conn.pendingCount,
        hasOpenDocs: docs.length > 0,
        allDocsHaveDiagnostics: docs.every((d) =>
          this.docState.getDiagnostics(d.uri).some((x) => x.serverId === entry.serverId)
        ),
      });
      if (stalled) {
        this.log(`[supervisor] ${entry.serverId} STALLED (silent for ${Math.round((Date.now() - conn.lastIncomingAt) / 1000)}s, ` +
          `state=${entry.state}, pending=${conn.pendingCount}, openDocs=${docs.length}) — killing, will auto-restart`);
        conn.kill("SIGKILL");
        clearInterval(interval);
      }
    }, WATCHDOG_INTERVAL_MS);
    (interval as unknown as { unref?: () => void }).unref?.();
  }

  private async watchForCrash(entry: ServerEntry): Promise<void> {
    // Poll conn.dead
    while (!entry.conn.dead && entry.state !== "stopped") {
      await Bun.sleep(500);
    }
    if (entry.state === "stopped") return;

    entry.state = "crashed";
    this.log(`[supervisor] ${entry.serverId} crashed, restart in ${entry.restartBackoffMs}ms`);
    await Bun.sleep(entry.restartBackoffMs);
    entry.restartBackoffMs = Math.min(entry.restartBackoffMs * 2, 30000);
    entry.restartCount++;

    try {
      await this.startServer(
        entry.serverId,
        entry.spawnArgs.cmdOverride,
        entry.spawnArgs.settings,
        entry.spawnArgs.initializationOptions,
        entry.spawnArgs.env,
      );
    } catch (e) {
      this.log(`[supervisor] ${entry.serverId} restart failed: ${e}`);
    }
  }

  /** Fills in per-instance placeholders (e.g. workspaceFolder.uri) left empty in the server def. */
  private resolvedSettings(settings: unknown): unknown {
    if (!settings || typeof settings !== "object") return settings ?? {};
    const clone = JSON.parse(JSON.stringify(settings)) as { workspaceFolder?: { uri?: string } };
    if (clone.workspaceFolder && !clone.workspaceFolder.uri) {
      clone.workspaceFolder.uri = pathToUri(this.root);
    }
    return clone;
  }

  async ensureOpen(path: string): Promise<void> {
    const langId = languageIdForFile(path);
    const uri = pathToUri(path);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      throw new Error(`Cannot read file: ${path} (${err.code ?? "unknown"}: ${err.message})`);
    }

    // If the doc is already tracked and disk content has drifted from what we last
    // synced, push a didChange now so subsequent LSP requests see fresh content.
    const existing = this.docState.getDocByPath(path);
    if (existing && hashText(text) !== existing.syncedHash) {
      await this.syncDocToDisk(path, text);
      this.docState.clearExternalChanges(uri);
    }

    for (const entry of this.servers.values()) {
      if (entry.state !== "ready") continue;
      if (!entry.def.languageIds.includes(langId)) continue;
      const doc = this.docState.getDocByPath(path);
      if (!doc || !doc.openOnServers.has(entry.serverId)) {
        const d = this.docState.openDoc(path, text, entry.serverId);
        entry.conn.notify("textDocument/didOpen", {
          textDocument: { uri, languageId: d.languageId, version: d.version, text: d.text },
        });
      }
    }
    // Ensure doc is in state even if no servers match yet
    if (!this.docState.getDocByPath(path)) {
      this.docState.openDoc(path, text, "__none__");
    }
  }

  async syncDocToDisk(path: string, text: string): Promise<number> {
    const doc = this.docState.getDocByPath(path);
    if (!doc) return 1;
    const updated = this.docState.updateDoc(path, text);
    for (const serverId of updated.openOnServers) {
      const entry = this.servers.get(serverId);
      if (entry?.state === "ready") {
        entry.conn.notify("textDocument/didChange", {
          textDocument: { uri: updated.uri, version: updated.version },
          contentChanges: [{ text }],
        });
      }
    }
    return updated.version;
  }

  async syncFileFromDisk(path: string): Promise<number> {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      throw new Error(`Cannot read file: ${path} (${err.code ?? "unknown"}: ${err.message})`);
    }
    return this.syncDocToDisk(path, text);
  }

  getEntry(serverId: string): ServerEntry | undefined {
    return this.servers.get(serverId);
  }

  allEntries(): ServerEntry[] {
    return [...this.servers.values()];
  }

  stopServer(serverId: string): void {
    const entry = this.servers.get(serverId);
    if (!entry) return;
    entry.state = "stopped";
    entry.conn.kill();
    this.servers.delete(serverId);
  }

  stopAll(): void {
    for (const entry of this.servers.values()) {
      entry.state = "stopped";
      entry.conn.kill();
    }
    this.servers.clear();
  }

  uptime(): number {
    return Date.now() - this.startedAt;
  }
}
