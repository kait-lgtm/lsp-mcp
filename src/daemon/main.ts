import { mkdirSync, writeFileSync, unlinkSync, existsSync, appendFileSync } from "fs";
import { socketPath, pidPath, socketDir, logDir, uriToPath } from "../shared/paths.ts";
import { NdJsonDecoder, encodeNdJson, makeResult, makeError, isRequest } from "../shared/jsonrpc.ts";
import { Methods } from "../shared/protocol.ts";
import { DaemonState } from "./state.ts";
import { Supervisor } from "./supervisor.ts";
import { applyWorkspaceEdit } from "./edits.ts";
import { resolveProjectRoot, loadConfig, getServerDef, languageIdForFile, type ProjectConfig, type FormatterDef, PROJECT_CONFIG_FILE } from "./registry.ts";
import { normalizePosition } from "../shared/positions.ts";
import { pathToUri } from "../shared/paths.ts";
import { readFileSync } from "fs";
import { atomicWrite } from "./edits.ts";
import { hashText } from "./state.ts";
import type {
  StartParams, StopParams, DiagnosticsParams, PositionParams, ReferencesParams,
  WorkspaceSymbolsParams, CodeActionsParams, AutoFixParams, RenameParams, FormatParams, SyncFileParams,
  FileParams, PullChangesParams, ExternalChangeEvent,
} from "../shared/protocol.ts";

const ROOT = process.argv[2];
if (!ROOT) {
  console.error("Usage: lsp-mcp-daemon <project-root>");
  process.exit(1);
}

const SOCK = socketPath(ROOT);
const PID_FILE = pidPath(ROOT);

const logFile = `${logDir()}/${ROOT.replace(/\//g, "_").slice(1)}.log`;
try { mkdirSync(logDir(), { recursive: true }); } catch {}

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try { appendFileSync(logFile, line + "\n"); } catch {}
}

mkdirSync(socketDir(), { recursive: true });
writeFileSync(PID_FILE, String(process.pid), "utf8");

const docState = new DaemonState();
const supervisor = new Supervisor(ROOT, docState, log);

let projectConfig: ProjectConfig | null = null;
try {
  const cfgFile = `${ROOT}/${PROJECT_CONFIG_FILE}`;
  if (existsSync(cfgFile)) projectConfig = JSON.parse(readFileSync(cfgFile, "utf8")) as ProjectConfig;
} catch (e) {
  log(`[config] failed to read ${PROJECT_CONFIG_FILE}: ${e}`);
}
if (projectConfig?.servers?.length) log(`[config] auto-start servers: ${projectConfig.servers.join(", ")}`);

/** Auto-starts every configured server whose languageIds match this file. Idempotent. */
async function ensureConfiguredServers(absFile: string): Promise<void> {
  if (!projectConfig?.servers?.length) return;
  const langId = languageIdForFile(absFile);
  await Promise.all(projectConfig.servers.map(async (serverId) => {
    let def;
    try {
      def = getServerDef(serverId);
    } catch (e) {
      log(`[auto-start] unknown server "${serverId}" in ${PROJECT_CONFIG_FILE}: ${e}`);
      return;
    }
    if (!def.languageIds.includes(langId)) return;
    const entry = supervisor.getEntry(serverId);
    if (entry && entry.state !== "crashed" && entry.state !== "stopped") return;
    try {
      await supervisor.startServer(serverId, undefined, undefined, undefined, projectConfig?.serverEnv?.[serverId]);
    } catch (e) {
      log(`[auto-start] ${serverId} failed to start: ${e}`);
    }
  }));
}

