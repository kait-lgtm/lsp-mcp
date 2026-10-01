import { describe, test, expect } from "bun:test";
import { ContentLengthDecoder, encodeContentLength, NdJsonDecoder, encodeNdJson, makeRequest, makeResult, isRequest, isResponse, PendingRequests } from "../src/shared/jsonrpc.ts";
import { normalizePosition } from "../src/shared/positions.ts";
import { pathToUri, uriToPath, projectRootHash } from "../src/shared/paths.ts";
import { isServerStalled } from "../src/daemon/supervisor.ts";

describe("ContentLengthDecoder", () => {
  test("round-trips a single message", () => {
    const msg = { jsonrpc: "2.0" as const, id: 1, method: "test", params: { x: 42 } };
    const dec = new ContentLengthDecoder();
    const msgs = dec.push(encodeContentLength(msg));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual(msg);
  });

  test("handles two messages in one chunk", () => {
    const m1 = { jsonrpc: "2.0", id: 1, method: "a" };
    const m2 = { jsonrpc: "2.0", id: 2, method: "b" };
    const dec = new ContentLengthDecoder();
    const combined = Buffer.concat([encodeContentLength(m1), encodeContentLength(m2)]);
    const msgs = dec.push(combined);
    expect(msgs).toHaveLength(2);
  });

  test("handles split chunks", () => {
    const msg = { jsonrpc: "2.0" as const, id: 1, method: "test", params: { data: "hello world" } };
    const encoded = encodeContentLength(msg);
    const dec = new ContentLengthDecoder();
    const half = Math.floor(encoded.length / 2);
    const partial = dec.push(encoded.slice(0, half));
    expect(partial).toHaveLength(0);
    const full = dec.push(encoded.slice(half));
    expect(full).toHaveLength(1);
    expect(full[0]).toEqual(msg);
  });
});

describe("NdJsonDecoder", () => {
  test("decodes newline-delimited messages", () => {
    const dec = new NdJsonDecoder();
    const m1 = makeRequest(1, "ping");
    const m2 = makeResult(2, { ok: true });
    const combined = encodeNdJson(m1).toString() + encodeNdJson(m2).toString();
    const msgs = dec.push(combined);
    expect(msgs).toHaveLength(2);
    expect(isRequest(msgs[0])).toBe(true);
    expect(isResponse(msgs[1])).toBe(true);
  });
});

describe("normalizePosition", () => {
  test("passes through 0-indexed", () => {
    expect(normalizePosition({ line: 3, character: 5 })).toEqual({ line: 3, character: 5 });
  });

  test("converts 1-indexed to 0-indexed", () => {
    expect(normalizePosition({ line1: 4, col1: 6 })).toEqual({ line: 3, character: 5 });
  });
});

describe("path utils", () => {
  test("pathToUri / uriToPath round-trip", () => {
    const p = "/Users/foo/bar/baz.ts";
    expect(uriToPath(pathToUri(p))).toBe(p);
  });

  test("projectRootHash is stable", () => {
    const h1 = projectRootHash("/foo/bar");
    const h2 = projectRootHash("/foo/bar");
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(16);
  });
});

describe("PendingRequests", () => {
  test("size reflects in-flight requests", () => {
    const pr = new PendingRequests();
    expect(pr.size).toBe(0);
    pr.register(pr.nextRequestId());
    pr.register(pr.nextRequestId());
    expect(pr.size).toBe(2);
  });
});

describe("isServerStalled", () => {
  const base = { state: "ready" as const, idleMs: 200000, stallMs: 180000, pendingCount: 0, hasOpenDocs: true, allDocsHaveDiagnostics: false };

  test("kills a ready server that never delivered diagnostics for its open docs", () => {
    expect(isServerStalled(base)).toBe(true);
  });

  test("does not kill while within the stall window", () => {
    expect(isServerStalled({ ...base, idleMs: 10000 })).toBe(false);
  });

  test("does not kill a server with open docs that already delivered diagnostics (idle is healthy)", () => {
    expect(isServerStalled({ ...base, allDocsHaveDiagnostics: true })).toBe(false);
  });

  test("does not kill a server with no open docs and no pending requests", () => {
    expect(isServerStalled({ ...base, hasOpenDocs: false })).toBe(false);
  });

  test("kills when a request has been unanswered beyond the stall window", () => {
    expect(isServerStalled({ ...base, allDocsHaveDiagnostics: true, pendingCount: 1 })).toBe(true);
  });

  test("kills a server stuck in starting state", () => {
    expect(isServerStalled({ ...base, state: "starting", hasOpenDocs: false })).toBe(true);
  });

  test("never kills stopped or crashed servers (crash loop owns them)", () => {
    expect(isServerStalled({ ...base, state: "stopped" })).toBe(false);
    expect(isServerStalled({ ...base, state: "crashed" })).toBe(false);
  });
});
