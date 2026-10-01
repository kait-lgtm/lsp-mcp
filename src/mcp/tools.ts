import { DaemonClient } from "./client.ts";
import { Methods } from "../shared/protocol.ts";
import { resolveRoot } from "../daemon/registry.ts";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: object;
}

/** `file` accepts a single path or an array of paths (batch — one call, per-file results). */
function fileSchema(description: string): object {
  return {
    anyOf: [
      { type: "string", description },
      { type: "array", items: { type: "string" }, description: `${description} Batch: pass an array of paths.` },
    ],
  };
}

const BATCH_NOTE = " Pass an array of paths to batch multiple files in one call.";

export const TOOLS: McpTool[] = [
  {
    name: "lsp_start",
    description: "Start a language server for a project. Idempotent — safe to call multiple times.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: { type: "string", description: "Absolute path to the project directory or any file within it" },
        server: { type: "string", description: "Server ID: tsgo, tsserver, eslint, gopls (or any registered server)" },
        cmdOverride: { type: "array", items: { type: "string" }, description: "Override the server command" },
        settings: { description: "Sent via workspace/didChangeConfiguration after init" },
        initializationOptions: { description: "Sent in initialize request as initializationOptions (e.g. tsserver hostInfo, maxTsServerMemory, preferences)" },
      },
      required: ["projectPath", "server"],
    },
  },
  {
    name: "lsp_stop",
    description: "Stop a language server (or entire daemon if server omitted).",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: { type: "string" },
        server: { type: "string", description: "If omitted, stops the whole daemon for this project" },
      },
      required: ["projectPath"],
    },
  },
  {
    name: "lsp_stop_all",
    description: "Kill all LSP daemons.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "lsp_status",
    description: "List running daemons, their language servers, open document counts, and diagnostic counts.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: { type: "string", description: "If provided, query only this project's daemon" },
      },
    },
  },
  {
    name: "lsp_diagnostics",
    description: "Get diagnostics (errors, warnings) for one or more files, or all open files. If the project has a .lsp-mcp.json with a \"servers\" list, matching servers auto-start — no need to call lsp_start first." + BATCH_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        projectPath: { type: "string" },
        file: fileSchema("Absolute or project-relative path. If omitted, returns all cached diagnostics."),
        timeoutMs: { type: "number", description: "How long to wait for diagnostics per file (default 30000)" },
      },
      required: ["projectPath"],
    },
  },
  {
    name: "lsp_definition",
    description: "Go to definition — returns the location(s) where a symbol is defined.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: { type: "string" },
        file: { type: "string" },
        position: {
          type: "object",
          description: "Either {line, character} (0-indexed) or {line1, col1} (1-indexed)",
          properties: {
            line: { type: "number" }, character: { type: "number" },
            line1: { type: "number" }, col1: { type: "number" },
          },
        },
      },
      required: ["projectPath", "file", "position"],
    },
  },
  {
    name: "lsp_references",
    description: "Find all references to the symbol at position.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: { type: "string" },
        file: { type: "string" },
        position: {
          type: "object",
          properties: {
            line: { type: "number" }, character: { type: "number" },
            line1: { type: "number" }, col1: { type: "number" },
          },
        },
        includeDeclaration: { type: "boolean", description: "Include the declaration itself (default false)" },
      },
      required: ["projectPath", "file", "position"],
    },
  },
  {
    name: "lsp_hover",
    description: "Get hover information (type, documentation) for the symbol at position.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: { type: "string" },
        file: { type: "string" },
        position: {
          type: "object",
          properties: {
            line: { type: "number" }, character: { type: "number" },
            line1: { type: "number" }, col1: { type: "number" },
          },
        },
      },
      required: ["projectPath", "file", "position"],
    },
  },
  {
    name: "lsp_document_symbols",
    description: "List all symbols (functions, classes, variables, etc.) in a file. A single path returns {symbols}; an array returns {results: [{file, symbols}]}." + BATCH_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        projectPath: { type: "string" },
        file: fileSchema("Absolute or project-relative path."),
      },
      required: ["projectPath", "file"],
    },
  },
  {
    name: "lsp_workspace_symbols",
    description: "Search for symbols across the entire workspace.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: { type: "string" },
        query: { type: "string", description: "Symbol name to search for" },
      },
      required: ["projectPath", "query"],
    },
  },
  {
    name: "lsp_code_actions",
    description: "Get available code actions (quick fixes, refactors) for a range in a file.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: { type: "string" },
        file: { type: "string" },
        range: {
          type: "object",
          properties: {
            start: { type: "object", properties: { line: { type: "number" }, character: { type: "number" }, line1: { type: "number" }, col1: { type: "number" } } },
            end: { type: "object", properties: { line: { type: "number" }, character: { type: "number" }, line1: { type: "number" }, col1: { type: "number" } } },
          },
        },
      },
      required: ["projectPath", "file", "range"],
    },
  },
  {
    name: "lsp_autofix",
    description: "Apply all auto-fixable diagnostics for one or more files (eslint quick fixes, fixAll actions, etc) then run any configured formatters (see .lsp-mcp.json). Applies changes to disk. Auto-starts configured servers. Blocked if a file has external changes pending (pass force:true to overwrite). Array input returns aggregate counts plus per-file results." + BATCH_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        projectPath: { type: "string" },
        file: fileSchema("Absolute or project-relative path."),
        force: { type: "boolean", description: "Overwrite any pending external changes" },
      },
      required: ["projectPath", "file"],
    },
  },
  {
    name: "lsp_rename_symbol",
    description: "Rename a symbol at position across the entire workspace. Applies changes to disk and returns affected files. Blocked if any target file has external changes pending (pass force:true to overwrite).",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: { type: "string" },
        file: { type: "string" },
        position: {
          type: "object",
          properties: {
            line: { type: "number" }, character: { type: "number" },
            line1: { type: "number" }, col1: { type: "number" },
          },
        },
        newName: { type: "string", description: "The new symbol name" },
        force: { type: "boolean", description: "Overwrite any pending external changes" },
      },
      required: ["projectPath", "file", "position", "newName"],
    },
  },
  {
    name: "lsp_format_document",
    description: "Format one or more documents using the language server. Applies changes to disk. Blocked if a file has external changes pending (pass force:true to overwrite). A single path returns {changed, edits}; an array returns {results: [{file, changed, edits}]}." + BATCH_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        projectPath: { type: "string" },
        file: fileSchema("Absolute or project-relative path."),
        tabSize: { type: "number", description: "Tab size (default 2)" },
        insertSpaces: { type: "boolean", description: "Use spaces (default true)" },
        force: { type: "boolean", description: "Overwrite any pending external changes" },
      },
      required: ["projectPath", "file"],
    },
  },
  {
    name: "lsp_sync_file",
    description: "Re-read one or more files from disk and notify all language servers of the change. Call after editing files. Blocked if external changes are pending (pass force:true to override). A single path returns {version}; an array returns {results: [{file, version}]}." + BATCH_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        projectPath: { type: "string" },
        file: fileSchema("Absolute or project-relative path."),
        force: { type: "boolean", description: "Overwrite any pending external changes" },
      },
      required: ["projectPath", "file"],
    },
  },
  {
    name: "lsp_pull_changes",
    description: "Fetch any external file changes detected since the last sync (e.g. user edits in their editor). Returns unified diffs. By default acknowledges the changes, clears the queue, and syncs LSP state to disk — so the next lsp_diagnostics will reflect reality." + BATCH_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        projectPath: { type: "string" },
        file: fileSchema("Specific file(s) to pull changes for. Omit to pull all."),
        acknowledge: { type: "boolean", description: "Clear queue and sync LSP on return (default true). Pass false to peek without consuming." },
      },
      required: ["projectPath"],
    },
  },
];