/** Runs a configured formatter over a file (stdin/stdout or {file}-in-place). Returns true if it changed the file. */
async function runFormatter(fmt: FormatterDef, absFile: string): Promise<boolean> {
  const inplace = fmt.mode === "inplace";
  const cmd = fmt.cmd.map((c) => c.replaceAll("{file}", absFile));
  const before = readFileSync(absFile, "utf8");

  const proc = Bun.spawn(cmd, {
    stdin: inplace ? "ignore" : new Response(before).body,
    stdout: "pipe",
    stderr: "pipe",
    cwd: ROOT,
  });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    log(`[formatter] ${cmd.join(" ")} exited ${code}: ${err.slice(0, 300)}`);
    return false;
  }

  const after = inplace ? readFileSync(absFile, "utf8") : out;
  if (after === before) return false;
  if (!inplace) {
    docState.setExpectedDiskHash(absFile, hashText(after));
    atomicWrite(absFile, after);
  }
  await supervisor.syncDocToDisk(absFile, after);
  return true;
}
// External-change watcher disabled (chokidar v5 burns FDs, fsevents path needs rework).
// Re-enable later via @parcel/watcher or chokidar v3. For now lsp_pull_changes returns empty.

// --- Helpers ---

function absPath(projectPath: string, file: string): string {
  return file.startsWith("/") ? file : `${projectPath}/${file}`;
}

const STALE_HINT = "Call lsp_pull_changes to acknowledge external changes before operating on this file.";

function staleFlags(uri: string): { stale: true; hint: string } | Record<string, never> {
  return docState.hasPendingChanges(uri) ? { stale: true, hint: STALE_HINT } : {};
}

/** Normalizes the `file` param (single path or array) into a list of paths. */
function toFiles(file: string | string[] | undefined): string[] {
  if (!file) return [];
  return Array.isArray(file) ? file : [file];
}

function blockedResult(ap: string, changes: ExternalChangeEvent[]) {
  return {
    error: "external_changes_pending" as const,
    file: ap,
    changes,
    hint: "Call lsp_pull_changes to acknowledge, or pass force:true to overwrite.",
  };
}

/** Diagnostics for one open file, tagged with serverId/file/source line. */
function buildFileDiagnostics(uri: string): unknown[] {
  const lines = (docState.getDoc(uri)?.text ?? "").split("\n");
  return docState.getDiagnostics(uri).flatMap((d) =>
    d.diagnostics.map((diag) => {
      const lineIdx = diag.range.start.line;
      return {
        ...diag,
        serverId: d.serverId,
        file: uriToPath(d.uri),
        sourceLine: lines[lineIdx],
        lineNumber: lineIdx + 1,
      };
    })
  );
}

/**
 * Opens a file and collects diagnostics from every ready server.
 * For each server, decides pull vs push based on advertised capabilities. Every wait is
 * bounded by `timeoutMs`. A server that advertises pull support but never answers
 * (vscode-eslint-language-server hangs on textDocument/diagnostic nondeterministically)
 * must not block the call forever.
 */
async function collectFileDiagnostics(ap: string, timeoutMs: number): Promise<{ diagnostics: unknown[]; pending: string[]; stale: boolean }> {
  await supervisor.ensureOpen(ap);
  const uri = pathToUri(ap);
  const entries = supervisor.allEntries().filter((e) => e.state === "ready");
  const pending: string[] = [];

  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(0, deadline - Date.now());
  await Promise.all(entries.map(async (e) => {
    const caps = e.capabilities as { diagnosticProvider?: unknown };
    if (caps.diagnosticProvider) {
      // Pull model (LSP 3.17+) — actively request diagnostics for this file.
      try {
        const pullTimeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`textDocument/diagnostic timed out after ${timeoutMs}ms`)), remaining())
        );
        const report = await Promise.race([
          e.conn.request<{ kind: string; items?: unknown[] }>(
            "textDocument/diagnostic",
            { textDocument: { uri } },
          ),
          pullTimeout,
        ]);
        if (report.kind === "full" && Array.isArray(report.items)) {
          docState.setDiagnostics(uri, e.serverId, report.items as never);
        }
        // kind === "unchanged" → keep whatever's cached
      } catch (err) {
        // Some servers advertise pull support but their implementation is broken (e.g.
        // some vscode-eslint-language-server builds throw on textDocument/diagnostic),
        // or they hang and we timed out. Fall back to push: wait for a
        // publishDiagnostics notification instead.
        log(`[diagnostics] pull failed for ${e.serverId} on ${uri}, falling back to push: ${err}`);
        const hasDiag = docState.getDiagnostics(uri).some((d) => d.serverId === e.serverId);
        if (!hasDiag) {
          pending.push(e.serverId);
          await docState.waitForDiagnostics(uri, e.serverId, remaining());
        }
      }
    } else {
      // Push model — wait for publishDiagnostics notification
      const hasDiag = docState.getDiagnostics(uri).some((d) => d.serverId === e.serverId);
      if (!hasDiag) {
        pending.push(e.serverId);
        await docState.waitForDiagnostics(uri, e.serverId, remaining());
      }
    }
  }));

  const stillPending = pending.filter((sid) => !docState.getDiagnostics(uri).some((d) => d.serverId === sid));
  return {
    diagnostics: buildFileDiagnostics(uri),
    pending: stillPending,
    stale: docState.hasPendingChanges(uri),
  };
}

