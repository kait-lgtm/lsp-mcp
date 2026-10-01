// MCP ↔ daemon IPC shapes (JSON-RPC 2.0 method names + param/result types)

import type { Diagnostic, Location, Hover, SymbolInformation, DocumentSymbol, CodeAction } from "./lsp-types.ts";

// --- Lifecycle ---

export interface StartParams {
  projectPath: string;
  server: string;
  cmdOverride?: string[];
  settings?: unknown;
  initializationOptions?: unknown;
}

export interface StartResult {
  root: string;
  serverId: string;
  pid: number;
  capabilities: unknown;
}

export interface StopParams {
  projectPath: string;
  server?: string;
}

export interface StatusResult {
  daemons: DaemonInfo[];
}

export interface DaemonInfo {
  root: string;
  pid: number;
  uptime: number;
  servers: ServerInfo[];
  filesWithPendingChanges: number;
  totalPendingChanges: number;
}

export interface ServerInfo {
  serverId: string;
  state: "starting" | "ready" | "crashed" | "stopped";
  openDocs: number;
  diagCount: number;
}

// --- Code intel ---

/** A single file path, or a list of paths for batch calls. */
export type FileRef = string | string[];

export interface FileParams {
  projectPath: string;
  file: FileRef;
}

export interface DiagnosticsParams {
  projectPath: string;
  file?: FileRef;
  timeoutMs?: number;
}

export interface DiagnosticsResult {
  diagnostics: TaggedDiagnostic[];
  pending?: string[];
  stale?: boolean;
  hint?: string;
}

export interface TaggedDiagnostic extends Diagnostic {
  serverId: string;
  file: string;
}

export interface PositionParams {
  projectPath: string;
  file: string;
  position: { line?: number; character?: number; line1?: number; col1?: number };
}

export interface DefinitionResult {
  locations: Location[];
  stale?: boolean;
  hint?: string;
}

export interface ReferencesParams extends PositionParams {
  includeDeclaration?: boolean;
}

export interface ReferencesResult {
  locations: Location[];
  stale?: boolean;
  hint?: string;
}

export interface HoverResult {
  hover: Hover | null;
  stale?: boolean;
  hint?: string;
}

export interface DocumentSymbolsResult {
  symbols: (SymbolInformation | DocumentSymbol)[];
  stale?: boolean;
  hint?: string;
}

export interface WorkspaceSymbolsParams {
  projectPath: string;
  query: string;
}

export interface WorkspaceSymbolsResult {
  symbols: SymbolInformation[];
}

export interface CodeActionsParams {
  projectPath: string;
  file: string;
  range: { start: { line?: number; character?: number; line1?: number; col1?: number }; end: { line?: number; character?: number; line1?: number; col1?: number } };
}

export interface CodeActionsResult {
  actions: CodeAction[];
  stale?: boolean;
  hint?: string;
}

export interface AutoFixParams extends FileParams {
  force?: boolean;
}

export interface AutoFixResult {
  appliedActions: string[];
  changedFiles: { path: string; edits: number }[];
}

// --- Mutations ---

export interface RenameParams extends PositionParams {
  newName: string;
  force?: boolean;
}

export interface RenameResult {
  changedFiles: { path: string; edits: number }[];
  renamedOccurrences: number;
}

export interface FormatParams extends FileParams {
  tabSize?: number;
  insertSpaces?: boolean;
  force?: boolean;
}

export interface FormatResult {
  changed: boolean;
  edits: number;
}

export interface SyncFileParams extends FileParams {
  force?: boolean;
}

export interface SyncFileResult {
  version: number;
}

// External-changes guard response (returned instead of normal result when blocked)
export interface ExternalChangesBlockedResult {
  error: "external_changes_pending";
  file: string;
  changes: ExternalChangeEvent[];
  hint: string;
}

export interface ExternalChangeEvent {
  file: string;
  kind: "modified" | "created" | "deleted";
  timestamp: number;
  diff: string;
  truncated?: boolean;
}

// --- Pull changes ---

export interface PullChangesParams {
  projectPath: string;
  file?: FileRef;
  acknowledge?: boolean;
}

export interface PullChangesResult {
  changes: ExternalChangeEvent[];
}

// --- Ping ---

export interface PingResult {
  ok: true;
  pid: number;
}

// Method name constants
export const Methods = {
  ping: "ping",
  start: "lsp/start",
  stop: "lsp/stop",
  stopAll: "lsp/stopAll",
  status: "lsp/status",
  diagnostics: "lsp/diagnostics",
  definition: "lsp/definition",
  references: "lsp/references",
  hover: "lsp/hover",
  documentSymbols: "lsp/documentSymbols",
  workspaceSymbols: "lsp/workspaceSymbols",
  codeActions: "lsp/codeActions",
  autoFix: "lsp/autoFix",
  rename: "lsp/rename",
  format: "lsp/format",
  syncFile: "lsp/syncFile",
  pullChanges: "lsp/pullChanges",
} as const;
