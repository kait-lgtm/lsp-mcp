---
name: lsp-verification
description: Verify code edits with lsp-mcp language-server tools (lsp_sync_file, lsp_diagnostics, lsp_autofix, lsp_format_document) instead of CLI checkers like tsc, eslint, or prettier. Use after editing source files, before declaring work done, or whenever asked to typecheck or lint a project that has an .lsp-mcp.json or a running LSP daemon.
---

# LSP verification

Use lsp-mcp as the primary check after editing code. It talks to real language servers (tsgo/tsserver, eslint LSP, gopls, ...) through a warm daemon, so it is faster and more accurate than spawning CLI checkers.

## Rule

If a language server covers the edited file, verify with lsp-mcp. Do not run `tsc`, `eslint`, `prettier`, or similar CLI tools as the first check.

A server covers the file when either:

- the project has `.lsp-mcp.json` with a `servers` list and the file's language matches, or
- `lsp_status` shows a `ready` server whose language covers the file.

If no server covers the language, fall back to the project's CLI tooling.

## Loop after edits

1. `lsp_sync_file` — `{ "projectPath": "<abs project path>", "file": ["<changed>", "<files>"] }`. Needed after Write/Edit-style tools; the daemon re-reads files from disk.
2. `lsp_diagnostics` — same `file` array. Returns errors/warnings with `file:line:col`, the source line, and a caret.
3. `lsp_autofix` — same `file` array, to apply quick fixes and configured formatters. Then run `lsp_diagnostics` again.
4. Fix remaining diagnostics by hand. Use `lsp_code_actions`, `lsp_definition`, `lsp_references`, and `lsp_hover` for context.

Always prefer one array call over one call per file.

## Other uses

- Before a refactor: `lsp_references` to find all uses, `lsp_rename_symbol` to rename workspace-wide.
- `lsp_hover` for types/docs, `lsp_document_symbols` for a file outline, `lsp_workspace_symbols` to find symbols by name.
- `lsp_pull_changes` when the user edited files in their own editor; acknowledge by default.

## Fallbacks

- Error "No LSP servers are running": call `lsp_start` with `{ "projectPath": ..., "server": "tsgo" | "tsserver" | "eslint" | "gopls" }`, or add `.lsp-mcp.json` with `{ "servers": ["tsserver"] }` so `lsp_diagnostics` auto-starts it.
- Blocked with `external_changes_pending`: run `lsp_pull_changes` to acknowledge, or pass `"force": true`.
- No configured server for the language: use the project's CLI checker instead.

## Examples

Verify two edited files in one call:

```json
{ "projectPath": "/repo", "file": ["/repo/src/a.ts", "/repo/src/b.ts"] }
```

Autofix then re-check:

```json
{ "projectPath": "/repo", "file": ["/repo/src/a.ts"], "force": false }
```