/** Returns an ExternalChangesBlockedResult if the file has pending external changes and force !== true */
function checkMutationGuard(path: string, force: boolean | undefined): ExternalChangeEvent[] | null {
  const uri = pathToUri(path);
  if (!docState.hasPendingChanges(uri)) return null;
  if (force) {
    // Forced — discard queue and log discarded diffs
    const changes = docState.getExternalChanges(uri);
    for (const { changes: evts } of changes) {
      for (const ev of evts) {
        log(`[guard] force-overwriting external change in ${path}: ${ev.diff.slice(0, 200)}`);
      }
    }
    docState.clearExternalChanges(uri);
    return null;
  }
  // Return the pending changes so caller can build the blocked result
  const pending = docState.getExternalChanges(uri);
  return pending.flatMap(({ path: p, changes }) =>
    changes.map((c): ExternalChangeEvent => ({
      file: p,
      kind: c.kind,
      timestamp: c.timestamp,
      diff: c.diff,
      truncated: c.truncated,
    }))
  );
}

type FileFixResult = {
  appliedActions: string[];
  changedFiles: { path: string; edits: number }[];
  totalEdits: number;
};

/** Auto-fix + format a single file. Returns a blocked result if external changes are pending. */
async function autoFixOne(ap: string, force: boolean | undefined): Promise<FileFixResult | ReturnType<typeof blockedResult>> {
  await supervisor.ensureOpen(ap);
  const uri = pathToUri(ap);

  const guard = checkMutationGuard(ap, force);
  if (guard) return blockedResult(ap, guard);

  const entries = supervisor.allEntries().filter((e) => e.state === "ready");
  const matchingFormatters = (projectConfig?.formatters ?? []).filter((f) => f.languageIds.includes(languageIdForFile(ap)));
  if (!entries.length && !matchingFormatters.length) throw new Error("No LSP servers are running and no formatter configured. Call lsp_start first.");

  const doc = docState.getDoc(uri);
  const lastLine = Math.max(0, (doc?.text ?? "").split("\n").length - 1);
  const fullRange = { start: { line: 0, character: 0 }, end: { line: lastLine, character: 0 } };
  const diagnostics = docState.getDiagnostics(uri).flatMap((d) => d.diagnostics);

  const appliedActions: string[] = [];
  let totalEdits = 0;
  const changedFiles: { path: string; edits: number }[] = [];

  const runLspFixes = async () => {
    for (const entry of entries) {
      let actions: Array<{ title: string; edit?: unknown; command?: { command: string; arguments?: unknown[] } | string }>;
      try {
        const result = await entry.conn.request<unknown[]>("textDocument/codeAction", {
          textDocument: { uri },
          range: fullRange,
          context: { diagnostics, only: ["quickfix", "source.fixAll"] },
        });
        actions = Array.isArray(result) ? (result as never) : [];
      } catch {
        continue;
      }

      for (const action of actions) {
        if (action.edit) {
          const applied = await applyWorkspaceEdit(action.edit as never, supervisor, docState);
          if (applied.totalEdits > 0) {
            appliedActions.push(action.title);
            totalEdits += applied.totalEdits;
            changedFiles.push(...applied.changedFiles);
          }
        } else if (action.command) {
          const cmd = typeof action.command === "string" ? action.command : action.command.command;
          const args = typeof action.command === "string" ? undefined : action.command.arguments;
          try {
            await entry.conn.request("workspace/executeCommand", { command: cmd, arguments: args });
            appliedActions.push(action.title);
          } catch {
            // command not applicable, skip
          }
        }
      }
    }
  };

  const runFormatters = async () => {
    for (const fmt of matchingFormatters) {
      try {
        if (await runFormatter(fmt, ap)) {
          appliedActions.push(`format:${fmt.cmd[0]}`);
          totalEdits += 1;
          changedFiles.push({ path: ap, edits: 1 });
        }
      } catch (e) {
        log(`[formatter] ${fmt.cmd.join(" ")} failed: ${e}`);
      }
    }
  };

  if (projectConfig?.formatOrder === "before") {
    await runFormatters();
    await runLspFixes();
  } else {
    await runLspFixes();
    await runFormatters();
  }

  return { appliedActions, changedFiles, totalEdits };
}

