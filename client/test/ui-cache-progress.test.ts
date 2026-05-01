/**
 * UI: CacheSyncProgressView 渲染纯函数 + 事件流测试。
 * 不验证 ANSI 控制序列细节，只验证内容字段与状态机行为。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import {
  CacheSyncProgressView,
  displayWidth,
  formatBytes,
  formatDuration,
  formatHashProgressLine,
  formatUploadLines,
  renderBar,
  truncateMiddle,
} from "../src/ui.js";

function makeMockOut(columns = 120) {
  const buf: Buffer[] = [];
  const out = Object.assign(
    new Writable({
      write(chunk, _enc, cb) {
        buf.push(Buffer.from(chunk));
        cb();
      },
    }),
    { columns, isTTY: true },
  ) as unknown as NodeJS.WriteStream;
  return { out, getOutput: () => Buffer.concat(buf).toString("utf8") };
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

function extractLine2Path(line2: string): string {
  const plain = stripAnsi(line2);
  const prefix = "  → ";
  // 新布局下 line2 仅包含 `  → <path>`，可能被 fitToColumns 右侧补空格；trim 掉尾随空白
  return plain.slice(prefix.length).replace(/\s+$/, "");
}

test("formatBytes 在 B/KB/MB/GB 边界正确切换", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1023), "1023 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1024 * 1024), "1.0 MB");
  assert.equal(formatBytes(1024 * 1024 * 1024), "1.00 GB");
});

test("formatDuration 在 ms/s/m 三段切换", () => {
  assert.equal(formatDuration(123), "123ms");
  assert.equal(formatDuration(1500), "1.5s");
  assert.equal(formatDuration(60_000), "1m0s");
  assert.equal(formatDuration(125_000), "2m5s");
});

test("renderBar 满/空/中点渲染", () => {
  assert.equal(renderBar(0, 10), "[░░░░░░░░░░]");
  assert.equal(renderBar(1, 10), "[██████████]");
  assert.equal(renderBar(0.5, 10), "[█████░░░░░]");
  // 越界 clamp
  assert.equal(renderBar(-1, 10), "[░░░░░░░░░░]");
  assert.equal(renderBar(2, 10), "[██████████]");
});

test("truncateMiddle 短文本原样返回", () => {
  assert.equal(truncateMiddle("hello", 10), "hello");
});

test("truncateMiddle 长文本中间省略", () => {
  const result = truncateMiddle("verylongfilename.txt", 10);
  assert.equal(result.length, 10);
  assert.ok(result.includes("…"));
});

test("displayWidth 正确处理 ASCII/CJK/emoji/ANSI", () => {
  assert.equal(displayWidth("hello"), 5);
  assert.equal(displayWidth("中文路径"), 8);
  assert.equal(displayWidth("a🙂b"), 4);
  assert.equal(displayWidth("\x1b[31m红🙂a\x1b[0m"), 5);
});

test("truncateMiddle 按显示宽度截断 CJK 文本", () => {
  const result = truncateMiddle("中文目录/测试文件/session.jsonl", 12);
  assert.ok(result.includes("…"));
  assert.ok(displayWidth(result) <= 12);
});

test("formatHashProgressLine 渲染 hash 阶段进度", () => {
  const line = formatHashProgressLine({
    frame: "⠋",
    completedFiles: 3,
    totalFiles: 6,
    columns: 120,
  });

  assert.match(line, /计算文件指纹/);
  assert.match(line, /已 hash 3\/6 文件/);
  assert.match(line, /50\.0%/);
});

test("formatHashProgressLine 窄终端下会裁剪并补齐整宽", () => {
  const line = formatHashProgressLine({
    frame: "⠋",
    completedFiles: 88,
    totalFiles: 88,
    columns: 32,
  });

  assert.equal(displayWidth(line), 32);
  assert.ok(stripAnsi(line).includes("…"));
});

test("formatUploadLines line1 聚合所有数字字段，line2 仅渲染当前文件路径", () => {
  const { line1, line2 } = formatUploadLines({
    frame: "⠋",
    uploadTotalFiles: 5,
    uploadTotalBytes: 1024 * 1024,
    ackedFiles: 2,
    ackedBytes: 512 * 1024,
    inFlightHead: {
      seq: 3,
      displayPath: "~/.claude/settings.json",
      size: 256 * 1024,
    },
    inFlightCount: 2,
    inFlightBytes: 384 * 1024,
    columns: 120,
  });
  // line1：进度 + 文件 + 字节 + in-flight 全部在同一行
  assert.match(line1, /同步中/);
  assert.match(line1, /50\.0%/);
  assert.match(line1, /2\/5 文件/);
  assert.match(line1, /512\.0 KB\/1\.0 MB/);
  assert.match(line1, /in-flight 2 \/ 384\.0 KB/);
  // line2：箭头紧贴左侧 + 文件名（无前缀文案、无 in-flight 信息混杂）
  assert.ok(line2);
  assert.ok(stripAnsi(line2).startsWith("  → "));
  assert.match(line2, /settings\.json/);
  assert.ok(!line2.includes("当前 ack 等待"));
  assert.ok(!line2.includes("in-flight"));
});

test("formatUploadLines in-flight 为空时只渲染 line1，且不输出 in-flight 段", () => {
  const { line1, line2 } = formatUploadLines({
    frame: "⠋",
    uploadTotalFiles: 3,
    uploadTotalBytes: 100,
    ackedFiles: 3,
    ackedBytes: 100,
    inFlightHead: null,
    inFlightCount: 0,
    inFlightBytes: 0,
    columns: 80,
  });
  assert.match(line1, /100\.0%/);
  // pipeline 排空时不再渲染 "in-flight 0 / 0 B" 这种无意义段
  assert.ok(!line1.includes("in-flight"));
  assert.equal(line2, "");
});

test("formatUploadLines 文件名过长会被中间截断", () => {
  const { line2 } = formatUploadLines({
    frame: "⠋",
    uploadTotalFiles: 1,
    uploadTotalBytes: 1024,
    ackedFiles: 0,
    ackedBytes: 0,
    inFlightHead: {
      seq: 1,
      displayPath: "~/.claude/projects/" + "a".repeat(100) + "/session.jsonl",
      size: 1024,
    },
    inFlightCount: 1,
    inFlightBytes: 1024,
    columns: 80,
  });
  assert.ok(line2.includes("…"), "应该出现省略号");
});

test("formatUploadLines CJK 路径在窄终端下仍严格限制在单行列宽内", () => {
  // 路径放长到必然超过 columns - "  → " 的可用宽度，确保 CJK 截断逻辑被覆盖
  const longCjkPath =
    "~/.claude/projects/中文一级目录/中文二级目录/中文三级目录/中文四级目录/中文五级目录/session.jsonl";
  const { line1, line2 } = formatUploadLines({
    frame: "⠋",
    uploadTotalFiles: 8,
    uploadTotalBytes: 4 * 1024 * 1024,
    ackedFiles: 3,
    ackedBytes: 1024 * 1024,
    inFlightHead: {
      seq: 4,
      displayPath: longCjkPath,
      size: 512 * 1024,
    },
    inFlightCount: 12,
    inFlightBytes: 1536 * 1024,
    columns: 72,
  });

  assert.equal(displayWidth(line1), 72);
  assert.equal(displayWidth(line2), 72);
  assert.ok(stripAnsi(line2).startsWith("  → "));
  assert.ok(line2.includes("…"));
});

test("formatUploadLines line2 路径渲染不受 in-flight 数值变化影响", () => {
  // 新布局下 in-flight 信息全部落在 line1，line2 只剩路径——这意味着 in-flight
  // 计数/字节怎么变，line2 的内容都应当 byte-for-byte 一致，路径起点恒定列
  const base = {
    frame: "⠋",
    uploadTotalFiles: 20,
    uploadTotalBytes: 32 * 1024 * 1024,
    ackedFiles: 4,
    ackedBytes: 8 * 1024 * 1024,
    inFlightHead: {
      seq: 5,
      displayPath: "~/.claude/projects/" + "abcdef/".repeat(12) + "session.jsonl",
      size: 1024,
    },
    columns: 76,
  };

  const line2a = formatUploadLines({
    ...base,
    inFlightCount: 3,
    inFlightBytes: 4 * 1024,
  }).line2;
  const line2b = formatUploadLines({
    ...base,
    inFlightCount: 12,
    inFlightBytes: 256 * 1024,
  }).line2;

  assert.equal(line2a, line2b);
  assert.equal(extractLine2Path(line2a), extractLine2Path(line2b));
});

test("CacheSyncProgressView 完整事件流：扫描 → 上传 → 完成", () => {
  const { out, getOutput } = makeMockOut();
  const view = new CacheSyncProgressView({ out });

  view.handle({ kind: "scan_start" });
  view.handle({ kind: "walk_done", totalFiles: 3 });
  view.handle({ kind: "hash_progress", completedFiles: 1, totalFiles: 3 });
  view.handle({ kind: "scan_done", totalFiles: 3, totalBytes: 1024, elapsedMs: 50 });
  view.handle({ kind: "upload_start", totalFiles: 1, totalBytes: 100 });
  view.handle({
    kind: "file_pushed",
    scope: "claude-home",
    displayPath: "~/.claude/a.json",
    size: 100,
    seq: 1,
    index: 0,
    total: 1,
  });
  view.handle({
    kind: "file_acked",
    scope: "claude-home",
    displayPath: "~/.claude/a.json",
    size: 100,
    seq: 1,
    index: 0,
    total: 1,
    ok: true,
  });
  view.handle({
    kind: "upload_done",
    totalFiles: 1,
    totalBytes: 100,
    elapsedMs: 200,
  });

  view.dispose();

  const output = getOutput();
  assert.match(output, /计算文件指纹/);
  assert.match(output, /扫描 Claude 配置/);
  assert.match(output, /同步完成/);
});

test("CacheSyncProgressView scan_done 之前会渲染一帧 100% hash 状态", () => {
  // 回归：之前 scan_done 直接 clearLines + "✓ 扫描..."，如果 hash_progress 没
  // 触发到 totalFiles（或被外部 stdout 写入污染了行追踪导致 clearLines 漏擦），
  // scrollback 里 "计算文件指纹" 的最后快照就会停在中间百分比
  const { out, getOutput } = makeMockOut();
  const view = new CacheSyncProgressView({ out });

  view.handle({ kind: "scan_start" });
  view.handle({ kind: "walk_done", totalFiles: 10 });
  // 故意只发送中间的一个 hash_progress 就触发 scan_done
  view.handle({ kind: "hash_progress", completedFiles: 4, totalFiles: 10 });
  view.handle({ kind: "scan_done", totalFiles: 10, totalBytes: 1024, elapsedMs: 50 });
  view.dispose();

  const plain = getOutput().replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  assert.ok(plain.includes("已 hash 10/10 文件"), "scan_done 前应当渲染一帧 hash 100% 状态");
  assert.match(plain, /扫描 Claude 配置/);
  assert.ok(plain.indexOf("已 hash 10/10 文件") < plain.indexOf("扫描 Claude 配置"));
});

test("CacheSyncProgressView upload_done 之前会渲染一帧 100% 状态", () => {
  // 回归：之前的 bug 是 upload_done 直接 clearLines + "✓ 同步完成"，最后一次
  // 100ms tick 没赶上的话，scrollback 里 "同步中" 的最后快照会停在中间百分比，
  // 给用户造成 "没到 100% 就完成" 的错觉
  const { out, getOutput } = makeMockOut();
  const view = new CacheSyncProgressView({ out });

  view.handle({ kind: "scan_start" });
  view.handle({ kind: "scan_done", totalFiles: 2, totalBytes: 2048, elapsedMs: 30 });
  view.handle({ kind: "upload_start", totalFiles: 2, totalBytes: 2048 });
  view.handle({
    kind: "file_pushed",
    scope: "claude-home",
    displayPath: "~/.claude/a.json",
    size: 1024,
    seq: 1,
    index: 0,
    total: 2,
  });
  view.handle({
    kind: "file_pushed",
    scope: "claude-home",
    displayPath: "~/.claude/b.json",
    size: 1024,
    seq: 2,
    index: 1,
    total: 2,
  });
  // 故意只 ack 一个文件就触发 upload_done——模拟 100ms tick 没赶上的场景
  view.handle({
    kind: "file_acked",
    scope: "claude-home",
    displayPath: "~/.claude/a.json",
    size: 1024,
    seq: 1,
    index: 0,
    total: 2,
    ok: true,
  });
  view.handle({ kind: "upload_done", totalFiles: 2, totalBytes: 2048, elapsedMs: 100 });
  view.dispose();

  const plain = getOutput().replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  assert.ok(plain.includes("100.0%"), "upload_done 前应当渲染一帧 100% 同步中状态");
  assert.match(plain, /同步完成/);
  // 100% 那帧必须在 "同步完成" 之前出现
  assert.ok(plain.indexOf("100.0%") < plain.indexOf("同步完成"));
});

test("CacheSyncProgressView printPersistent 在 sync 活动期把内容写到 spinner 上方并重渲 spinner", () => {
  // 这是修复 [PTY 已连接] 与 cache sync spinner 互相破坏的核心契约：
  // 持久行不能直接 process.stdout.write（会污染 linesRendered 行追踪），必须
  // 走 printPersistent → 先 clearLines 擦 spinner、写持久行 + \n、立即重渲 spinner
  const { out, getOutput } = makeMockOut();
  const view = new CacheSyncProgressView({ out });

  view.handle({ kind: "scan_start" });
  view.handle({ kind: "walk_done", totalFiles: 5 });
  view.handle({ kind: "hash_progress", completedFiles: 1, totalFiles: 5 });
  // 模拟外部代码在 sync 进行中写入 [PTY 已连接]
  view.printPersistent("[PTY 已连接] Session: pty-xyz\r\n");
  view.handle({ kind: "hash_progress", completedFiles: 2, totalFiles: 5 });
  view.handle({ kind: "scan_done", totalFiles: 5, totalBytes: 100, elapsedMs: 20 });
  view.dispose();

  const plain = getOutput().replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  // 持久行应当出现在最终输出里（没被后续 spinner 重渲擦掉）
  assert.match(plain, /\[PTY 已连接\] Session: pty-xyz/);
  // 持久行写完后必然会 re-render spinner，所以 hash 行紧跟其后再次出现
  const ptyIdx = plain.indexOf("[PTY 已连接]");
  const hashAfterPty = plain.indexOf("计算文件指纹", ptyIdx);
  assert.ok(hashAfterPty > ptyIdx, "printPersistent 后应当立即重渲 spinner");
  // 最终 ✓ 扫描必然在 [PTY 已连接] 之后
  assert.ok(plain.indexOf("扫描 Claude 配置") > ptyIdx);
});

test("CacheSyncProgressView printPersistent 在 idle/done 状态直接 stdout 写入", () => {
  const { out, getOutput } = makeMockOut();
  const view = new CacheSyncProgressView({ out });

  // idle 状态：sync 还没启动
  view.printPersistent("startup line\n");
  // done 状态：sync 已结束
  view.handle({ kind: "scan_start" });
  view.handle({ kind: "scan_done", totalFiles: 1, totalBytes: 1, elapsedMs: 1 });
  view.handle({ kind: "upload_start", totalFiles: 0, totalBytes: 0 });
  view.handle({ kind: "upload_done", totalFiles: 0, totalBytes: 0, elapsedMs: 1 });
  view.printPersistent("after-done line");

  const plain = getOutput().replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  assert.match(plain, /startup line/);
  // 没有尾随 \n 的也会自动补
  assert.match(plain, /after-done line\n/);
});

test("CacheSyncProgressView 每次 render 写入的内容都以换行收尾，避免外部 stdout 拼接", () => {
  // 回归：之前 renderUpload 不在 line2 末尾写 \n，cursor 停在 line2 末尾。如果
  // 此时其他代码（如 "[PTY 已连接]"）直接 write，就会拼接到 spinner 行尾导致脏屏
  const { out, getOutput } = makeMockOut();
  const view = new CacheSyncProgressView({ out });
  view.handle({ kind: "scan_start" });
  view.handle({ kind: "scan_done", totalFiles: 1, totalBytes: 100, elapsedMs: 10 });
  view.handle({ kind: "upload_start", totalFiles: 1, totalBytes: 100 });
  view.handle({
    kind: "file_pushed",
    scope: "claude-home",
    displayPath: "~/.claude/a.json",
    size: 100,
    seq: 1,
    index: 0,
    total: 1,
  });
  // 此时 spinner 渲染过一次（upload_start 起 timer 立刻 render），cursor 应当落在
  // 内容下方一行的列 0——以 \n 收尾才能保证下一段 stdout write 不会拼到 spinner 后面
  const output = getOutput();
  assert.ok(output.endsWith("\n"), "render 后 cursor 必须落在新行起始位置");
  view.dispose();
});

test("CacheSyncProgressView upload_start 0 文件时跳过同步行", () => {
  const { out, getOutput } = makeMockOut();
  const view = new CacheSyncProgressView({ out });

  view.handle({ kind: "scan_start" });
  view.handle({ kind: "walk_done", totalFiles: 0 });
  view.handle({ kind: "scan_done", totalFiles: 0, totalBytes: 0, elapsedMs: 30 });
  view.handle({ kind: "upload_start", totalFiles: 0, totalBytes: 0 });
  view.handle({ kind: "upload_done", totalFiles: 0, totalBytes: 0, elapsedMs: 1 });
  view.dispose();

  const output = getOutput();
  assert.match(output, /扫描 Claude 配置/);
  assert.ok(!output.includes("同步完成"), "0 文件时不应展示同步完成行");
});

test("CacheSyncProgressView pty-startup phase 单独运行（无 cache sync 干扰）", () => {
  const { out, getOutput } = makeMockOut();
  const view = new CacheSyncProgressView({ out });

  assert.equal(view.isIdle(), true);
  view.beginPtyStartup();
  assert.equal(view.isIdle(), false);
  // 立即结束（PTY 第一帧瞬间就到）
  view.endPtyStartup();
  assert.equal(view.isIdle(), true);

  const plain = getOutput().replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  assert.match(plain, /正在启动 Claude Code/);
  // pty-startup 不写"成功消息"——结束后 view 没有遗留任何 "✓" 类标记
  assert.ok(!plain.includes("✓"));
  view.dispose();
});

test("CacheSyncProgressView pty-startup 与 cache sync 并发：startup 进 pending 队列等 sync 结束", () => {
  // 这是统一 view 的核心契约：cache sync 还在跑时 PTY 已连接 → beginPtyStartup
  // 不能立刻接管 stdout，必须等 cache sync 跑完。否则两个 spinner 争行就是脏屏
  const { out, getOutput } = makeMockOut();
  const view = new CacheSyncProgressView({ out });

  view.handle({ kind: "scan_start" });
  view.handle({ kind: "walk_done", totalFiles: 1 });
  // PTY 在 cache sync 扫描期就已连接
  view.beginPtyStartup();
  // pty-startup 应当 pending，而不是立刻渲染
  const internal = view as unknown as {
    currentPhase: { id: string } | null;
    pendingPhase: { id: string } | null;
  };
  assert.equal(internal.currentPhase?.id, "scan");
  assert.equal(internal.pendingPhase?.id, "pty-startup");

  // 完成 scan，pending 自动激活
  view.handle({ kind: "scan_done", totalFiles: 1, totalBytes: 100, elapsedMs: 10 });
  assert.equal(internal.currentPhase?.id, "pty-startup");
  assert.equal(internal.pendingPhase, null);

  view.endPtyStartup();
  assert.equal(view.isIdle(), true);

  const plain = getOutput().replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  // 顺序：扫描 → 扫描成功消息 → 启动 spinner
  assert.ok(plain.indexOf("扫描 Claude 配置") < plain.indexOf("正在启动 Claude Code"));
});

test("CacheSyncProgressView pending pty-startup 在被激活前调 endPtyStartup 直接丢弃", () => {
  // 场景：cache sync 还在跑时 beginPtyStartup → 还没等 sync 结束 PTY 第一帧就到了
  // → endPtyStartup 应该直接清掉 pending（不能让一个永远不显示的 phase 堆积）
  const { out, getOutput } = makeMockOut();
  const view = new CacheSyncProgressView({ out });

  view.handle({ kind: "scan_start" });
  view.beginPtyStartup();
  view.endPtyStartup();
  view.handle({ kind: "scan_done", totalFiles: 0, totalBytes: 0, elapsedMs: 1 });

  const plain = getOutput().replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  // pending 被丢弃 → 永远不会渲染 "正在启动 Claude Code"
  assert.ok(!plain.includes("正在启动 Claude Code"));
  view.dispose();
});

test("CacheSyncProgressView pty-startup phase 配合 printPersistent 写持久行", () => {
  // 验证 pty-startup phase 跟 cache sync phase 一样享受 printPersistent 不变量
  const { out, getOutput } = makeMockOut();
  const view = new CacheSyncProgressView({ out });

  view.beginPtyStartup();
  view.printPersistent("[日志] 某个持久行\r\n");
  view.endPtyStartup();
  view.dispose();

  const plain = getOutput().replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  assert.match(plain, /\[日志\] 某个持久行/);
  assert.match(plain, /正在启动 Claude Code/);
});

test("CacheSyncProgressView upload_done 完成后若 pty-startup pending，自动激活", () => {
  // 完整的"启动期"链路：scan → upload → pty-startup。验证 pending 在 upload
  // 完成后也会被 startNextPhase 自动激活（不只 scan_done）
  const { out, getOutput } = makeMockOut();
  const view = new CacheSyncProgressView({ out });

  view.handle({ kind: "scan_start" });
  view.handle({ kind: "scan_done", totalFiles: 1, totalBytes: 100, elapsedMs: 10 });
  view.handle({ kind: "upload_start", totalFiles: 1, totalBytes: 100 });
  view.handle({
    kind: "file_pushed",
    scope: "claude-home",
    displayPath: "~/.claude/a.json",
    size: 100,
    seq: 1,
    index: 0,
    total: 1,
  });
  // PTY 在 upload 进行中已连接
  view.beginPtyStartup();
  const internal = view as unknown as {
    currentPhase: { id: string } | null;
    pendingPhase: { id: string } | null;
  };
  assert.equal(internal.currentPhase?.id, "upload");
  assert.equal(internal.pendingPhase?.id, "pty-startup");

  view.handle({
    kind: "file_acked",
    scope: "claude-home",
    displayPath: "~/.claude/a.json",
    size: 100,
    seq: 1,
    index: 0,
    total: 1,
    ok: true,
  });
  view.handle({ kind: "upload_done", totalFiles: 1, totalBytes: 100, elapsedMs: 50 });
  assert.equal(internal.currentPhase?.id, "pty-startup");

  view.endPtyStartup();

  const plain = getOutput().replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  assert.ok(plain.indexOf("同步完成") < plain.indexOf("正在启动 Claude Code"));
});

test("CacheSyncProgressView skipped 事件不写任何东西", () => {
  const { out, getOutput } = makeMockOut();
  const view = new CacheSyncProgressView({ out });
  view.handle({ kind: "skipped", reason: "ws not ready" });
  view.dispose();
  assert.equal(getOutput().length, 0);
});

test("CacheSyncProgressView in-flight 队列：file_pushed 入队，file_acked 按 seq 移除", () => {
  // 不验证 stdout 输出，只验证内部状态正确
  const { out } = makeMockOut();
  const view = new CacheSyncProgressView({ out });
  view.handle({ kind: "scan_start" });
  view.handle({ kind: "scan_done", totalFiles: 3, totalBytes: 300, elapsedMs: 10 });
  view.handle({ kind: "upload_start", totalFiles: 3, totalBytes: 300 });
  // 三个 file_pushed
  for (let i = 1; i <= 3; i += 1) {
    view.handle({
      kind: "file_pushed",
      scope: "claude-home",
      displayPath: `~/.claude/f${i}.json`,
      size: 100,
      seq: i,
      index: i - 1,
      total: 3,
    });
  }
  // 中间一个先 ack（乱序）
  view.handle({
    kind: "file_acked",
    scope: "claude-home",
    displayPath: "~/.claude/f2.json",
    size: 100,
    seq: 2,
    index: 1,
    total: 3,
    ok: true,
  });
  view.handle({ kind: "upload_done", totalFiles: 3, totalBytes: 300, elapsedMs: 50 });
  view.dispose();
  // 没有断言 throw 即视为状态机健康（队列查找按 seq，乱序 ack 不应 panic）
});

test("CacheSyncProgressView displayedHead 当原文件已离开队列时立即更新", () => {
  // Phase 抽象后防抖逻辑挪到 UploadPhase 内部。本测试覆盖"显示中的文件被乱序
  // ack 移出队列"的场景：此时无需等防抖窗口，应立即切到新队首
  const { out } = makeMockOut(80);
  const view = new CacheSyncProgressView({ out });

  const realNow = Date.now;
  let now = 1_000;

  try {
    Date.now = () => now;
    view.handle({ kind: "scan_start" });
    view.handle({ kind: "scan_done", totalFiles: 2, totalBytes: 200, elapsedMs: 1 });
    view.handle({ kind: "upload_start", totalFiles: 2, totalBytes: 200 });
    view.handle({
      kind: "file_pushed",
      scope: "claude-home",
      displayPath: "~/.claude/a.json",
      size: 100,
      seq: 1,
      index: 0,
      total: 2,
    });
    view.handle({
      kind: "file_pushed",
      scope: "claude-home",
      displayPath: "~/.claude/b.json",
      size: 100,
      seq: 2,
      index: 1,
      total: 2,
    });

    // 通过反射读 UploadPhase.displayedHead，验证防抖窗口
    const internal = view as unknown as {
      currentPhase: { displayedHead: { seq: number } | null } | null;
      render(): void;
    };

    // 第一次 render：displayedHead 锁定到队首 headA(seq=1)
    internal.render();
    assert.equal(internal.currentPhase?.displayedHead?.seq, 1);

    // 乱序 ack 把 headA 从队列移除 → 队首变成 headB(seq=2)
    view.handle({
      kind: "file_acked",
      scope: "claude-home",
      displayPath: "~/.claude/a.json",
      size: 100,
      seq: 1,
      index: 0,
      total: 2,
      ok: true,
    });
    // displayedHead 此时仍指向 headA（已不在队列里），下次 render 立即切到 headB
    // 注意：根据 resolveDisplayedHead 的逻辑，displayed 不在队列里会立即更新
    internal.render();
    assert.equal(internal.currentPhase?.displayedHead?.seq, 2);
  } finally {
    Date.now = realNow;
    view.dispose();
  }
});

test("CacheSyncProgressView displayedHead 250ms 防抖：队首仍在队列时不立即切换", () => {
  // 模拟第二种场景：队首 headA 仍在队列里，但 displayedHead 已是 headB（曾经的
  // 队首，现还在队列后段）；进入防抖期后 250ms 内继续显示 headB，超过才切回 headA
  const { out } = makeMockOut(80);
  const view = new CacheSyncProgressView({ out });
  const realNow = Date.now;
  let now = 1_000;

  try {
    Date.now = () => now;
    view.handle({ kind: "scan_start" });
    view.handle({ kind: "scan_done", totalFiles: 2, totalBytes: 200, elapsedMs: 1 });
    view.handle({ kind: "upload_start", totalFiles: 2, totalBytes: 200 });
    view.handle({
      kind: "file_pushed",
      scope: "claude-home",
      displayPath: "~/.claude/a.json",
      size: 100,
      seq: 1,
      index: 0,
      total: 2,
    });
    view.handle({
      kind: "file_pushed",
      scope: "claude-home",
      displayPath: "~/.claude/b.json",
      size: 100,
      seq: 2,
      index: 1,
      total: 2,
    });

    const internal = view as unknown as {
      currentPhase: {
        displayedHead: { seq: number; displayPath: string; size: number } | null;
        displayedHeadAt: number;
        headPendingSince: number;
      } | null;
      render(): void;
    };

    // 强制把 displayedHead 设成 headB 模拟"队首已变但显示尚未更新"
    // displayedHead 必须是完整的 InflightItem（renderUpload 会读 displayPath）
    if (internal.currentPhase) {
      internal.currentPhase.displayedHead = { seq: 2, displayPath: "~/.claude/b.json", size: 100 };
      internal.currentPhase.displayedHeadAt = now;
      internal.currentPhase.headPendingSince = 0;
    }

    internal.render();
    assert.equal(internal.currentPhase?.displayedHead?.seq, 2);

    now += 200;
    internal.render();
    assert.equal(internal.currentPhase?.displayedHead?.seq, 2);

    now += 60;
    internal.render();
    assert.equal(internal.currentPhase?.displayedHead?.seq, 1);
  } finally {
    Date.now = realNow;
    view.dispose();
  }
});
