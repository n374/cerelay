import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { dirname as pathDirname } from "node:path/posix";
import { createLogger } from "./logger.js";

const log = createLogger("access-ledger");

export interface AccessLedgerData {
  version: 1;
  deviceId: string;
  revision: number;
  entries: Record<string, AccessLedgerEntry>;
}

export type AccessLedgerEntry =
  | { kind: "file"; lastAccessedAt: number }
  | { kind: "dir"; lastAccessedAt: number; readdirObserved: boolean }
  | { kind: "missing"; lastAccessedAt: number };

export class AccessLedgerRuntime {
  private entries = new Map<string, AccessLedgerEntry>();
  private missingSorted: string[] = [];
  private allPathsSorted: string[] = [];
  private dirsReaddirObserved = new Set<string>();
  private revision = 0;

  constructor(public readonly deviceId: string) {}

  toJSON(): AccessLedgerData {
    return {
      version: 1,
      deviceId: this.deviceId,
      revision: this.revision,
      entries: Object.fromEntries(this.entries),
    };
  }

  setRevision(revision: number): void {
    this.revision = revision;
  }

  allPathsSortedSnapshot(): string[] {
    return [...this.allPathsSorted];
  }

  missingSortedSnapshot(): string[] {
    return [...this.missingSorted];
  }

  dirsReaddirObservedSnapshot(): Set<string> {
    return new Set(this.dirsReaddirObserved);
  }

  upsertFilePresent(path: string, lastAccessedAt: number): void {
    const existed = this.entries.has(path);
    const prev = this.entries.get(path);
    if (prev?.kind === "dir") this.dirsReaddirObserved.delete(path);
    if (prev?.kind === "missing") this.removeFromSorted(this.missingSorted, path);
    this.entries.set(path, { kind: "file", lastAccessedAt });
    if (!existed) this.insertSorted(this.allPathsSorted, path);
  }

  upsertDirPresent(path: string, lastAccessedAt: number, readdirObserved: boolean): void {
    const prev = this.entries.get(path);
    const existed = !!prev;
    const prevReaddir = prev?.kind === "dir" ? prev.readdirObserved : false;
    const finalReaddir = prevReaddir || readdirObserved;
    if (prev?.kind === "missing") this.removeFromSorted(this.missingSorted, path);
    this.entries.set(path, { kind: "dir", lastAccessedAt, readdirObserved: finalReaddir });
    if (!existed) this.insertSorted(this.allPathsSorted, path);
    if (finalReaddir) this.dirsReaddirObserved.add(path);
  }

  removeFilePresent(path: string): void {
    if (this.entries.delete(path)) {
      this.removeFromSorted(this.allPathsSorted, path);
      this.removeFromSorted(this.missingSorted, path);
      this.dirsReaddirObserved.delete(path);
    }
  }

  upsertMissing(ancestor: string, lastAccessedAt: number): void {
    if (this.hasMissingAncestorOf(ancestor)) {
      const existing = this.entries.get(ancestor);
      if (existing?.kind === "missing" && lastAccessedAt > existing.lastAccessedAt) {
        this.entries.set(ancestor, { kind: "missing", lastAccessedAt });
      }
      return;
    }

    const prefix = `${ancestor}/`;
    let idx = lowerBound(this.missingSorted, prefix);
    const toAbsorb: string[] = [];
    while (idx < this.missingSorted.length && this.missingSorted[idx].startsWith(prefix)) {
      toAbsorb.push(this.missingSorted[idx]);
      idx += 1;
    }
    for (const absorbed of toAbsorb) {
      this.entries.delete(absorbed);
      this.removeFromSorted(this.missingSorted, absorbed);
      this.removeFromSorted(this.allPathsSorted, absorbed);
    }

    const prev = this.entries.get(ancestor);
    const existed = !!prev;
    if (prev?.kind === "dir") this.dirsReaddirObserved.delete(ancestor);
    this.entries.set(ancestor, { kind: "missing", lastAccessedAt });
    if (!existed) this.insertSorted(this.allPathsSorted, ancestor);
    this.insertSorted(this.missingSorted, ancestor);
  }