type FormatOneResult = { changed: boolean; edits: number };

/** Format a single file. Returns a blocked result if external changes are pending. */
async function formatOne(ap: string, opts: { tabSize?: number; insertSpaces?: boolean; force?: boolean }): Promise<FormatOneResult | ReturnType<typeof blockedResult>> {
  await supervisor.ensureOpen(ap);

  const guard = checkMutationGuard(ap, opts.force);
  if (guard) return blockedResult(ap, guard);

  const entry = getReadyEntry();
  const edits = await entry.conn.request<unknown[]>("textDocument/formatting", {
    textDocument: { uri: pathToUri(ap) },
    options: { tabSize: opts.tabSize ?? 2, insertSpaces: opts.insertSpaces ?? true },
  });
  if (!edits || !edits.length) return { changed: false, edits: 0 };

  const applied = await applyWorkspaceEdit(
    { changes: { [pathToUri(ap)]: edits as never } },
    supervisor,
    docState,
  );
  return { changed: applied.totalEdits > 0, edits: applied.totalEdits };
}

/** Re-read a single file from disk and push it to every server that has it open. */
async function syncOne(ap: string, force: boolean | undefined): Promise<{ version: number } | ReturnType<typeof blockedResult>> {
  await supervisor.ensureOpen(ap);

  // syncFile from disk: if there are external changes it means the disk already differs from
  // LSP state; only block if the caller hasn't said force (they may want to sync to pick them up)
  const guard = checkMutationGuard(ap, force);
  if (guard && !force) return blockedResult(ap, guard);

  const version = await supervisor.syncFileFromDisk(ap);
  return { version };
}

// --- RPC dispatch ---

