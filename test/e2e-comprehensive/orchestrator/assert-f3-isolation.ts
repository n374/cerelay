// ============================================================
// P0-B-Critical-3/4: F3 / meta-deviceid-collision 公共断言。
//
// 不变量：两个 deviceId 在 server 端的 cache manifest 必须按内容（sha256）严格隔离。
// 通过 /admin/cache?deviceId=&scope=&relPath= 单项查询验证：
//   1. A 和 B 各自查到 (claude-home, .claude/CLAUDE.md) entry，且 size 与期望内容一致
//   2. A 和 B 的 sha256 必须不同（同 relPath 不同 marker → hash 必不同）
//   3. A 在 B 的 deviceId 下 lookup 也命中（如果 deviceId collision），但 hash 与
//      A 自查到的相同（== collision 失败信号）；正常情况两侧 hash 互不相同
//
// 主套件 F3：两个 deviceId 真不同 → 期望本断言通过
// meta-deviceid-collision：两侧强制同 deviceId → 期望本断言 throw（因为单 manifest
//   只能存一个最新 hash，A/B 写同 relPath 互相覆盖，最终查到的 hash 相同 → 隔离失效）
// ============================================================

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cacheAdmin } from "./server-events.js";

export interface F3IsolationCheck {
  /** 两侧实际写入的 marker 内容（用于本端期望 sha256 计算） */
  contentA: string;
  contentB: string;
  deviceIdA: string;
  deviceIdB: string;
  /**
   * cache scope=claude-home 内的 relPath，两侧都写**同一**路径，不同内容。
   * 默认 "CLAUDE.md"（fresh device 的 SEED_WHITELIST 内）。
   * 注意：cache scope=claude-home 的 relPath 是 ~/.claude/ 之内的相对路径，
   * 不含 ".claude/" 前缀。
   */
  relPath?: string;
}

/**
 * 断言两个 deviceId 在 server cache 端按内容严格隔离。
 *
 * 通过失败：
 * - 两侧 entry 都查得到、size + sha256 各自匹配本端写入内容
 * - 两侧 sha256 必不相同（这是核心不变量）
 *
 * 通过 throw 反向：
 * - meta-deviceid-collision 中，两侧 deviceId 相同 → cacheAdmin.lookupEntry 返回
 *   同一份 manifest 的最新 entry → 两侧 sha256 必然相同 → 断言失败 throw
 */
export async function assertF3Isolation(opts: F3IsolationCheck): Promise<void> {
  const relPath = opts.relPath ?? "CLAUDE.md";
  const expectedShaA = sha256Hex(opts.contentA);
  const expectedShaB = sha256Hex(opts.contentB);

  // sanity: 两侧测试输入 marker 必须不同（不然就不可能验"hash 不同"）
  assert.notEqual(expectedShaA, expectedShaB, "test setup error: contentA / contentB must differ");

  const entryA = await cacheAdmin.lookupEntry({
    deviceId: opts.deviceIdA,
    scope: "claude-home",
    relPath,
  });
  const entryB = await cacheAdmin.lookupEntry({
    deviceId: opts.deviceIdB,
    scope: "claude-home",
    relPath,
  });

  if (!entryA) {
    throw new Error(
      `device A 应该查到 entry (deviceId=${opts.deviceIdA}, relPath=${relPath})，但 lookup 返回 null`,
    );
  }
  if (!entryB) {
    throw new Error(
      `device B 应该查到 entry (deviceId=${opts.deviceIdB}, relPath=${relPath})，但 lookup 返回 null`,
    );
  }

  // 内容隔离的核心断言：两侧 sha256 必不相同
  assert.notEqual(
    entryA.sha256,
    entryB.sha256,
    `cache 内容隔离失败：device A=${opts.deviceIdA} sha256=${entryA.sha256}, ` +
      `device B=${opts.deviceIdB} sha256=${entryB.sha256}（同 deviceId 共用 manifest 时这里会失败）`,
  );

  // 双向匹配：A 的 sha256 应该匹配 contentA；B 同理
  assert.equal(
    entryA.sha256,
    expectedShaA,
    `device A 的 sha256 应该 == sha256(contentA)`,
  );
  assert.equal(
    entryB.sha256,
    expectedShaB,
    `device B 的 sha256 应该 == sha256(contentB)`,
  );
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
