import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, rm as rmPath, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { MAX_FILE_BYTES } from "../src/cache-sync.js";
import { CacheWatcher } from "../src/cache-watcher.js";
import type { CacheTaskChange } from "../src/protocol.js";

class FakeWatchHandle {
  private allListener: ((eventName: "add" | "addDir" | "change" | "unlink" | "unlinkDir", filePath: string) => void) | null = null;
  private errorListener: ((error: unknown) => void) | null = null;
  closed = false;

  on(event: "all" | "error", listener: ((...args: never[]) => void)): this {
    if (event === "all") {
      this.allListener = listener as typeof this.allListener;
    } else {
      this.errorListener = listener as typeof this.errorListener;
    }
    return this;
  }

  emitAll(eventName: "add" | "addDir" | "change" | "unlink" | "unlinkDir", filePath: string): void {
    this.allListener?.(eventName, filePath);
  }

  emitError(error: unknown): void {
    this.errorListener?.(error);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeWatchBackend {
  readonly handle = new FakeWatchHandle();

  async watch(): Promise<FakeWatchHandle> {
    return this.handle;
  }
}

async function makeTempHome() {
  const home = await mkdtemp(path.join(tmpdir(), "cerelay-watcher-"));
  return { home, cleanup: () => rm(home, { recursive: true, force: true }) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("CacheWatcher debounce 合并重复 fs 事件", async (t) => {
  const { home, cleanup } = await makeTempHome();
  t.after(cleanup);
  const backend = new FakeWatchBackend();
  const changes: CacheTaskChange[][] = [];
  const filePath = path.join(home, ".claude", "settings.json");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, '{"v":1}', "utf8");

  const watcher = new CacheWatcher({
    homedir: home,
    debounceMs: 20,
    backend,
    onChanges: (batch) => changes.push(batch),
  });
  await watcher.start();

  backend.handle.emitAll("change", filePath);
  backend.handle.emitAll("change", filePath);
  await sleep(60);

  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.length, 1);
  assert.equal(changes[0]?.[0]?.kind, "upsert");
});

test("CacheWatcher 目录删除会展开 localIndex 后代为 delete changes", async (t) => {
  const { home, cleanup } = await makeTempHome();
  t.after(cleanup);
  const backend = new FakeWatchBackend();
  const emitted: CacheTaskChange[][] = [];
  await mkdir(path.join(home, ".claude", "nested"), { recursive: true });
  await writeFile(path.join(home, ".claude", "nested", "a.json"), "a", "utf8");
  await writeFile(path.join(home, ".claude", "nested", "b.json"), "b", "utf8");

  const watcher = new CacheWatcher({
    homedir: home,
    debounceMs: 20,
    backend,
    onChanges: (batch) => emitted.push(batch),
  });
  await watcher.start();

  const dirPath = path.join(home, ".claude", "nested");
  await rmPath(dirPath, { recursive: true, force: true });
  backend.handle.emitAll("unlinkDir", dirPath);
  await sleep(60);

  assert.deepEqual(
    emitted[0]?.map((change) => change.path).sort(),
    ["nested/a.json", "nested/b.json"],
  );
  assert.ok(emitted[0]?.every((change) => change.kind === "delete"));
});

test("CacheWatcher suppressPaths 会跳过对应路径事件", async (t) => {
  const { home, cleanup } = await makeTempHome();
  t.after(cleanup);
  const backend = new FakeWatchBackend();
  const emitted: CacheTaskChange[][] = [];
  const filePath = path.join(home, ".claude.json");
  await writeFile(filePath, '{"v":1}', "utf8");

  const watcher = new CacheWatcher({
    homedir: home,
    debounceMs: 20,
    backend,
    onChanges: (batch) => emitted.push(batch),
  });
  await watcher.start();
  watcher.suppressPaths([filePath], 1_000);

  backend.handle.emitAll("change", filePath);
  await sleep(60);

  assert.equal(emitted.length, 0);
});

test("CacheWatcher 大文件标记 skipped", async (t) => {
  const { home, cleanup } = await makeTempHome();
  t.after(cleanup);
  const backend = new FakeWatchBackend();
  const emitted: CacheTaskChange[][] = [];
  const filePath = path.join(home, ".claude", "large.bin");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, Buffer.alloc(MAX_FILE_BYTES + 1));

  const watcher = new CacheWatcher({
    homedir: home,
    debounceMs: 20,
    backend,
    onChanges: (batch) => emitted.push(batch),
  });
  await watcher.start();

  backend.handle.emitAll("change", filePath);
  await sleep(60);

  const change = emitted[0]?.[0];
  assert.equal(change?.kind, "upsert");
  assert.equal(change?.skipped, true);
  assert.equal(change?.sha256, null);
});

test("CacheWatcher stop 后不再发事件", async (t) => {
  const { home, cleanup } = await makeTempHome();
  t.after(cleanup);
  const backend = new FakeWatchBackend();
  const emitted: CacheTaskChange[][] = [];
  const filePath = path.join(home, ".claude", "settings.json");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "{}", "utf8");

  const watcher = new CacheWatcher({
    homedir: home,
    debounceMs: 20,
    backend,
    onChanges: (batch) => emitted.push(batch),
  });
  await watcher.start();
  await watcher.stop();

  backend.handle.emitAll("change", filePath);
  await sleep(60);

  assert.equal(emitted.length, 0);
  assert.equal(backend.handle.closed, true);
});
