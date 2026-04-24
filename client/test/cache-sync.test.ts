/**
 * cache-sync 单元测试：本地扫描、大小预算截断、增量 diff 流程。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  ALL_SCOPES,
  MAX_FILE_BYTES,
  MAX_SCOPE_BYTES,
  applyScopeBudget,
  performInitialCacheSync,
  scanLocalFiles,
} from "../src/cache-sync.js";
import type {
  CacheHandshake,
  CacheManifest,
  CachePush,
  CachePushAck,
  CachePushEntry,
} from "../src/protocol.js";

async function makeTempHome() {
  const home = await mkdtemp(path.join(tmpdir(), "cerelay-home-"));
  return { home, cleanup: () => rm(home, { recursive: true, force: true }) };
}

test("scanLocalFiles claude-json 返回空数组当文件不存在", async (t) => {
  const { home, cleanup } = await makeTempHome();
  t.after(cleanup);
  const res = await scanLocalFiles("claude-json", home);
  assert.deepEqual(res, []);
});

test("scanLocalFiles claude-json 找到 ~/.claude.json 返回单条目", async (t) => {
  const { home, cleanup } = await makeTempHome();
  t.after(cleanup);
  await writeFile(path.join(home, ".claude.json"), '{"x":1}', "utf8");
  const res = await scanLocalFiles("claude-json", home);
  assert.equal(res.length, 1);
  assert.equal(res[0].relPath, "");
});

test("scanLocalFiles claude-home 递归遍历 ~/.claude/", async (t) => {
  const { home, cleanup } = await makeTempHome();
  t.after(cleanup);
  const base = path.join(home, ".claude");
  await mkdir(path.join(base, "subdir"), { recursive: true });
  await writeFile(path.join(base, "settings.json"), "{}", "utf8");
  await writeFile(path.join(base, "subdir", "nested.json"), "{}", "utf8");

  const res = await scanLocalFiles("claude-home", home);
  const rels = res.map((r) => r.relPath).sort();
  assert.deepEqual(rels, ["settings.json", "subdir/nested.json"]);
});

test("applyScopeBudget 单文件 >1MB 保留但标记 skipped，不计入预算", () => {
  const adds: CachePushEntry[] = [
    // 一个标记 skipped 的大文件
    { path: "big", size: 10 * 1024 * 1024, mtime: 100, sha256: "", skipped: true },
    // 三个小文件（加起来 < 100MB）
    { path: "a", size: 10, mtime: 50, sha256: "x", content: "Zm9v" },
    { path: "b", size: 10, mtime: 60, sha256: "y", content: "Zm9v" },
  ];
  const { kept, truncatedAdds } = applyScopeBudget(adds);
  assert.equal(truncatedAdds, false);
  // 全部保留
  assert.equal(kept.length, 3);
  // skipped 的仍保留（不带 content）
  const big = kept.find((e) => e.path === "big");
  assert.ok(big && big.skipped);
});

test("applyScopeBudget 按 mtime 倒序截断至 100MB", () => {
  // 构造总量 > 100MB 的 adds，mtime 递增
  const entry = (path: string, size: number, mtime: number): CachePushEntry => ({
    path,
    size,
    mtime,
    sha256: "h-" + path,
    content: "x",
  });
  const adds: CachePushEntry[] = [
    entry("oldest", 60 * 1024 * 1024, 1),  // 最旧
    entry("middle", 50 * 1024 * 1024, 2),
    entry("newest", 30 * 1024 * 1024, 3),  // 最新
  ];
  // 总 140MB；按 mtime 倒序依次：newest(30) + middle(50) = 80MB，再加 oldest(60) 会破 100MB → 截断
  const { kept, truncatedAdds } = applyScopeBudget(adds);
  assert.equal(truncatedAdds, true);
  const paths = kept.map((e) => e.path).sort();
  assert.deepEqual(paths, ["middle", "newest"]);
});

test("performInitialCacheSync 首次同步推送所有本地文件并等到 ack", async (t) => {
  const { home, cleanup } = await makeTempHome();
  t.after(cleanup);
  const base = path.join(home, ".claude");
  await mkdir(base, { recursive: true });
  await writeFile(path.join(base, "settings.json"), "{}", "utf8");
  await writeFile(path.join(home, ".claude.json"), '{"x":1}', "utf8");

  const sent: Array<CacheHandshake | CachePush> = [];
  let manifestSent = false;

  const summaries = await performInitialCacheSync(
    {
      sendMessage: async (msg) => {
        sent.push(msg);
      },
      waitForServerMessage: async (predicate, _timeout) => {
        // 第一次等 manifest；之后每次等 push_ack
        if (!manifestSent) {
          manifestSent = true;
          const manifest: CacheManifest = {
            type: "cache_manifest",
            deviceId: "d",
            cwd: "/c",
            manifests: {
              "claude-home": { entries: {} },
              "claude-json": { entries: {} },
            },
          };
          const parsed = predicate(JSON.stringify(manifest));
          if (parsed === null) throw new Error("predicate 拒绝 manifest");
          return parsed;
        }
        // 从最近一次发送的 push 里提取 scope，构造 ack
        const lastPush = sent.filter((m): m is CachePush => m.type === "cache_push").at(-1);
        if (!lastPush) throw new Error("没有待 ack 的 push");
        const ack: CachePushAck = {
          type: "cache_push_ack",
          deviceId: "d",
          cwd: "/c",
          scope: lastPush.scope,
          ok: true,
        };
        const parsed = predicate(JSON.stringify(ack));
        if (parsed === null) throw new Error("predicate 拒绝 ack");
        return parsed;
      },
      homedir: home,
    },
    { deviceId: "d", cwd: "/c" },
  );

  // 首条消息一定是 handshake
  assert.equal(sent[0].type, "cache_handshake");
  assert.deepEqual((sent[0] as CacheHandshake).scopes, ALL_SCOPES);

  // 应该对两个 scope 各推了一次 push
  const pushes = sent.filter((m): m is CachePush => m.type === "cache_push");
  assert.equal(pushes.length, 2);
  const pushedScopes = pushes.map((p) => p.scope).sort();
  assert.deepEqual(pushedScopes, ["claude-home", "claude-json"]);

  // summaries 两个 scope 都成功
  assert.equal(summaries.length, 2);
  for (const s of summaries) {
    assert.equal(s.error, undefined);
  }
});

test("performInitialCacheSync 完全 unchanged 时不发送 push", async (t) => {
  const { home, cleanup } = await makeTempHome();
  t.after(cleanup);
  const base = path.join(home, ".claude");
  await mkdir(base, { recursive: true });
  const settingsPath = path.join(base, "settings.json");
  await writeFile(settingsPath, "{}", "utf8");
  // 强制可预测的 mtime
  const fixedMtime = 1_700_000_000_000;
  await utimes(settingsPath, new Date(fixedMtime), new Date(fixedMtime));

  const sent: Array<CacheHandshake | CachePush> = [];

  await performInitialCacheSync(
    {
      sendMessage: async (msg) => {
        sent.push(msg);
      },
      waitForServerMessage: async (predicate) => {
        // 构造一个"已经同步过"的 manifest，size+mtime 完全对齐
        const manifest: CacheManifest = {
          type: "cache_manifest",
          deviceId: "d",
          cwd: "/c",
          manifests: {
            "claude-home": {
              entries: {
                "settings.json": {
                  size: 2,
                  mtime: Math.floor(fixedMtime), // scanLocalFiles floor mtimeMs
                  sha256: "dummy",
                },
              },
            },
            "claude-json": { entries: {} },
          },
        };
        const parsed = predicate(JSON.stringify(manifest));
        if (parsed === null) throw new Error("predicate 拒绝 manifest");
        return parsed;
      },
      homedir: home,
    },
    { deviceId: "d", cwd: "/c" },
  );

  // 只有 handshake，没有 push
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "cache_handshake");
});

test("常量值符合需求：单文件 1MB，单 scope 100MB", () => {
  assert.equal(MAX_FILE_BYTES, 1 * 1024 * 1024);
  assert.equal(MAX_SCOPE_BYTES, 100 * 1024 * 1024);
});
