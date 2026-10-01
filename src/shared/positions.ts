import type { Position, Range } from "./lsp-types.ts";

// Input position: either 0-indexed LSP native or 1-indexed human-friendly
export interface PositionInput {
  line?: number;
  character?: number;
  line1?: number;
  col1?: number;
}

export function normalizePosition(p: PositionInput): Position {
  if (p.line1 !== undefined) {
    return { line: p.line1 - 1, character: (p.col1 ?? 1) - 1 };
  }
  return { line: p.line ?? 0, character: p.character ?? 0 };
}

export function normalizeRange(r: { start: PositionInput; end: PositionInput }): Range {
  return { start: normalizePosition(r.start), end: normalizePosition(r.end) };
}

export function positionToHuman(p: Position): string {
  return `${p.line + 1}:${p.character + 1}`;
}
