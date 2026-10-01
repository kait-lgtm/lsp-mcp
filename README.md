# lsp-mcp

LSP intelligence through a persistent daemon. It can run as an MCP server (Claude Code, Codex, any MCP client) or as a [Pi](https://pi.dev) package.

`bun` and the language server you select (such as `tsgo`, `typescript-language-server`, `vscode-eslint-language-server`, or `gopls`) must be available on `PATH`.

## Pi

From npm (not published yet — substitute your scope once it is):

```sh
pi install @your-scope/lsp-mcp
```

From a local checkout:

```sh
pi install /absolute/path/to/lsp-mcp
# or for one run
pi -e /absolute/path/to/lsp-mcp/extensions/lsp-mcp.ts
```

The extension registers the `lsp_*` tools (diagnostics, definitions, references, hover, symbols, code actions, formatting, rename, and sync) directly in Pi. It starts the bundled MCP server with `bun` on first use and closes that client when the Pi session ends.

## Claude Code (via npm)

```sh
claude mcp add lsp-mcp -- bunx @your-scope/lsp-mcp
```

Or add it to a project `.mcp.json` (or your user-level MCP config):

```json
{
  "mcpServers": {
    "lsp-mcp": {
      "command": "bunx",
      "args": ["@your-scope/lsp-mcp"]
    }
  }
}
```

## Codex CLI (via npm)

```sh
codex mcp add lsp-mcp -- bunx @your-scope/lsp-mcp
```

Or add it to `~/.codex/config.toml`:

```toml
[mcp_servers.lsp-mcp]
command = "bunx"
args = ["@your-scope/lsp-mcp"]
```

## Any other MCP client

The server speaks newline-delimited JSON-RPC over standard input/output. Point the client at:

```sh
bunx @your-scope/lsp-mcp
```

Run it directly from a checkout with:

```sh
bun run bin/lsp-mcp.ts
```

## Project config

Configure project servers in `.lsp-mcp.json` at the project root:

```json
{ "servers": ["tsserver"] }
```

`lsp_diagnostics` automatically starts matching configured servers — no need to call `lsp_start` first.

## Multiple files per call

The file-based tools accept `file` as a single path **or an array of paths**, so a batch of files needs one call:

- `lsp_diagnostics` — flat list of diagnostics for all files
- `lsp_document_symbols` — `{ "results": [{ "file": ..., "symbols": [...] }] }`
- `lsp_format_document` — `{ "results": [{ "file": ..., "changed": ..., "edits": ... }] }`
- `lsp_sync_file` — `{ "results": [{ "file": ..., "version": ... }] }`
- `lsp_autofix` — aggregate `appliedActions` / `changedFiles` / `totalEdits` plus per-file `results`
- `lsp_pull_changes` — diffs for the given files

Passing a single string keeps the original response shape.

## Releasing

The unscoped `lsp-mcp` name on npm is a security-holding package, so publish under a scope:

1. Set `"name": "@your-scope/lsp-mcp"` in `package.json` (scope must match your npm user or org).
2. `npm login` (or set `NPM_TOKEN` for CI).
3. `npm publish` — the `prepublishOnly` script runs `bun test` and `tsc --noEmit` first.

`publishConfig.access` is already `public` (required for scoped packages). The tarball ships `bin/`, `src/`, `extensions/`, plus README/LICENSE/package.json — no tests, lockfile, or local config.
