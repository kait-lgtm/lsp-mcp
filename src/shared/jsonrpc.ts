// JSON-RPC 2.0 framing and dispatch — used for both LSP (Content-Length) and IPC (newline-delimited)

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return "id" in msg && "method" in msg;
}

export function isNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
  return !("id" in msg) && "method" in msg;
}

export function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return "id" in msg && !("method" in msg);
}

export function makeRequest(id: string | number, method: string, params?: unknown): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) };
}

export function makeNotification(method: string, params?: unknown): JsonRpcNotification {
  return { jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) };
}

export function makeResult(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

export function makeError(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

// --- Content-Length framing (LSP protocol) ---

export function encodeContentLength(msg: unknown): Uint8Array {
  const body = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
  return Buffer.from(header + body, "utf8");
}

export class ContentLengthDecoder {
  private buf = Buffer.alloc(0);

  push(chunk: Uint8Array): JsonRpcMessage[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const msgs: JsonRpcMessage[] = [];
    while (true) {
      const msg = this.tryParse();
      if (!msg) break;
      msgs.push(msg);
    }
    return msgs;
  }

  private tryParse(): JsonRpcMessage | null {
    const headerEnd = this.buf.indexOf("\r\n\r\n");
    if (headerEnd === -1) return null;
    const header = this.buf.slice(0, headerEnd).toString("utf8");
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      // Skip malformed header — advance past it
      this.buf = this.buf.slice(headerEnd + 4);
      return null;
    }
    const length = parseInt(match[1], 10);
    const start = headerEnd + 4;
    if (this.buf.length < start + length) return null;
    const body = this.buf.slice(start, start + length).toString("utf8");
    this.buf = this.buf.slice(start + length);
    return JSON.parse(body) as JsonRpcMessage;
  }
}

// --- Newline-delimited framing (IPC protocol) ---

export function encodeNdJson(msg: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(msg) + "\n", "utf8");
}

export class NdJsonDecoder {
  private buf = "";

  push(chunk: string | Uint8Array): JsonRpcMessage[] {
    this.buf += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    const msgs: JsonRpcMessage[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) {
        try {
          msgs.push(JSON.parse(line) as JsonRpcMessage);
        } catch {
          // skip malformed line
        }
      }
    }
    return msgs;
  }
}

// --- Pending request tracker ---

export class PendingRequests {
  private map = new Map<string | number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 1;

  get size(): number {
    return this.map.size;
  }

  nextRequestId(): number {
    return this.nextId++;
  }

  register(id: string | number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.map.set(id, { resolve, reject });
    });
  }

  settle(response: JsonRpcResponse): void {
    const pending = this.map.get(response.id as string | number);
    if (!pending) return;
    this.map.delete(response.id as string | number);
    if (response.error) {
      pending.reject(new Error(`JSON-RPC error ${response.error.code}: ${response.error.message}`));
    } else {
      pending.resolve(response.result);
    }
  }

  rejectAll(reason: string): void {
    for (const { reject } of this.map.values()) {
      reject(new Error(reason));
    }
    this.map.clear();
  }
}
