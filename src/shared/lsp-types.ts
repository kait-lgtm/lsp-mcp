// Subset of LSP types used by lsp-mcp

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Location {
  uri: string;
  range: Range;
}

export interface TextEdit {
  range: Range;
  newText: string;
}

export interface TextDocumentIdentifier {
  uri: string;
}

export interface VersionedTextDocumentIdentifier extends TextDocumentIdentifier {
  version: number;
}

export interface TextDocumentItem {
  uri: string;
  languageId: string;
  version: number;
  text: string;
}

export interface TextDocumentContentChangeEvent {
  text: string;
}

export interface DiagnosticRelatedInformation {
  location: Location;
  message: string;
}

export interface Diagnostic {
  range: Range;
  severity?: 1 | 2 | 3 | 4; // error, warning, information, hint
  code?: string | number;
  source?: string;
  message: string;
  relatedInformation?: DiagnosticRelatedInformation[];
}

export interface WorkspaceEdit {
  changes?: Record<string, TextEdit[]>;
  documentChanges?: Array<{
    textDocument: VersionedTextDocumentIdentifier;
    edits: TextEdit[];
  }>;
}

export interface SymbolInformation {
  name: string;
  kind: number;
  location: Location;
  containerName?: string;
}

export interface DocumentSymbol {
  name: string;
  kind: number;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}

export interface Hover {
  contents: { kind: string; value: string } | string | { language: string; value: string }[];
  range?: Range;
}

export interface Command {
  title: string;
  command: string;
  arguments?: unknown[];
}

export interface CodeAction {
  title: string;
  kind?: string;
  diagnostics?: Diagnostic[];
  edit?: WorkspaceEdit;
  command?: Command;
}

export interface InitializeResult {
  capabilities: ServerCapabilities;
  serverInfo?: { name: string; version?: string };
}

export interface ServerCapabilities {
  textDocumentSync?: number | { openClose?: boolean; change?: number; save?: boolean | { includeText?: boolean } };
  completionProvider?: object;
  hoverProvider?: boolean | object;
  definitionProvider?: boolean | object;
  referencesProvider?: boolean | object;
  documentSymbolProvider?: boolean | object;
  workspaceSymbolProvider?: boolean | object;
  renameProvider?: boolean | { prepareProvider?: boolean };
  documentFormattingProvider?: boolean | object;
  codeActionProvider?: boolean | object;
}

export const DiagnosticSeverity = {
  Error: 1,
  Warning: 2,
  Information: 3,
  Hint: 4,
} as const;

export const SymbolKind = {
  File: 1, Module: 2, Namespace: 3, Package: 4, Class: 5,
  Method: 6, Property: 7, Field: 8, Constructor: 9, Enum: 10,
  Interface: 11, Function: 12, Variable: 13, Constant: 14,
  String: 15, Number: 16, Boolean: 17, Array: 18, Object: 19,
  Key: 20, Null: 21, EnumMember: 22, Struct: 23, Event: 24,
  Operator: 25, TypeParameter: 26,
} as const;