// Active daemon clients keyed by project root
const clients = new Map<string, DaemonClient>();

function getClient(projectPath: string, serverId?: string): DaemonClient {
  const root = resolveRoot(projectPath, serverId);
  if (!clients.has(root)) {
    clients.set(root, new DaemonClient(projectPath, serverId));
  }
  return clients.get(root)!;
}

export function disconnectAll(): void {
  for (const client of clients.values()) client.disconnect();
}

export async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const projectPath = (args.projectPath as string) ?? process.cwd();
  const client = getClient(projectPath, args.server as string | undefined);

  const methodMap: Record<string, string> = {
    lsp_start: Methods.start,
    lsp_stop: Methods.stop,
    lsp_stop_all: Methods.stopAll,
    lsp_status: Methods.status,
    lsp_diagnostics: Methods.diagnostics,
    lsp_definition: Methods.definition,
    lsp_references: Methods.references,
    lsp_hover: Methods.hover,
    lsp_document_symbols: Methods.documentSymbols,
    lsp_workspace_symbols: Methods.workspaceSymbols,
    lsp_code_actions: Methods.codeActions,
    lsp_autofix: Methods.autoFix,
    lsp_rename_symbol: Methods.rename,
    lsp_format_document: Methods.format,
    lsp_sync_file: Methods.syncFile,
    lsp_pull_changes: Methods.pullChanges,
  };

  const method = methodMap[name];
  if (!method) throw new Error(`Unknown tool: ${name}`);

  return client.call(method, args);
}

