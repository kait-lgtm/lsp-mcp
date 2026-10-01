// Fake LSP server: answers initialize + textDocument/diagnostic with a payload LARGE
// enough to exceed Bun's 8192-byte socket write cap. Regression fixture for the
// truncated-response hang — a >8KB diagnostics reply must arrive complete.
import { stdin, stdout } from "node:process";

function send(msg) {
  const body = JSON.stringify(msg);
  stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

let buf = "";

stdin.on("data", (chunk) => {
  buf += chunk;
  while (true) {
    const headerEnd = buf.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const match = buf.slice(0, headerEnd).match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      buf = buf.slice(headerEnd + 4);
      continue;
    }
    const length = parseInt(match[1], 10);
    const start = headerEnd + 4;
    if (buf.length < start + length) return;
    const msg = JSON.parse(buf.slice(start, start + length));
    buf = buf.slice(start + length);

    if (msg.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          capabilities: {
            textDocumentSync: 1,
            diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: false },
          },
        },
      });
    } else if (msg.method === "textDocument/diagnostic") {
      // ~4000 diagnostics with long messages → response well over 8KB.
      const items = Array.from({ length: 4000 }, (_, i) => ({
        range: { start: { line: i, character: 0 }, end: { line: i, character: 3 } },
        severity: 1,
        code: i,
        source: "bigfake",
        message: `diagnostic number ${i} with a padded message: ${"y".repeat(120)}`,
      }));
      send({ jsonrpc: "2.0", id: msg.id, result: { kind: "full", items } });
    } else if (msg.id !== undefined) {
      send({ jsonrpc: "2.0", id: msg.id, result: null });
    }
  }
});
