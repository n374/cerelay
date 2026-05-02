// FileAgent 接口契约测试。
// Task 1 仅验证接口骨架存在 + 方法签名正确；具体行为在 Task 2+ 加。

import assert from "node:assert";
import { test, describe } from "node:test";
import { FileAgent } from "../src/file-agent/index.js";
import type {
  FileAgentReadResult,
  FileAgentStatResult,
  FileAgentReaddirResult,
  PrefetchItem,
  PrefetchResult,
} from "../src/file-agent/types.js";

describe("FileAgent 接口契约（Task 1 骨架）", () => {
  test("FileAgent 类可以实例化", () => {
    const agent = new FileAgent({ deviceId: "dev-test" });
    assert.ok(agent instanceof FileAgent);
  });

  test("read 方法存在且接收 (absPath, ttlMs) 两个参数", async () => {
    const agent = new FileAgent({ deviceId: "dev-test" });
    assert.strictEqual(typeof agent.read, "function");
    assert.strictEqual(agent.read.length, 2);
    // Task 1 阶段抛 "not implemented"，Task 2+ 接 store 命中。
    await assert.rejects(
      () => agent.read("/abs/path", 1000),
      /not implemented/i,
    );
  });

  test("stat 方法存在且接收 (absPath, ttlMs) 两个参数", async () => {
    const agent = new FileAgent({ deviceId: "dev-test" });
    assert.strictEqual(typeof agent.stat, "function");
    assert.strictEqual(agent.stat.length, 2);
    await assert.rejects(
      () => agent.stat("/abs/path", 1000),
      /not implemented/i,
    );
  });

  test("readdir 方法存在且接收 (absDir, ttlMs) 两个参数", async () => {
    const agent = new FileAgent({ deviceId: "dev-test" });
    assert.strictEqual(typeof agent.readdir, "function");
    assert.strictEqual(agent.readdir.length, 2);
    await assert.rejects(
      () => agent.readdir("/abs/dir", 1000),
      /not implemented/i,
    );
  });

  test("prefetch 方法存在且接收 (items, ttlMs) 两个参数", async () => {
    const agent = new FileAgent({ deviceId: "dev-test" });
    assert.strictEqual(typeof agent.prefetch, "function");
    assert.strictEqual(agent.prefetch.length, 2);
    const items: PrefetchItem[] = [];
    await assert.rejects(
      () => agent.prefetch(items, 1000),
      /not implemented/i,
    );
  });

  test("close 方法存在", async () => {
    const agent = new FileAgent({ deviceId: "dev-test" });
    assert.strictEqual(typeof agent.close, "function");
    // close 在骨架阶段也是 noop（不抛错），方便测试 setUp/tearDown 流程。
    await agent.close();
  });

  test("类型导出：FileAgentReadResult / StatResult / ReaddirResult / PrefetchItem / PrefetchResult 都可 import", () => {
    // 这个测试只是确保 type 导出存在；TypeScript 类型擦除后运行时只能验证
    // 模块加载本身没问题。具体类型 shape 的校验在用到这些类型的具体测试里。
    const sampleRead: FileAgentReadResult = { kind: "missing" };
    const sampleStat: FileAgentStatResult = { kind: "missing" };
    const sampleReaddir: FileAgentReaddirResult = { kind: "missing" };
    const sampleItem: PrefetchItem = { kind: "file", absPath: "/a" };
    const sampleResult: PrefetchResult = {
      fetched: 0,
      alreadyHot: 0,
      missing: 0,
      failed: [],
      durationMs: 0,
    };
    assert.strictEqual(sampleRead.kind, "missing");
    assert.strictEqual(sampleStat.kind, "missing");
    assert.strictEqual(sampleReaddir.kind, "missing");
    assert.strictEqual(sampleItem.kind, "file");
    assert.strictEqual(sampleResult.fetched, 0);
  });
});
