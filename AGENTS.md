# AGENTS.md

Guidance for coding agents working in this repository.

## What this is

`lsp-mcp` runs a persistent LSP daemon per project root and exposes it as MCP tools, a CLI, and a Pi extension. Runtime is Bun-only (the daemon uses Bun sockets and `Bun.spawn`).

## Commands

- Tests: `bun test` (e2e tests need `tsgo` on `PATH`; they self-skip without it)
- Typecheck: `bun run typecheck`
- Run MCP server: `bun run bin/lsp-mcp.ts`
- Pack check: `npm pack --dry-run`

Run both `bun test` and `bun run typecheck` before declaring work done.

## Layout

- `src/shared/` — JSON-RPC framing, protocol param/result types, path and position helpers
- `src/daemon/` — daemon entry (`main.ts`), server lifecycle (`supervisor.ts`), document/diagnostic state (`state.ts`), workspace edits (`edits.ts`), server registry (`registry.ts`)
- `src/mcp/` — stdio MCP server, tool schemas (`tools.ts`), daemon client
- `extensions/` — Pi extension; registers the same tools from `src/mcp/tools.ts`
- `test/` — Bun tests and fixtures, including fake LSP servers for timeout/payload cases

## Conventions

- Strict TypeScript; keep `bunx tsc --noEmit` clean.
- Do not add comments unless they explain a non-obvious constraint (existing code follows this).
- File-based tools accept `file: string | string[]`. Batch responses: diagnostics stay a flat list; symbols/format/sync return `{ results: [...] }`; autofix returns aggregate counts plus per-file `results`. Single-string input keeps the original response shape.
- Mutating handlers must check `checkMutationGuard`; blocked responses use `error: "external_changes_pending"`.
- All daemon socket writes go through `writeAll` (Bun drops writes over 8192 bytes).
- New server definitions go in `src/daemon/registry.ts`; per-project behavior belongs in `.lsp-mcp.json` (`servers`, `formatters`, `formatOrder`, `serverEnv`).

## Verification

Use the repo's own tooling: `bun test` + `bun run typecheck`. For agent-facing usage guidance shipped to consumers, see `skills/lsp-verification/`.