export type DiagItem = {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  severity?: number;
  message: string;
  source?: string;
  code?: string | number;
  serverId: string;
  file: string;
  sourceLine?: string;
  lineNumber: number;
};

export type DiagResult = {
  diagnostics: DiagItem[];
  pending?: string[];
  stale?: boolean;
};

const SEVERITY_LABEL: Record<number, string> = { 1: "ERROR", 2: "WARNING", 3: "INFO", 4: "HINT" };

export function formatDiagnostics(result: DiagResult): string {
  const diags = result.diagnostics ?? [];
  if (diags.length === 0) {
    let out = "No diagnostics.";
    if (result.pending?.length) out += `\n\nPending servers: ${result.pending.join(", ")}`;
    return out;
  }

  const gutterWidth = String(Math.max(...diags.map((d) => d.lineNumber))).length;
  const blocks = diags.map((d) => {
    const col = d.range.start.character + 1;
    const sev = SEVERITY_LABEL[d.severity ?? 1] ?? "ERROR";
    const codeTag = d.source || d.code !== undefined
      ? `${d.source ?? ""}${d.code !== undefined ? `(${d.code})` : ""}`.trim()
      : "";
    const header = `${d.file}:${d.lineNumber}:${col}  ${sev}${codeTag ? `  ${codeTag}` : ""} [${d.serverId}]`;

    const lineNumStr = String(d.lineNumber).padStart(gutterWidth, " ");
    const blankGutter = " ".repeat(gutterWidth);
    const src = d.sourceLine ?? "<line unavailable>";

    let caretCount: number;
    let caretSuffix = "";
    if (d.range.end.line > d.range.start.line) {
      caretCount = Math.max(1, src.length - d.range.start.character);
      caretSuffix = "...";
    } else {
      caretCount = Math.max(1, d.range.end.character - d.range.start.character);
    }
    const padding = " ".repeat(d.range.start.character);
    const carets = "^".repeat(caretCount) + caretSuffix;

    return [
      header,
      `  ${lineNumStr} | ${src}`,
      `  ${blankGutter} | ${padding}${carets}`,
      `  ${d.message}`,
    ].join("\n");
  });

  const files = new Set(diags.map((d) => d.file)).size;
  const footer = `${diags.length} diagnostic${diags.length === 1 ? "" : "s"} across ${files} file${files === 1 ? "" : "s"}.`;

  let out = blocks.join("\n\n") + "\n\n" + footer;
  if (result.pending?.length) out += `\n\nPending servers: ${result.pending.join(", ")}`;
  if (result.stale) out += `\n\n(stale — external changes detected mid-call)`;
  return out;
}