  invalidateMissingPrefixes(path: string): void {
    let current = path;
    while (current !== "/" && current !== "") {
      if (this.entries.get(current)?.kind === "missing") {
        this.entries.delete(current);
        this.removeFromSorted(this.missingSorted, current);
        this.removeFromSorted(this.allPathsSorted, current);
      }
      const parent = pathDirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  removeDirSubtree(dirPath: string): void {
    const prefix = `${dirPath}/`;
    let idx = lowerBound(this.allPathsSorted, dirPath);
    const toDelete: string[] = [];
    while (idx < this.allPathsSorted.length) {
      const candidate = this.allPathsSorted[idx];
      if (candidate !== dirPath && !candidate.startsWith(prefix)) break;
      toDelete.push(candidate);
      idx += 1;
    }
    for (const candidate of toDelete) {
      this.entries.delete(candidate);
      this.removeFromSorted(this.allPathsSorted, candidate);
      this.removeFromSorted(this.missingSorted, candidate);
      this.dirsReaddirObserved.delete(candidate);
    }
  }

  renameSubtree(oldPath: string, newPath: string): void {
    const prefix = `${oldPath}/`;
    let idx = lowerBound(this.allPathsSorted, oldPath);
    const toMove: Array<{ from: string; to: string; entry: AccessLedgerEntry }> = [];
    while (idx < this.allPathsSorted.length) {
      const candidate = this.allPathsSorted[idx];
      let target: string | null = null;
      if (candidate === oldPath) target = newPath;
      else if (candidate.startsWith(prefix)) target = newPath + candidate.slice(oldPath.length);
      else break;

      const entry = this.entries.get(candidate);
      if (entry) toMove.push({ from: candidate, to: target, entry });
      idx += 1;
    }

    for (const { from } of toMove) {
      this.entries.delete(from);
      this.removeFromSorted(this.allPathsSorted, from);
      this.removeFromSorted(this.missingSorted, from);
      this.dirsReaddirObserved.delete(from);
    }
    for (const { to, entry } of toMove) {
      this.entries.set(to, entry);
      this.insertSorted(this.allPathsSorted, to);
      if (entry.kind === "missing") this.insertSorted(this.missingSorted, to);
      if (entry.kind === "dir" && entry.readdirObserved) this.dirsReaddirObserved.add(to);
    }
  }

  touchIfPresent(path: string, lastAccessedAt: number): void {
    const entry = this.entries.get(path);
    if (!entry) return;
    if (entry.kind === "file") {
      this.entries.set(path, { kind: "file", lastAccessedAt });
    } else if (entry.kind === "dir") {
      this.entries.set(path, {
        kind: "dir",
        lastAccessedAt,
        readdirObserved: entry.readdirObserved,
      });
    } else {
      this.entries.set(path, { kind: "missing", lastAccessedAt });
    }
  }

  runAging(now: number, ageMs: number): void {
    const cutoff = now - ageMs;
    const toDelete: string[] = [];
    for (const candidate of this.missingSorted) {
      const entry = this.entries.get(candidate);
      if (entry?.kind === "missing" && entry.lastAccessedAt < cutoff) {
        toDelete.push(candidate);
      }
    }
    for (const candidate of toDelete) {
      this.entries.delete(candidate);
      this.removeFromSorted(this.missingSorted, candidate);
      this.removeFromSorted(this.allPathsSorted, candidate);
    }
  }

  bumpRevision(): void {
    this.revision += 1;
  }

  private insertSorted(arr: string[], item: string): void {
    const idx = lowerBound(arr, item);
    if (arr[idx] !== item) arr.splice(idx, 0, item);
  }

  private removeFromSorted(arr: string[], item: string): void {
    const idx = lowerBound(arr, item);
    if (arr[idx] === item) arr.splice(idx, 1);
  }

  private hasMissingAncestorOf(path: string): boolean {
    let current = path;
    while (current !== "/" && current !== "") {
      const parent = pathDirname(current);
      if (parent === current) break;
      if (this.entries.get(parent)?.kind === "missing") return true;
      current = parent;
    }
    return false;
  }
}

export interface AccessLedgerStoreOptions {
  dataDir: string;
}

export class AccessLedgerStore {
  private readonly mutexChains = new Map<string, Promise<void>>();

  constructor(private readonly options: AccessLedgerStoreOptions) {}

  rootDir(): string {
    return path.join(this.options.dataDir, "access-ledger");
  }

  async load(deviceId: string): Promise<AccessLedgerRuntime> {
    const runtime = new AccessLedgerRuntime(deviceId);
    try {
      const raw = await readFile(this.ledgerPath(deviceId), "utf8");
      const data = JSON.parse(raw) as AccessLedgerData;
      if (data?.version !== 1 || data.deviceId !== deviceId || !data.entries) return runtime;
      for (const [entryPath, entry] of Object.entries(data.entries)) {
        if (entry.kind === "file") {
          runtime.upsertFilePresent(entryPath, entry.lastAccessedAt);
        } else if (entry.kind === "dir") {
          runtime.upsertDirPresent(entryPath, entry.lastAccessedAt, entry.readdirObserved);
        } else if (entry.kind === "missing") {
          runtime.upsertMissing(entryPath, entry.lastAccessedAt);
        }
      }
      runtime.setRevision(data.revision);
    } catch (err) {
      log.debug("ledger load returned empty runtime", {
        deviceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return runtime;
  }

  async persist(runtime: AccessLedgerRuntime): Promise<void> {
    return this.withDeviceLock(runtime.deviceId, async () => {
      const filePath = this.ledgerPath(runtime.deviceId);
      await mkdir(path.dirname(filePath), { recursive: true });
      const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random()
        .toString(16)
        .slice(2)}`;
      const data = JSON.stringify(runtime.toJSON(), null, 2) + "\n";
      await writeFile(tmpPath, data, "utf8");
      await rename(tmpPath, filePath);
    });
  }

  private async withDeviceLock<T>(deviceId: string, fn: () => Promise<T>): Promise<T> {
    const key = sanitizeDeviceId(deviceId);
    const previous = this.mutexChains.get(key) ?? Promise.resolve();
    let releaseSelf!: () => void;
    const self = new Promise<void>((resolve) => {
      releaseSelf = resolve;
    });
    const newTail = previous.then(() => self);
    this.mutexChains.set(key, newTail);
    try {
      await previous.catch(() => undefined);
      return await fn();
    } finally {
      releaseSelf();
      if (this.mutexChains.get(key) === newTail) {
        this.mutexChains.delete(key);
      }
    }
  }

  private ledgerPath(deviceId: string): string {
    return path.join(this.deviceDir(deviceId), "ledger.json");
  }

  private deviceDir(deviceId: string): string {
    return path.join(this.rootDir(), sanitizeDeviceId(deviceId));
  }
}

function sanitizeDeviceId(deviceId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(deviceId) || deviceId.length > 128) {
    throw new Error(`invalid deviceId: ${deviceId}`);
  }
  return deviceId;
}

export function lowerBound(arr: string[], item: string): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < item) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
