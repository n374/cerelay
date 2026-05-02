// Inflight dedup 单元测试 + FileAgent miss 路径接 fetcher（Task 4）。

import assert from "node:assert";
import { test, describe } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileAgent } from "../src/file-agent/index.js";
import { ClientCacheStore } from "../src/file-agent/store.js";
import { InflightMap, inflightKey } from "../src/file-agent/inflight.js";
import type {
  FileAgentReadResult,
  FileAgentStatResult,
} from "../src/file-agent/types.js";

const DEVICE_ID = "device-inflight";
const HOME_DIR = "/home/u";

async function makeStore() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cerelay-if-"));
  return {
    dataDir,
    store: new ClientCacheStore({ dataDir }),
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
  };
}

describe("InflightMap 单元行为", () => {
  test("dedupe：100 并发同 key 调用 run() 只被执行 1 次", async () => {
    const map = new InflightMap();
    let runCount = 0;
    let resolveRun!: (v: number) => void;
    const runPromise = new Promise<number>((r) => {
      resolveRun = r;
    });
    const run = () => {
      runCount += 1;
      return runPromise;
    };

    // 启动 100 个并发 dedupe，全部 pending 在 runPromise 上
    const allPromises = Array.from({ length: 100 }, () =>
      map.dedupe("read:/abs/x", run),
    );
    assert.equal(runCount, 1, "run 只应被调用 1 次");

    // 全部等待方解析
    resolveRun(42);
    const results = await Promise.all(allPromises);
    assert.deepEqual(results, Array.from({ length: 100 }, () => 42));
  });

  test("dedupe：成功后立即从 map 移除，下次同 key 调用走新 run", async () => {
    const map = new InflightMap();
    let runCount = 0;
    const run = async () => {
      runCount += 1;
      return runCount;
    };

    const r1 = await map.dedupe("read:/x", run);
    assert.equal(r1, 1);
    assert.equal(map.has("read:/x"), false);

    const r2 = await map.dedupe("read:/x", run);
    assert.equal(r2, 2, "第二次应触发新 run");
  });

  test("dedupe：run 失败时所有等待方收到同一错误；下次重试不复用错误", async () => {
    const map = new InflightMap();
    let runCount = 0;
    // 让 fetch 异步抛错，否则同步 throw 会导致 inflight 立即 settle、并发拿不到同一 promise
    // production 中 fetcher 通过 ws 拉数据本就是异步的，这里 setImmediate 模拟。
    const failingRun = async () => {
      runCount += 1;
      const err = new Error(`boom-${runCount}`);
      await new Promise((r) => setImmediate(r));
      throw err;
    };

    const promises = Array.from({ length: 5 }, () =>
      map.dedupe("read:/y", failingRun).catch((e) => (e as Error).message),
    );
    const results = await Promise.all(promises);
    assert.deepEqual(results, ["boom-1", "boom-1", "boom-1", "boom-1", "boom-1"]);
    assert.equal(runCount, 1, "失败也只 run 一次");

    // 下次重试 → 新 run（runCount=2）
    const retry = await map.dedupe("read:/y", failingRun).catch(
      (e) => (e as Error).message,
    );
    assert.equal(retry, "boom-2");
    assert.equal(runCount, 2);
  });

  test("不同 key 互相独立，run 各自执行", async () => {
    const map = new InflightMap();
    let runCount = 0;
    const run = async () => {
      runCount += 1;
      return runCount;
    };
    const [a, b] = await Promise.all([
      map.dedupe("read:/a", run),
      map.dedupe("read:/b", run),
    ]);
    // 各自一次
    assert.equal(runCount, 2);
    assert.notEqual(a, b);
  });

  test("inflightKey 拼接稳定", () => {
    assert.equal(inflightKey("read", "/abs/x"), "read:/abs/x");
    assert.equal(inflightKey("stat", "/abs/x"), "stat:/abs/x");
    assert.equal(inflightKey("readdir", "/abs/x"), "readdir:/abs/x");
    assert.notEqual(inflightKey("read", "/x"), inflightKey("stat", "/x"));
  });
});

