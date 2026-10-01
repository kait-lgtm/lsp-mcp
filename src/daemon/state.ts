import { createHash } from "crypto";
import type { Diagnostic } from "../shared/lsp-types.ts";
import { pathToUri, uriToPath } from "../shared/paths.ts";
import { languageIdForFile } from "./registry.ts";

export interface ExternalChange {
  timestamp: number;
  kind: "modified" | "created" | "deleted";
  prevHash: string | null;
  newHash: string | null;
  diff: string;
  truncated?: boolean;
}

export interface DocState {
  uri: string;
  path: string;
  version: number;
  text: string;
  languageId: string;
  openOnServers: Set<string>;
  syncedHash: string;
  expectedDiskHash: string;
  externalChanges: ExternalChange[];
}

export interface TaggedDiagnosticEntry {
  serverId: string;
  diagnostics: Diagnostic[];
}

const MAX_QUEUE = 50;

export function hashText(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

export class DaemonState {
  private docs = new Map<string, DocState>();
  private diags = new Map<string, Map<string, Diagnostic[]>>();
  private diagWaiters = new Map<string, Map<string, Array<() => void>>>();

  getDoc(uri: string): DocState | undefined {
    return this.docs.get(uri);
  }

  getDocByPath(path: string): DocState | undefined {
    return this.docs.get(pathToUri(path));
  }

  openDoc(path: string, text: string, serverId: string): DocState {
    const uri = pathToUri(path);
    let doc = this.docs.get(uri);
    if (!doc) {
      const h = hashText(text);
      doc = {
        uri,
        path,
        version: 1,
        text,
        languageId: languageIdForFile(path),
        openOnServers: new Set(),
        syncedHash: h,
        expectedDiskHash: h,
        externalChanges: [],
      };
      this.docs.set(uri, doc);
    }
    doc.openOnServers.add(serverId);
    return doc;
  }

  updateDoc(path: string, text: string): DocState {
    const uri = pathToUri(path);
    const doc = this.docs.get(uri);
    if (!doc) throw new Error(`Document not open: ${path}`);
    const h = hashText(text);
    doc.text = text;
    doc.version++;
    doc.syncedHash = h;
    doc.expectedDiskHash = h;
    return doc;
  }

  /** Called by edits.ts just before writing a file — marks the hash we expect the watcher to see. */
  setExpectedDiskHash(path: string, hash: string): void {
    const doc = this.docs.get(pathToUri(path));
    if (doc) doc.expectedDiskHash = hash;
  }

  /** Returns true if the watcher event is our own write. */
  isOwnWrite(path: string, diskHash: string): boolean {
    const doc = this.docs.get(pathToUri(path));
    if (!doc) return false;
    return doc.expectedDiskHash === diskHash;
  }

  recordExternalChange(path: string, change: ExternalChange): void {
    const uri = pathToUri(path);
    let doc = this.docs.get(uri);
    if (!doc) {
      // File not yet tracked — create a minimal entry so we can queue the event
      const h = change.newHash ?? "";
      doc = {
        uri,
        path,
        version: 0,
        text: "",
        languageId: languageIdForFile(path),
        openOnServers: new Set(),
        syncedHash: h,
        expectedDiskHash: h,
        externalChanges: [],
      };
      this.docs.set(uri, doc);
    }

    if (doc.externalChanges.length >= MAX_QUEUE) {
      doc.externalChanges.shift();
      // Mark the oldest surviving entry as arriving after a truncation
      if (doc.externalChanges[0]) doc.externalChanges[0].truncated = true;
    }
    doc.externalChanges.push(change);
  }

  getExternalChanges(uri?: string): Array<{ uri: string; path: string; changes: ExternalChange[] }> {
    const result: Array<{ uri: string; path: string; changes: ExternalChange[] }> = [];
    const entries = uri ? [this.docs.get(uri)] : [...this.docs.values()];
    for (const doc of entries) {
      if (!doc || doc.externalChanges.length === 0) continue;
      result.push({ uri: doc.uri, path: doc.path, changes: doc.externalChanges });
    }
    return result;
  }

  clearExternalChanges(uri?: string): void {
    if (uri) {
      const doc = this.docs.get(uri);
      if (doc) doc.externalChanges = [];
    } else {
      for (const doc of this.docs.values()) doc.externalChanges = [];
    }
  }

  hasPendingChanges(uri: string): boolean {
    return (this.docs.get(uri)?.externalChanges.length ?? 0) > 0;
  }

  pendingChangeSummary(): { filesWithPendingChanges: number; totalPendingChanges: number } {
    let files = 0;
    let total = 0;
    for (const doc of this.docs.values()) {
      if (doc.externalChanges.length > 0) {
        files++;
        total += doc.externalChanges.length;
      }
    }
    return { filesWithPendingChanges: files, totalPendingChanges: total };
  }

  allDocs(): DocState[] {
    return [...this.docs.values()];
  }

  setDiagnostics(uri: string, serverId: string, diagnostics: Diagnostic[]): void {
    if (!this.diags.has(uri)) this.diags.set(uri, new Map());
    this.diags.get(uri)!.set(serverId, diagnostics);
    const uriWaiters = this.diagWaiters.get(uri);
    if (uriWaiters) {
      const serverWaiters = uriWaiters.get(serverId);
      if (serverWaiters) {
        for (const cb of serverWaiters) cb();
        uriWaiters.delete(serverId);
      }
    }
  }

  getDiagnostics(uri?: string): Array<{ uri: string; serverId: string; diagnostics: Diagnostic[] }> {
    const result: Array<{ uri: string; serverId: string; diagnostics: Diagnostic[] }> = [];
    const uris = uri ? [uri] : [...this.diags.keys()];
    for (const u of uris) {
      const byServer = this.diags.get(u);
      if (!byServer) continue;
      for (const [serverId, diagnostics] of byServer) {
        result.push({ uri: u, serverId, diagnostics });
      }
    }
    return result;
  }

  waitForDiagnostics(uri: string, serverId: string, timeoutMs: number): Promise<void> {
    if (this.diags.get(uri)?.has(serverId)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      if (!this.diagWaiters.has(uri)) this.diagWaiters.set(uri, new Map());
      const uriWaiters = this.diagWaiters.get(uri)!;
      if (!uriWaiters.has(serverId)) uriWaiters.set(serverId, []);
      uriWaiters.get(serverId)!.push(resolve);
      setTimeout(resolve, timeoutMs);
    });
  }

  openDocCount(): number {
    return this.docs.size;
  }

  diagCount(): number {
    let count = 0;
    for (const byServer of this.diags.values()) {
      for (const diags of byServer.values()) count += diags.length;
    }
    return count;
  }
}
