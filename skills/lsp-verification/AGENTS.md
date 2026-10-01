# Code verification with lsp-mcp

When lsp-mcp tools (`lsp_*`) are available, use them as the primary check after editing code. Do not run `tsc`, `eslint`, `prettier`, or similar CLI tools first when a language server covers the file.

A server covers the file when `.lsp-mcp.json` lists a matching server, or `lsp_status` shows a `ready` server for that language. Otherwise use the project's CLI tooling.

After edits:

1. `lsp_sync_file` with the changed files (`file` accepts a path or an array).
2. `lsp_diagnostics` with the same array — errors/warnings with `file:line:col`.
3. `lsp_autofix` with the same array to apply quick fixes and formatters, then `lsp_diagnostics` again.
4. Fix what remains by hand; use `lsp_definition` / `lsp_references` / `lsp_hover` / `lsp_code_actions` for context.

If no server is running, `lsp_start` with `{ "projectPath": ..., "server": "tsgo" }` (or `tsserver`, `eslint`, `gopls`), or add `{ "servers": ["tsserver"] }` to `.lsp-mcp.json` so diagnostics auto-start. If a mutation is blocked with `external_changes_pending`, run `lsp_pull_changes` first.