describe("FileAgent miss 时通过 fetcher + inflight 去重（Task 4 stub）", () => {
  test("100 并发 read 同 path miss → fetcher 只被调用 1 次，所有等待方拿到同一结果", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    let fetchCount = 0;
    let resolveFetch!: (v: FileAgentReadResult) => void;
    const pending = new Promise<FileAgentReadResult>((r) => {
      resolveFetch = r;
    });

    const agent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir: HOME_DIR,
      store,
      fetcher: {
        fetchFile: async (_absPath: string) => {
          fetchCount += 1;
          return pending;
        },
        fetchStat: async () => ({ kind: "missing" }),
        fetchReaddir: async () => ({ kind: "missing" }),
      },
    });

    // 启动 100 个并发 read 同一 path
    const absPath = `${HOME_DIR}/.claude/never-cached`;
    const promises = Array.from({ length: 100 }, () => agent.read(absPath, 1000));

    // 让事件循环跑一段时间，让所有 read 完成 store.lookupEntry 的 readFile IO
    // 后进入 inflight。setImmediate 单 tick 不够，需要 setTimeout 给 IO 完成时间。
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(fetchCount, 1, "fetcher.fetchFile 只应被调用 1 次");
    assert.equal(agent.getInflightSizeForTest(), 1, "inflight 中只应有 1 项");

    resolveFetch({
      kind: "file",
      content: Buffer.from("data"),
      size: 4,
      mtime: 1,
      sha256: "abc",
    });

    const results = await Promise.all(promises);
    assert.equal(results.length, 100);
    for (const r of results) {
      assert.equal(r.kind, "file");
      if (r.kind === "file") {
        assert.equal(r.content.toString("utf8"), "data");
      }
    }
  });

  test("read 与 stat 同 path：inflight key 不同，各自一次穿透", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    let readCount = 0;
    let statCount = 0;
    const agent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir: HOME_DIR,
      store,
      fetcher: {
        fetchFile: async (): Promise<FileAgentReadResult> => {
          readCount += 1;
          await new Promise((r) => setTimeout(r, 30));
          return { kind: "missing" };
        },
        fetchStat: async (): Promise<FileAgentStatResult> => {
          statCount += 1;
          await new Promise((r) => setTimeout(r, 30));
          return { kind: "missing" };
        },
        fetchReaddir: async () => ({ kind: "missing" }),
      },
    });

    const absPath = `${HOME_DIR}/.claude/x`;
    await Promise.all([
      agent.read(absPath, 1000),
      agent.read(absPath, 1000),
      agent.stat(absPath, 1000),
      agent.stat(absPath, 1000),
    ]);
    assert.equal(readCount, 1);
    assert.equal(statCount, 1);
  });

  test("fetcher 失败 → read 抛错；下次重试触发新 fetcher", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    let fetchCount = 0;
    let releaseFetcher!: (kind: "ok" | "fail") => void;
    const fetcherGate = new Promise<"ok" | "fail">((r) => {
      releaseFetcher = r;
    });

    const agent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir: HOME_DIR,
      store,
      fetcher: {
        fetchFile: async () => {
          fetchCount += 1;
          const id = fetchCount;
          // 等测试主线放行后再抛错，避免第一个 fetch 同步 settle 导致 inflight 被清空
          // 让后续 reads 触发新 fetcher
          await fetcherGate;
          throw new Error(`fetch-fail-${id}`);
        },
        fetchStat: async () => ({ kind: "missing" }),
        fetchReaddir: async () => ({ kind: "missing" }),
      },
    });

    const absPath = `${HOME_DIR}/.claude/never`;

    // 启动 5 并发 read，等所有都进入 inflight
    const concurrentReads = Array.from({ length: 5 }, () =>
      agent.read(absPath, 1000).catch((e) => (e as Error).message),
    );
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(fetchCount, 1, "5 并发 read 应共享一次 fetcher 调用");

    // 放行 fetcher，让它抛错
    releaseFetcher("fail");
    const errors = await Promise.all(concurrentReads);
    for (const e of errors) {
      assert.equal(e, "fetch-fail-1");
    }

    // 重试 → 新 fetcher（注意：不能复用 fetcherGate，已 settled，所以新 fetch
    // 调用时 await fetcherGate 立即解开 → throw new Error，符合预期 fetch-fail-2）
    const retry = await agent
      .read(absPath, 1000)
      .catch((e) => (e as Error).message);
    assert.equal(retry, "fetch-fail-2");
    assert.equal(fetchCount, 2);
  });

  test("没传 fetcher 且 store miss → 抛 not implemented（Task 5 接 sync-coordinator）", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    const agent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir: HOME_DIR,
      store,
      // fetcher 缺省
    });

    await assert.rejects(
      () => agent.read(`${HOME_DIR}/.claude/x`, 1000),
      /not implemented/i,
    );
  });

  test("ttlMs 校验：read miss + 非法 ttl → RangeError，且不调用 fetcher", async (t) => {
    const { store, cleanup } = await makeStore();
    t.after(cleanup);

    let fetchCount = 0;
    const agent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir: HOME_DIR,
      store,
      fetcher: {
        fetchFile: async () => {
          fetchCount += 1;
          return { kind: "missing" };
        },
        fetchStat: async () => ({ kind: "missing" }),
        fetchReaddir: async () => ({ kind: "missing" }),
      },
    });

    await assert.rejects(() => agent.read(`${HOME_DIR}/.claude/x`, 0), RangeError);
    await assert.rejects(
      () => agent.read(`${HOME_DIR}/.claude/x`, Infinity),
      RangeError,
    );
    assert.equal(fetchCount, 0, "非法 ttl 应在校验时拒绝，不应调 fetcher");
  });
});
