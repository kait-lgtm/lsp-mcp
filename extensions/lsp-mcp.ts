import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TOOLS, type McpTool } from "../src/mcp/tools.ts";

type Response = {
  id?: number;
  result?: { content?: Array<{ type: string; text?: string }> };
  error?: { message?: string };
};

type Pending = {
  resolve: (value: string) => void;
  reject: (reason: Error) => void;
};

class LspMcpClient {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();

  private start(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed && this.child.exitCode === null) return this.child;

    const server = new URL("../bin/lsp-mcp.ts", import.meta.url).pathname;
    const child = spawn(process.env.BUN ?? "bun", ["run", server], { stdio: "pipe" });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.read(chunk));
    child.on("error", (error) => this.failAll(error));
    child.on("exit", (code, signal) => {
      this.child = undefined;
      this.failAll(new Error(`lsp-mcp server exited (${signal ?? code ?? "unknown"})`));
    });
    this.child = child;
    return child;
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      try {
        const response = JSON.parse(line) as Response;
        if (typeof response.id !== "number") continue;
        const pending = this.pending.get(response.id);
        if (!pending) continue;
        this.pending.delete(response.id);
        if (response.error) pending.reject(new Error(response.error.message ?? "lsp-mcp request failed"));
        else pending.resolve(response.result?.content?.map((item) => item.text ?? "").join("\n") ?? JSON.stringify(response.result));
      } catch {
        // Ignore malformed output; the server's protocol is newline-delimited JSON.
      }
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  call(name: string, args: Record<string, unknown>): Promise<string> {
    const child = this.start();
    const id = this.nextId++;
    return new Promise<string>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n", (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    child.stdin.end();
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    ]);
    if (child.exitCode === null) child.kill();
  }
}

function registerTool(pi: ExtensionAPI, client: LspMcpClient, tool: McpTool): void {
  pi.registerTool({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: Type.Unsafe(tool.inputSchema),
    async execute(_toolCallId, params) {
      try {
        const text = await client.call(tool.name, params as Record<string, unknown>);
        return { content: [{ type: "text", text }], details: {} };
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          details: {},
          isError: true,
        };
      }
    },
  });
}

export default function lspMcpExtension(pi: ExtensionAPI) {
  const client = new LspMcpClient();
  for (const tool of TOOLS) registerTool(pi, client, tool);
  pi.on("session_shutdown", async () => client.close());
}
