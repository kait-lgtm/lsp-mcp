import { existsSync, mkdirSync, renameSync, writeFileSync, readFileSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { randomBytes } from "crypto";
import type { WorkspaceEdit, TextEdit } from "../shared/lsp-types.ts";
import { uriToPath, pathToUri } from "../shared/paths.ts";
import { hashText } from "./state.ts";
import type { DaemonState } from "./state.ts";
import type { Supervisor } from "./supervisor.ts";

export interface ApplyResult {
  changedFiles: { path: string; edits: number }[];
  totalEdits: number;
}

export async function applyWorkspaceEdit(
  edit: WorkspaceEdit,
  supervisor: Supervisor,
  docState: DaemonState,
): Promise<ApplyResult> {
  const byUri = new Map<string, TextEdit[]>();

  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      byUri.set(change.textDocument.uri, change.edits);
    }
  } else if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) {
      byUri.set(uri, edits);
    }
  }

  const changedFiles: { path: string; edits: number }[] = [];

  for (const [uri, edits] of byUri) {
    const path = uriToPath(uri);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }

    const applied = applyEdits(text, edits);
    const newHash = hashText(applied);
    // Mark as our own write before touching disk so the watcher ignores the event
    docState.setExpectedDiskHash(path, newHash);
    atomicWrite(path, applied);
    changedFiles.push({ path, edits: edits.length });

    // Sync LSP state; also updates doc.syncedHash + doc.expectedDiskHash
    await supervisor.syncDocToDisk(path, applied);
  }

  return { changedFiles, totalEdits: changedFiles.reduce((s, f) => s + f.edits, 0) };
}

export function applyEdits(text: string, edits: TextEdit[]): string {
  const lines = text.split("\n");
  const sorted = [...edits].sort((a, b) => {
    const lineDiff = b.range.start.line - a.range.start.line;
    if (lineDiff !== 0) return lineDiff;
    return b.range.start.character - a.range.start.character;
  });

  for (const edit of sorted) {
    const startOffset = lineCharToOffset(lines, edit.range.start.line, edit.range.start.character);
    const endOffset = lineCharToOffset(lines, edit.range.end.line, edit.range.end.character);
    text = text.slice(0, startOffset) + edit.newText + text.slice(endOffset);
  }

  return text;
}

function lineCharToOffset(lines: string[], line: number, character: number): number {
  let offset = 0;
  for (let i = 0; i < Math.min(line, lines.length - 1); i++) {
    offset += lines[i].length + 1;
  }
  return offset + Math.min(character, (lines[line] ?? "").length);
}

export function atomicWrite(path: string, content: string): void {
  const dir = dirname(path);
  const tmp = join(dir, `.lsp-mcp-tmp-${randomBytes(4).toString("hex")}`);
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, path);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
    throw e;
  }
}