async function handleRpc(method: string, params: unknown): Promise<unknown> {
  if (method !== Methods.start && method !== Methods.stop && method !== Methods.stopAll) {
    const p = params as { file?: string | string[]; projectPath?: string };
    await Promise.all(toFiles(p?.file).map((f) => ensureConfiguredServers(absPath(p.projectPath ?? ROOT, f))));
  }

  switch (method) {
    case Methods.ping:
      return { ok: true, pid: process.pid };

    case Methods.start: {
      const p = params as StartParams;
      resolveProjectRoot(p.projectPath, p.server);
      const entry = await supervisor.startServer(p.server, p.cmdOverride, p.settings, p.initializationOptions);
      return { root: ROOT, serverId: p.server, pid: entry.conn.pid, capabilities: entry.capabilities };
    }

    case Methods.stop: {
      const p = params as StopParams;
      if (p.server) {
        supervisor.stopServer(p.server);
      } else {
        supervisor.stopAll();
        cleanup();
        setTimeout(() => process.exit(0), 100);
      }
      return { ok: true };
    }

    case Methods.stopAll: {
      supervisor.stopAll();
      cleanup();
      setTimeout(() => process.exit(0), 100);
      return { ok: true };
    }

    case Methods.status: {
      const { filesWithPendingChanges, totalPendingChanges } = docState.pendingChangeSummary();
      return {
        daemons: [{
          root: ROOT,
          pid: process.pid,
          uptime: supervisor.uptime(),
          filesWithPendingChanges,
          totalPendingChanges,
          servers: supervisor.allEntries().map((e) => ({
            serverId: e.serverId,
            state: e.state,
            openDocs: docState.allDocs().filter((d) => d.openOnServers.has(e.serverId)).length,
            diagCount: docState.getDiagnostics().filter((d) => d.serverId === e.serverId).reduce((s, d) => s + d.diagnostics.length, 0),
          })),
        }],
      };
    }

    case Methods.diagnostics: {
      const p = params as DiagnosticsParams;
      const timeoutMs = p.timeoutMs ?? loadConfig().diagnosticsTimeoutMs ?? 30000;
      const files = toFiles(p.file);

      if (files.length) {
        const collected = await Promise.all(
          files.map((f) => collectFileDiagnostics(absPath(p.projectPath, f), timeoutMs)),
        );
        const pending = [...new Set(collected.flatMap((c) => c.pending))];
        const stale = collected.some((c) => c.stale);
        return {
          diagnostics: collected.flatMap((c) => c.diagnostics),
          pending: pending.length ? pending : undefined,
          ...(stale ? { stale: true as const, hint: STALE_HINT } : {}),
        };
      }

      // No file given — return everything cached.
      const uris = [...new Set(docState.getDiagnostics().map((d) => d.uri))];
      return { diagnostics: uris.flatMap(buildFileDiagnostics) };
    }

    case Methods.definition: {
      const p = params as PositionParams;
      const ap = absPath(p.projectPath, p.file);
      await supervisor.ensureOpen(ap);
      const entry = getReadyEntry();
      const result = await entry.conn.request("textDocument/definition", {
        textDocument: { uri: pathToUri(ap) },
        position: normalizePosition(p.position),
      });
      return {
        locations: Array.isArray(result) ? result : result ? [result] : [],
        ...staleFlags(pathToUri(ap)),
      };
    }

    case Methods.references: {
      const p = params as ReferencesParams;
      const ap = absPath(p.projectPath, p.file);
      await supervisor.ensureOpen(ap);
      const entry = getReadyEntry();
      const result = await entry.conn.request("textDocument/references", {
        textDocument: { uri: pathToUri(ap) },
        position: normalizePosition(p.position),
        context: { includeDeclaration: p.includeDeclaration ?? false },
      });
      return {
        locations: Array.isArray(result) ? result : [],
        ...staleFlags(pathToUri(ap)),
      };
    }

    case Methods.hover: {
      const p = params as PositionParams;
      const ap = absPath(p.projectPath, p.file);
      await supervisor.ensureOpen(ap);
      const entry = getReadyEntry();
      const result = await entry.conn.request("textDocument/hover", {
        textDocument: { uri: pathToUri(ap) },
        position: normalizePosition(p.position),
      });
      return { hover: result ?? null, ...staleFlags(pathToUri(ap)) };
    }

    case Methods.documentSymbols: {
      const p = params as FileParams;
      const symbolsFor = async (file: string) => {
        const ap = absPath(p.projectPath, file);
        await supervisor.ensureOpen(ap);
        const entry = getReadyEntry();
        const result = await entry.conn.request("textDocument/documentSymbol", {
          textDocument: { uri: pathToUri(ap) },
        });
        return { file: ap, symbols: Array.isArray(result) ? result : [], ...staleFlags(pathToUri(ap)) };
      };
      const files = toFiles(p.file);
      if (Array.isArray(p.file)) return { results: await Promise.all(files.map(symbolsFor)) };
      const { symbols, ...rest } = await symbolsFor(files[0]);
      return { symbols, ...rest };
    }

    case Methods.workspaceSymbols: {
      const p = params as WorkspaceSymbolsParams;
      const entry = getReadyEntry();
      const result = await entry.conn.request("workspace/symbol", { query: p.query });
      return { symbols: Array.isArray(result) ? result : [] };
    }

    case Methods.codeActions: {
      const p = params as CodeActionsParams;
      const ap = absPath(p.projectPath, p.file);
      await supervisor.ensureOpen(ap);
      const entry = getReadyEntry();
      const result = await entry.conn.request("textDocument/codeAction", {
        textDocument: { uri: pathToUri(ap) },
        range: {
          start: normalizePosition(p.range.start),
          end: normalizePosition(p.range.end),
        },
        context: { diagnostics: [] },
      });
      return { actions: Array.isArray(result) ? result : [], ...staleFlags(pathToUri(ap)) };
    }

    case Methods.autoFix: {
      const p = params as AutoFixParams;
      const files = toFiles(p.file);

      if (Array.isArray(p.file)) {
        const results: Array<FileFixResult & { file: string }> = [];
        for (const f of files) {
          const ap = absPath(p.projectPath, f);
          const result = await autoFixOne(ap, p.force);
          if ("error" in result) return result;
          results.push({ file: ap, ...result });
        }
        return {
          appliedActions: results.flatMap((r) => r.appliedActions),
          changedFiles: results.flatMap((r) => r.changedFiles),
          totalEdits: results.reduce((s, r) => s + r.totalEdits, 0),
          results,
        };
      }

      return autoFixOne(absPath(p.projectPath, files[0]), p.force);
    }

    case Methods.rename: {
      const p = params as RenameParams;
      const ap = absPath(p.projectPath, p.file);
      await supervisor.ensureOpen(ap);

      // Guard: check entry-point file up front; full workspace-edit files are also guarded below
      const entryGuard = checkMutationGuard(ap, p.force);
      if (entryGuard) {
        return {
          error: "external_changes_pending",
          file: ap,
          changes: entryGuard,
          hint: "Call lsp_pull_changes to acknowledge, or pass force:true to overwrite.",
        };
      }

      const entry = getReadyEntry();
      const pos = normalizePosition(p.position);

      if (entry.capabilities.renameProvider && typeof entry.capabilities.renameProvider === "object"
          && (entry.capabilities.renameProvider as { prepareProvider?: boolean }).prepareProvider) {
        try {
          const prep = await entry.conn.request("textDocument/prepareRename", {
            textDocument: { uri: pathToUri(ap) },
            position: pos,
          });
          if (!prep) return { error: "Server rejected rename at this position" };
        } catch (e) {
          return { error: `prepareRename failed: ${e}` };
        }
      }

      const edit = await entry.conn.request<{ changes?: unknown; documentChanges?: unknown }>("textDocument/rename", {
        textDocument: { uri: pathToUri(ap) },
        position: pos,
        newName: p.newName,
      });
      if (!edit) return { changedFiles: [], renamedOccurrences: 0 };

      // Guard all files in the workspace edit
      const allUris = edit.documentChanges
        ? (edit.documentChanges as Array<{ textDocument: { uri: string } }>).map((c) => uriToPath(c.textDocument.uri))
        : Object.keys((edit.changes ?? {}) as object).map(uriToPath);

      for (const targetPath of allUris) {
        const guard = checkMutationGuard(targetPath, p.force);
        if (guard) {
          return {
            error: "external_changes_pending",
            file: targetPath,
            changes: guard,
            hint: "Call lsp_pull_changes to acknowledge, or pass force:true to overwrite.",
          };
        }
      }

      const applied = await applyWorkspaceEdit(edit as never, supervisor, docState);
      return { changedFiles: applied.changedFiles, renamedOccurrences: applied.totalEdits };
    }

    case Methods.format: {
      const p = params as FormatParams;
      const files = toFiles(p.file);

      if (Array.isArray(p.file)) {
        const results: Array<FormatOneResult & { file: string }> = [];
        for (const f of files) {
          const ap = absPath(p.projectPath, f);
          const result = await formatOne(ap, p);
          if ("error" in result) return result;
          results.push({ file: ap, ...result });
        }
        return { results };
      }

      return formatOne(absPath(p.projectPath, files[0]), p);
    }

    case Methods.syncFile: {
      const p = params as SyncFileParams;
      const files = toFiles(p.file);

      if (Array.isArray(p.file)) {
        const results: Array<{ file: string; version: number }> = [];
        for (const f of files) {
          const ap = absPath(p.projectPath, f);
          const result = await syncOne(ap, p.force);
          if ("error" in result) return result;
          results.push({ file: ap, ...result });
        }
        return { results };
      }

      return syncOne(absPath(p.projectPath, files[0]), p.force);
    }

    case Methods.pullChanges: {
      const p = params as PullChangesParams;
      const acknowledge = p.acknowledge !== false; // default true

      const files = toFiles(p.file);
      const uris = files.length ? files.map((f) => pathToUri(absPath(p.projectPath, f))) : undefined;

      const raw = uris
        ? uris.flatMap((u) => docState.getExternalChanges(u))
        : docState.getExternalChanges();
      const result: ExternalChangeEvent[] = raw.flatMap(({ path, changes }) =>
        changes.map((c): ExternalChangeEvent => ({
          file: path,
          kind: c.kind,
          timestamp: c.timestamp,
          diff: c.diff,
          truncated: c.truncated,
        }))
      );

      if (acknowledge) {
        // Clear queues and sync LSP state to current disk content
        const paths = uris ? uris.map(uriToPath) : raw.map((r) => r.path);
        for (const filePath of paths) {
          docState.clearExternalChanges(pathToUri(filePath));
          try {
            const text = readFileSync(filePath, "utf8");
            await supervisor.syncDocToDisk(filePath, text);
          } catch {
            // file deleted or unreadable — skip LSP sync
          }
        }
      }

      return { changes: result };
    }

    default:
      throw Object.assign(new Error(`Unknown method: ${method}`), { code: -32601 });
  }
}

