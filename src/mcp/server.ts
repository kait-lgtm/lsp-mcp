import { TOOLS, callTool, formatDiagnostics, disconnectAll, type DiagResult } from "./tools.ts";

// Minimal MCP stdio server — JSON-RPC 2.0 over stdin/stdout


// --- MCP JSON-RPC stdio server ---

let msgId = 1;

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function sendResult(id: string | number | null, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id: string | number | null, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleMessage(msg: { jsonrpc: string; id?: string | number; method?: string; params?: unknown }): Promise<void> {
  const { id, method, params } = msg;

  if (!method) return;

  try {
    switch (method) {
      case "initialize": {
        sendResult(id ?? null, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "lsp-mcp", version: "0.1.0" },
        });
        break;
      }

      case "notifications/initialized":
      case "initialized":
        // no-op
        break;

      case "tools/list": {
        sendResult(id ?? null, { tools: TOOLS });
        break;
      }

      case "tools/call": {
        const p = params as { name: string; arguments?: Record<string, unknown> };
        const result = await callTool(p.name, p.arguments ?? {});
        const text = p.name === "lsp_diagnostics"
          ? formatDiagnostics(result as DiagResult)
          : JSON.stringify(result, null, 2);
        sendResult(id ?? null, {
          content: [{ type: "text", text }],
        });
        break;
      }

      case "ping":
        sendResult(id ?? null, {});
        break;

      default:
        if (id !== undefined) {
          sendError(id, -32601, `Method not found: ${method}`);
        }
    }
  } catch (e) {
    const err = e as Error;
    if (id !== undefined) {
      sendError(id, -32603, err.message);
    }
  }
}

// Read line-delimited JSON from stdin
const decoder = new TextDecoder();
let buf = "";

process.stdin.on("data", (chunk: Buffer) => {
  buf += decoder.decode(chunk);
  let nl: number;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      handleMessage(msg).catch((e) => {
        console.error("[mcp-server] unhandled error:", e);
      });
    } catch {
      // ignore malformed JSON
    }
  }
});

process.stdin.on("end", () => {
  disconnectAll();
  process.exit(0);
});

process.stderr.write("[lsp-mcp] server started\n");
