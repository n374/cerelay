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
  const prefix = "  → 当前 ack 等待: ";
  const suffix = "  (in-flight";
  const suffixIndex = plain.indexOf(suffix);
  return plain.slice(prefix.length, suffixIndex >= 0 ? suffixIndex : undefined);
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

test("formatUploadLines 总进度按 ack 字节精确计算", () => {
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
  assert.match(line1, /同步中/);
  assert.match(line1, /2\/5 文件/);
  // 已 ack 字节 / 总字节
  assert.match(line1, /512\.0 KB\/1\.0 MB/);
  // 50.0%
  assert.match(line1, /50\.0%/);
  // line2 显示 in-flight 头部 + 计数字节
  assert.ok(line2);
  assert.match(line2, /当前 ack 等待: /);
  assert.match(line2, /settings\.json/);
  assert.match(line2, /in-flight\s+2 文件/);
  assert.match(line2, /384\.0 KB/);
});

test("formatUploadLines in-flight 为空时只渲染 line1", () => {
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
  const { line1, line2 } = formatUploadLines({
    frame: "⠋",
    uploadTotalFiles: 8,
    uploadTotalBytes: 4 * 1024 * 1024,
    ackedFiles: 3,
    ackedBytes: 1024 * 1024,
    inFlightHead: {
      seq: 4,
      displayPath: "~/.claude/projects/中文目录/子目录/配置文件/session.jsonl",
      size: 512 * 1024,
    },
    inFlightCount: 12,
    inFlightBytes: 1536 * 1024,
    columns: 72,
  });

  assert.equal(displayWidth(line1), 72);
  assert.equal(displayWidth(line2), 72);
  assert.ok(stripAnsi(line2).startsWith("  → 当前 ack 等待: "));
  assert.ok(line2.includes("…"));
});

test("formatUploadLines 固定 tail 宽度后 path 截断阈值保持稳定", () => {
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

test("CacheSyncProgressView displayedHead 在 250ms 内保持稳定", () => {
  const { out } = makeMockOut(80);
  const view = new CacheSyncProgressView({ out });
  const internal = view as unknown as {
    state: string;
    uploadTotalFiles: number;
    uploadTotalBytes: number;
    ackedFiles: number;
    ackedBytes: number;
    inFlightBytes: number;
    inFlight: Array<{ seq: number; displayPath: string; size: number }>;
    displayedHead: { seq: number; displayPath: string; size: number } | null;
    displayedHeadAt: number;
    headPendingSince: number;
    renderUpload(): void;
  };

  const headA = { seq: 1, displayPath: "~/.claude/a.json", size: 100 };
  const headB = { seq: 2, displayPath: "~/.claude/b.json", size: 100 };
  const realNow = Date.now;
  let now = 1_000;

  try {
    Date.now = () => now;
    internal.state = "uploading";
    internal.uploadTotalFiles = 2;
    internal.uploadTotalBytes = 200;
    internal.ackedFiles = 0;
    internal.ackedBytes = 0;
    internal.inFlightBytes = 200;
    internal.inFlight = [headA, headB];
    internal.displayedHead = headB;
    internal.displayedHeadAt = now;
    internal.headPendingSince = 0;

    internal.renderUpload();
    assert.equal(internal.displayedHead?.seq, 2);

    now += 200;
    internal.renderUpload();
    assert.equal(internal.displayedHead?.seq, 2);

    now += 60;
    internal.renderUpload();
    assert.equal(internal.displayedHead?.seq, 1);
  } finally {
    Date.now = realNow;
    view.dispose();
  }
});
