// Task 9 契约测试：FileAgent 与 FileProxyManager 共享 ClientCacheStore，
// 命中事实上等价（同一 store 的 lookupEntry 返回相同结果）。
//
// 注：本期 FUSE IPC handler 不强制走 FileAgent.read（避免破坏 redaction / mutation
// 路径）；Task 9 仅做 wiring 准备 + 共享 store 一致性契约。

import assert from "node:assert";
import { test, describe } from "node:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { FileAgent } from "../src/file-agent/index.js";
import { ClientCacheStore } from "../src/file-agent/store.js";
import { FileProxyManager } from "../src/file-proxy-manager.js";

const DEVICE_ID = "device-fpm-fa";

function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

describe("FileProxyManager × FileAgent wiring 契约（Task 9）", () => {
  test("FileProxyManagerOptions 接受 fileAgent 字段；构造不报错", async (t) => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "fpm-fa-"));
    t.after(() => rm(dataDir, { recursive: true, force: true }));

    const store = new ClientCacheStore({ dataDir });
    const fileAgent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir: "/home/u",
      store,
      gcIntervalMs: 0,
    });

    const runtimeRoot = path.join(dataDir, "runtime");
    await mkdir(runtimeRoot, { recursive: true });

    const manager = new FileProxyManager({
      runtimeRoot,
      clientHomeDir: "/home/u",
      clientCwd: "/home/u/work",
      sessionId: "s1",
      sendToClient: async () => {},
      cacheStore: store,
      deviceId: DEVICE_ID,
      fileAgent,
    });
    assert.ok(manager instanceof FileProxyManager);

    await fileAgent.close();
  });

  test("共享 store：FileAgent.read 命中的 path，FileProxyManager 也能从 store 命中（同一份数据）", async (t) => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "fpm-fa-"));
    t.after(() => rm(dataDir, { recursive: true, force: true }));

    const store = new ClientCacheStore({ dataDir });
    const content = "shared-data";

    // 写入 store（模拟 cache_task_delta apply）
    await store.applyDelta(DEVICE_ID, [
      {
        kind: "upsert",
        scope: "claude-home",
        path: "settings.json",
        size: content.length,
        mtime: 1,
        sha256: sha256(content),
        contentBase64: b64(content),
      },
    ]);

    const fileAgent = new FileAgent({
      deviceId: DEVICE_ID,
      homeDir: "/home/u",
      store,
      gcIntervalMs: 0,
    });
    t.after(() => fileAgent.close());

    // FileAgent 命中
    const r = await fileAgent.read("/home/u/.claude/settings.json", 1000);
    assert.equal(r.kind, "file");
    if (r.kind === "file") {
      assert.equal(r.content.toString("utf8"), content);
    }

    // FileProxyManager 从同一 store 也能命中
    const entry = await store.lookupEntry(DEVICE_ID, "claude-home", "settings.json");
    assert.ok(entry);
    assert.equal(entry.size, content.length);
    assert.equal(entry.sha256, sha256(content));
    const blob = store.readBlobSync(DEVICE_ID, entry.sha256!);
    assert.ok(blob);
    assert.equal(blob.toString("utf8"), content);
  });
});
