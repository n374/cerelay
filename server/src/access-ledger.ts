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
