import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { join } from "path";
import { DaemonClient } from "../src/mcp/client.ts";
import { Methods } from "../src/shared/protocol.ts";
import { socketPath, pidPath } from "../src/shared/paths.ts";
import { resolveProjectRoot } from "../src/daemon/registry.ts";

const FIXTURE = join(import.meta.dir, "fixtures/ts-project");
const INDEX_TS = join(FIXTURE, "src/index.ts");
const UTILS_TS = join(FIXTURE, "src/utils.ts");
const SERVER = "tsgo";

const hasTsgo = Bun.spawnSync(["which", "tsgo"]).exitCode === 0;

if (!hasTsgo) {
  console.warn("tsgo not found — skipping e2e tests");
}

let client: DaemonClient;
let root: string;

const itIf = (condition: boolean) => condition ? test : test.skip;

beforeAll(async () => {
  if (!hasTsgo) return;
  root = resolveProjectRoot(FIXTURE, SERVER);
  client = new DaemonClient(FIXTURE, SERVER);

  const startResult = await client.call(Methods.start, { projectPath: FIXTURE, server: SERVER });
  expect((startResult as { serverId: string }).serverId).toBe(SERVER);
}, 30000);

afterAll(async () => {
  if (!client) return;
  try { await client.call(Methods.stopAll, {}); } catch {}
  client.disconnect();
  try { unlinkSync(socketPath(root)); } catch {}
  try { unlinkSync(pidPath(root)); } catch {}
});

describe("lsp_status", () => {
  itIf(hasTsgo)("returns daemon info after start", async () => {
    const result = await client.call(Methods.status, {}) as { daemons: Array<{ servers: Array<{ serverId: string; state: string }> }> };
    expect(result.daemons.length).toBeGreaterThan(0);
    const server = result.daemons[0].servers.find((s) => s.serverId === SERVER);
    expect(server?.state).toBe("ready");
  });
});

describe("lsp_diagnostics", () => {
  itIf(hasTsgo)("returns diagnostics for a file", async () => {
    const result = await client.call(Methods.diagnostics, {
      projectPath: FIXTURE,
      file: INDEX_TS,
      timeoutMs: 15000,
    }) as { diagnostics: Array<{ message: string; severity: number }> };

    expect(Array.isArray(result.diagnostics)).toBe(true);
  }, 20000);

  itIf(hasTsgo)("returns cached all-files diagnostics", async () => {
    const result = await client.call(Methods.diagnostics, { projectPath: FIXTURE }) as { diagnostics: unknown[] };
    expect(Array.isArray(result.diagnostics)).toBe(true);
  });

  itIf(hasTsgo)("returns within timeout when a pull server never answers", async () => {
    // Start a fake server (under the "eslint" def so languageIds match tsx) that
    // advertises pull diagnostics but never responds to textDocument/diagnostic.
    await client.call(Methods.start, {
      projectPath: FIXTURE,
      server: "eslint",
      cmdOverride: ["bun", "run", join(import.meta.dir, "fixtures/hang-pull/server.mjs")],
    });

    const start = Date.now();
    const result = await client.call(Methods.diagnostics, {
      projectPath: FIXTURE,
      file: INDEX_TS,
      timeoutMs: 4000,
    }) as { diagnostics: unknown[]; pending?: string[] };

    const elapsed = Date.now() - start;
    // Must resolve (with the unresponsive server listed as pending) instead of hanging forever.
    expect(elapsed).toBeLessThan(15000);
    expect(Array.isArray(result.diagnostics)).toBe(true);
    expect(result.pending).toContain("eslint");
  }, 20000);

  itIf(hasTsgo)("delivers responses larger than 8KB in full (Bun socket write cap)", async () => {
    // A pull response with ~4000 diagnostics is well over Bun's 8192-byte per-write cap.
    // The full payload must reach the client — a truncated line would hang forever.
    await client.call(Methods.start, {
      projectPath: FIXTURE,
      server: "gopls",
      cmdOverride: ["bun", "run", join(import.meta.dir, "fixtures/big-payload/server.mjs")],
    });

    const result = await client.call(Methods.diagnostics, {
      projectPath: FIXTURE,
      file: INDEX_TS,
      timeoutMs: 15000,
    }) as { diagnostics: Array<{ code?: string | number }> };

    expect(result.diagnostics.length).toBe(4000);
    const codes = new Set(result.diagnostics.map((d) => d.code));
    expect(codes.has(3999)).toBe(true);
  }, 20000);
});

describe("lsp_hover", () => {
  itIf(hasTsgo)("returns hover info for a symbol", async () => {
    const result = await client.call(Methods.hover, {
      projectPath: FIXTURE,
      file: INDEX_TS,
      position: { line1: 1, col1: 17 },
    }) as { hover: unknown };
    expect(result).toBeDefined();
  }, 10000);
});

describe("lsp_document_symbols", () => {
  itIf(hasTsgo)("returns symbols for index.ts", async () => {
    const result = await client.call(Methods.documentSymbols, {
      projectPath: FIXTURE,
      file: INDEX_TS,
    }) as { symbols: Array<{ name: string }> };
    expect(Array.isArray(result.symbols)).toBe(true);
    expect(result.symbols.map((s) => s.name)).toContain("greet");
  }, 10000);
});

describe("lsp_sync_file", () => {
  itIf(hasTsgo)("syncs a file without error", async () => {
    const result = await client.call(Methods.syncFile, {
      projectPath: FIXTURE,
      file: INDEX_TS,
    }) as { version: number };
    expect(typeof result.version).toBe("number");
    expect(result.version).toBeGreaterThan(0);
  }, 10000);

  itIf(hasTsgo)("syncs multiple files in one call", async () => {
    const result = await client.call(Methods.syncFile, {
      projectPath: FIXTURE,
      file: [INDEX_TS, UTILS_TS],
    }) as { results: Array<{ file: string; version: number }> };
    expect(result.results).toHaveLength(2);
    expect(result.results.map((r) => r.file).sort()).toEqual([INDEX_TS, UTILS_TS].sort());
    for (const r of result.results) expect(r.version).toBeGreaterThan(0);
  }, 10000);
});

describe("lsp batch (multiple files per call)", () => {
  itIf(hasTsgo)("collects diagnostics for multiple files", async () => {
    const result = await client.call(Methods.diagnostics, {
      projectPath: FIXTURE,
      file: [INDEX_TS, UTILS_TS],
      timeoutMs: 15000,
    }) as { diagnostics: Array<{ file: string }> };

    expect(Array.isArray(result.diagnostics)).toBe(true);
    for (const d of result.diagnostics) expect([INDEX_TS, UTILS_TS]).toContain(d.file);
    // utils.ts imports "./index.ts" without allowImportingTsExtensions → one error expected there.
    expect(result.diagnostics.some((d) => d.file === UTILS_TS)).toBe(true);
  }, 25000);

  itIf(hasTsgo)("returns symbols per file for multiple files", async () => {
    const result = await client.call(Methods.documentSymbols, {
      projectPath: FIXTURE,
      file: [INDEX_TS, UTILS_TS],
    }) as { results: Array<{ file: string; symbols: Array<{ name: string }> }> };

    expect(result.results).toHaveLength(2);
    const byFile = new Map(result.results.map((r) => [r.file, r.symbols.map((s) => s.name)]));
    expect(byFile.get(INDEX_TS)).toContain("greet");
    expect(byFile.get(UTILS_TS)).toContain("greetMany");
  }, 15000);
});
