import { createHash } from "crypto";
import { join } from "path";
import { homedir } from "os";

export function pathToUri(absPath: string): string {
  return "file://" + absPath;
}

export function uriToPath(uri: string): string {
  return uri.replace(/^file:\/\//, "");
}

export function projectRootHash(root: string): string {
  return createHash("sha1").update(root).digest("hex").slice(0, 16);
}

export function socketDir(): string {
  return join(homedir(), ".lsp-mcp", "run");
}

export function socketPath(root: string): string {
  return join(socketDir(), `${projectRootHash(root)}.sock`);
}

export function pidPath(root: string): string {
  return join(socketDir(), `${projectRootHash(root)}.pid`);
}

export function logDir(): string {
  return join(homedir(), ".lsp-mcp", "logs");
}

export function configPath(): string {
  return join(homedir(), ".lsp-mcp", "config.json");
}
