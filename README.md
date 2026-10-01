# lsp-mcp

LSP intelligence through a persistent daemon. It can run as an MCP server (Claude Code, Codex, any MCP client) or as a [Pi](https://pi.dev) package.

## One LSP setup, every harness

Coding agents each ship their own LSP story: some have built-in language-server integrations, some rely on shelling out to `tsc`/`eslint`/`prettier`, some have nothing. That means the same edit gets verified differently depending on which harness you happen to be using.

lsp-mcp moves LSP out of the harness and behind MCP. Any MCP-capable agent gets the same `lsp_*` tools backed by the same warm daemon, the same project config (`.lsp-mcp.json`), and the same diagnostics/format/autofix behavior:

- **Switch harnesses freely** — Claude Code, Codex, Pi, opencode, or anything else that speaks MCP: no reconfiguration, no relearning a different LSP integration.
- **One daemon per project root** — language servers stay warm and are shared across harnesses and sessions, so checks are fast.
- **Consistent verification flow** — pair it with the [lsp-verification skill](#make-your-agent-verify-with-lsp) so every harness checks edits the same way instead of falling back to CLI tools.
- **Config lives with the project** — `.lsp-mcp.json` defines servers and formatters once, for every agent that works in the repo.

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

## Make your agent verify with LSP

The skill in `skills/lsp-verification/` teaches agents to check edits with lsp-mcp — `lsp_sync_file` → `lsp_diagnostics` → `lsp_autofix` — before falling back to `tsc`, `eslint`, `prettier`, or similar CLI tools, whenever a language server covers the file.

### Claude Code / opencode (`SKILL.md`)

```sh
# user-level
mkdir -p ~/.claude/skills && cp -R skills/lsp-verification ~/.claude/skills/
mkdir -p ~/.config/opencode/skills && cp -R skills/lsp-verification ~/.config/opencode/skills/
# or project-level
mkdir -p .claude/skills && cp -R skills/lsp-verification .claude/skills/
```

### Codex, Pi, and other `AGENTS.md` harnesses

Append `skills/lsp-verification/AGENTS.md` to your project's `AGENTS.md`.

## Releasing

The unscoped `lsp-mcp` name on npm is a security-holding package, so publish under a scope:

1. Set `"name": "@your-scope/lsp-mcp"` in `package.json` (scope must match your npm user or org).
2. `npm login` (or set `NPM_TOKEN` for CI).
3. `npm publish` — the `prepublishOnly` script runs `bun test` and `tsc --noEmit` first.

`publishConfig.access` is already `public` (required for scoped packages). The tarball ships `bin/`, `src/`, `extensions/`, plus README/LICENSE/package.json — no tests, lockfile, or local config.
