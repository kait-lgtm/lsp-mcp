#!/usr/bin/env bun
import { callTool, formatDiagnostics, disconnectAll, type DiagResult } from "../src/mcp/tools.ts";

const COMMANDS: Record<string, string> = {
  diag: "lsp_diagnostics",
  diagnostics: "lsp_diagnostics",
  start: "lsp_start",
  stop: "lsp_stop",
  "stop-all": "lsp_stop_all",
  status: "lsp_status",
  definition: "lsp_definition",
  references: "lsp_references",
  hover: "lsp_hover",
  symbols: "lsp_document_symbols",
  "workspace-symbols": "lsp_workspace_symbols",
  actions: "lsp_code_actions",
  fix: "lsp_autofix",
  autofix: "lsp_autofix",
  rename: "lsp_rename_symbol",
  format: "lsp_format_document",
  sync: "lsp_sync_file",
  pull: "lsp_pull_changes",
};

function usage(): never {
  console.error(`Usage: lsp-mcp <command> [file] [options]

Commands: ${Object.keys(COMMANDS).join(", ")}

Options:
  -p, --project <path>   Project root (default: cwd)
  -s, --server <id>      Server id: tsserver, eslint, tsgo, gopls (default: tsgo)
  --position <line:col>  1-indexed line:col (for definition/references/hover/rename)
  --new-name <name>      New symbol name (for rename)
  --timeout <ms>         Diagnostics wait timeout
  --json                 Print raw JSON instead of formatted text

Examples:
  lsp-mcp diag src/index.ts
  lsp-mcp diag src/index.ts -s eslint
  lsp-mcp hover src/index.ts --position 10:5
  lsp-mcp status
`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const [command, ...rest] = argv;
  if (!command || !COMMANDS[command]) usage();

  const opts: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "-p" || a === "--project") opts.project = rest[++i]!;
    else if (a === "-s" || a === "--server") opts.server = rest[++i]!;
    else if (a === "--position") opts.position = rest[++i]!;
    else if (a === "--new-name") opts.newName = rest[++i]!;
    else if (a === "--timeout") opts.timeout = rest[++i]!;
    else if (a === "--json") opts.json = true;
    else positional.push(a);
  }
  return { command, opts, positional };
}

function parsePosition(pos: string): { line1: number; col1: number } {
  const [line, col] = pos.split(":").map(Number);
  if (!line || !col) throw new Error(`Bad --position "${pos}", expected line:col`);
  return { line1: line, col1: col };
}

async function main() {
  const { command, opts, positional } = parseArgs(process.argv.slice(2));
  const toolName = COMMANDS[command]!;
  const projectPath = (opts.project as string) ?? process.cwd();

  const args: Record<string, unknown> = { projectPath };
  if (opts.server) args.server = opts.server;
  if (positional[0]) args.file = positional[0];
  if (opts.timeout) args.timeoutMs = Number(opts.timeout);
  if (opts.position) args.position = parsePosition(opts.position as string);
  if (opts.newName) args.newName = opts.newName;

  const result = await callTool(toolName, args);

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (toolName === "lsp_diagnostics") {
    console.log(formatDiagnostics(result as DiagResult));
  } else {
    console.log(JSON.stringify(result, null, 2));
  }

  disconnectAll();
  process.exit(0);
}

main().catch((e) => {
  console.error(`Error: ${(e as Error).message}`);
  disconnectAll();
  process.exit(1);
});