function getReadyEntry() {
  const entries = supervisor.allEntries().filter((e) => e.state === "ready");
  if (!entries.length) throw new Error("No LSP servers are running. Call lsp_start first.");
  return entries[0];
}

// --- Unix socket server ---

function cleanup(): void {
  try { unlinkSync(SOCK); } catch {}
  try { unlinkSync(PID_FILE); } catch {}
}

// Kill child language servers on any exit path — otherwise a daemon that is SIGTERMed or
// crashes leaves orphaned 1-2GB tsserver/eslint processes that stall forever on a dead socket.
function shutdown(): void {
  try { supervisor.stopAll(); } catch {}
  cleanup();
}

process.on("SIGTERM", () => { shutdown(); process.exit(0); });
process.on("SIGINT", () => { shutdown(); process.exit(0); });
process.on("exit", shutdown);

try { unlinkSync(SOCK); } catch {}

log(`[daemon] starting, root=${ROOT}, pid=${process.pid}, sock=${SOCK}`);
try {
  const fdLimit = (await Bun.$`ulimit -n`.text()).trim();
  log(`[daemon] FD soft limit: ${fdLimit}`);
} catch (e) {
  log(`[daemon] could not read FD limit: ${e}`);
}

const server = Bun.listen<{ decoder: NdJsonDecoder }>({
  unix: SOCK,
  socket: {
    open(socket) {
      socket.data = { decoder: new NdJsonDecoder() };
    },
    data(socket, data) {
      const msgs = socket.data.decoder.push(data);
      for (const msg of msgs) {
        if (!isRequest(msg)) continue;
        handleRpc(msg.method, msg.params)
          .then((result) => writeAll(socket, encodeNdJson(makeResult(msg.id, result))))
          .catch((err: Error & { code?: number }) => {
            const code = err.code ?? -32603;
            return writeAll(socket, encodeNdJson(makeError(msg.id, code, err.message)));
          });
      }
    },
    close(_socket) {},
    error(_socket, err) {
      log(`[daemon] socket error: ${err}`);
    },
  },
});

/**
 * Write a full message to a Bun unix socket. Bun's Socket.write() caps out at 8192 bytes
 * per call and silently drops the remainder (verified: a 60KB response left the client
 * waiting for the trailing newline forever). Loop over the remainder, flushing and
 * yielding between chunks so the kernel can drain and backpressure resolves.
 */
async function writeAll(socket: import("bun").Socket<unknown>, data: Uint8Array): Promise<void> {
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

log(`[daemon] listening on ${SOCK}`);
