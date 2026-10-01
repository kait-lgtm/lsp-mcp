// Fake LSP server: advertises pull diagnostics (diagnosticProvider) but NEVER
// answers textDocument/diagnostic. Regression fixture for the diagnostics hang —
// lsp_diagnostics must time out instead of blocking forever.
import { stdin, stdout } from "node:process";

function send(msg) {
  const body = JSON.stringify(msg);
  stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

let buf = "";

function handleMsg(msg) {
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
    // Deliberate hang — never respond, neither result nor error.
  } else if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, result: null });
  }
}

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
    handleMsg(JSON.parse(buf.slice(start, start + length)));
    buf = buf.slice(start + length);
  }
});
