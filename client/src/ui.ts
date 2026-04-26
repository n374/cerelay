import process from "node:process";
import * as readline from "node:readline";
import type { CacheSyncEvent } from "./cache-sync.js";

// ANSI 颜色码
const colorReset = "\x1b[0m";
const colorBold = "\x1b[1m";
const colorGray = "\x1b[90m";
const colorYellow = "\x1b[33m";
const colorGreen = "\x1b[32m";
const colorRed = "\x1b[31m";
const colorCyan = "\x1b[36m";

// Spinner 帧动画，与 runPtyPassthrough 内的启动 spinner 保持一致
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** 渲染节拍：100ms = 10Hz，足以平滑动画又不会让 stdout 写入过密 */
const RENDER_INTERVAL_MS = 100;

// UI 终端交互工具集
export class UI {
  // 打印 LLM 文本输出（流式，无换行）
  printText(text: string): void {
    process.stdout.write(text);
  }

  // 打印思考过程（灰色）
  printThought(text: string): void {
    process.stdout.write(`${colorGray}${text}${colorReset}`);
  }

  // 打印工具调用信息（黄色）
  printToolCall(toolName: string, params?: unknown): void {
    process.stdout.write(
      `${colorBold}${colorYellow}[工具调用] ${toolName}${colorReset}\n`
    );
    if (params !== undefined) {
      process.stdout.write(`${colorYellow}  参数: ${JSON.stringify(params)}${colorReset}\n`);
    }
  }

  // 打印工具执行结果（绿色/红色）
  printToolResult(toolName: string, success: boolean): void {
    if (success) {
      process.stdout.write(`${colorGreen}[完成] ${toolName}${colorReset}\n`);
    } else {
      process.stdout.write(`${colorRed}[失败] ${toolName}${colorReset}\n`);
    }
  }

  // 打印错误（红色，输出到 stderr）
  printError(msg: string): void {
    process.stderr.write(
      `${colorBold}${colorRed}错误: ${msg}${colorReset}\n`
    );
  }

  // 打印会话结束信息
  printSessionEnd(result?: string, error?: string): void {
    process.stdout.write(
      `\n${colorBold}${colorCyan}--- 会话结束 ---${colorReset}\n`
    );
    if (result) {
      process.stdout.write(`${colorCyan}结果: ${result}${colorReset}\n`);
    }
    if (error) {
      process.stdout.write(`${colorRed}错误: ${error}${colorReset}\n`);
    }
  }

  // 从 stdin 读取一行用户输入
  readInput(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false,
      });

      // 仅读取一行后立即关闭，避免占用 stdin
      // 先移除 close listener 再关闭，防止 close 事件误触发 EOFError
      rl.once("line", (line) => {
        rl.removeAllListeners("close");
        rl.close();
        resolve(line);
      });

      rl.once("close", () => {
        // stdin 关闭（EOF）时 reject，由调用方处理
        reject(new EOFError());
      });

      process.stdout.write(`${colorBold}${prompt}${colorReset} `);
    });
  }
}

// EOF 错误，与 io.EOF 对齐
export class EOFError extends Error {
  constructor() {
    super("EOF");
    this.name = "EOFError";
  }
}

// ============================================================
// 启动期 Cache 同步进度视图
//
// 设计要点：
// - 两阶段渲染：扫描期单行 spinner + 计时；上传期双行
//   - line1：聚合所有数字字段（总进度条、百分比、ack 文件/字节、in-flight 计数/字节）
//   - line2：仅渲染当前 ack 等待的文件路径，箭头紧贴左侧 → 路径起点恒定列，文件名
//     切换时不会左右漂移
// - 100ms 节拍刷新，事件驱动只更新内部状态、不直接写 stdout，避免抖动
// - 总进度按 ack 文件/字节精确计算（不再依赖 ws.bufferedAmount 近似）
// - 每次渲染所有行都以 \n 结尾，cursor 落在内容下方一行的列 0；clearLines 据此用
//   `\x1b[1A` × linesRendered 上移再 `\x1b[J` 擦除。一旦外部代码（如 `[PTY 已连接]`）
//   在两次 render 之间写 stdout，也只是写到独立行，不会拼接到 spinner 末尾导致脏屏
// - upload_done 时先把 ackedBytes/Files 推到 totalBytes/Files 渲染一帧 100% 状态，
//   再清屏写"✓ 同步完成"，避免最后一次 100ms tick 没赶上而让用户看到 "54.5% → 完成"
// - Pipeline 模式下同时有多个文件 in-flight；line2 取队首作为"当前 ack 等待"。单
//   文件进度条因为多文件字节混在 OS 缓冲中无法精确测量，故不再展示
// ============================================================

export interface CacheSyncProgressOptions {
  out?: NodeJS.WriteStream;
}

type ViewState = "idle" | "scanning" | "uploading" | "done";

interface InflightItem {
  seq: number;
  displayPath: string;
  size: number;
}

export class CacheSyncProgressView {
  private state: ViewState = "idle";
  private readonly out: NodeJS.WriteStream;

  // scan 阶段
  private scanStartedAt = 0;
  private hashCompletedFiles = 0;
  private hashTotalFiles = 0;

  // upload 阶段
  private uploadTotalFiles = 0;
  private uploadTotalBytes = 0;
  /** 已 ack 文件数（精确） */
  private ackedFiles = 0;
  /** 已 ack 文件累计字节（精确） */
  private ackedBytes = 0;
  /** in-flight 队列：按 push 顺序的 FIFO；line2 取队首作为"当前 ack 等待" */
  private inFlight: InflightItem[] = [];
  /** in-flight 字节累计；line2 显示用 */
  private inFlightBytes = 0;
  private uploadStartedAt = 0;
  /** line2 当前展示的队首文件；做轻微防抖避免文件名闪烁 */
  private displayedHead: InflightItem | null = null;
  private displayedHeadAt = 0;
  private headPendingSince = 0;

  // 渲染状态
  private renderTimer: NodeJS.Timeout | null = null;
  /** 当前在 stdout 上"占用"的渲染行数；clearLines 用它把光标恢复到顶 */
  private linesRendered = 0;
  /** spinner 自驱帧索引（不依赖 wallclock，避免暂停时位置错乱） */
  private spinnerIndex = 0;
  private static readonly HEAD_STABLE_MS = 250;

  constructor(options: CacheSyncProgressOptions = {}) {
    this.out = options.out ?? process.stdout;
  }

  /**
   * 处理来自 cache-sync 的进度事件。
   * 内部只更新状态 + 必要时立即重绘；周期性刷新由 timer 负责。
   */
  handle(event: CacheSyncEvent): void {
    switch (event.kind) {
      case "skipped":
        // 整体跳过：不展示任何 UI（沉默降级，与旧行为一致）
        return;

      case "scan_start":
        this.state = "scanning";
        this.scanStartedAt = Date.now();
        this.hashCompletedFiles = 0;
        this.hashTotalFiles = 0;
        this.startTimer();
        return;

      case "walk_done":
        this.hashCompletedFiles = 0;
        this.hashTotalFiles = event.totalFiles;
        this.render();
        return;

      case "hash_progress":
        this.hashCompletedFiles = event.completedFiles;
        this.hashTotalFiles = event.totalFiles;
        this.render();
        return;

      case "scan_done":
        this.stopTimer();
        this.clearLines();
        this.out.write(
          `${colorCyan}✓${colorReset} 扫描 Claude 配置 (${event.totalFiles} 文件, ${formatBytes(event.totalBytes)}, ${formatDuration(event.elapsedMs)})\n`,
        );
        return;

      case "upload_start":
        this.uploadTotalFiles = event.totalFiles;
        this.uploadTotalBytes = event.totalBytes;
        this.ackedFiles = 0;
        this.ackedBytes = 0;
        this.inFlight = [];
        this.inFlightBytes = 0;
        this.uploadStartedAt = Date.now();
        this.displayedHead = null;
        this.displayedHeadAt = 0;
        this.headPendingSince = 0;
        if (event.totalFiles === 0) {
          // 没有要上传的内容（全 unchanged 或全 skipped）
          this.state = "done";
          return;
        }
        this.state = "uploading";
        this.startTimer();
        return;

      case "file_pushed":
        this.inFlight.push({
          seq: event.seq,
          displayPath: event.displayPath,
          size: event.size,
        });
        this.inFlightBytes += event.size;
        return;

      case "file_acked": {
        // 按 seq 从队列中移除（通常就是队首，但流控异常时可能乱序）
        const idx = this.inFlight.findIndex((i) => i.seq === event.seq);
        if (idx >= 0) {
          const removed = this.inFlight[idx];
          this.inFlightBytes -= removed.size;
          this.inFlight.splice(idx, 1);
        }
        // 不论成功失败都计入"已处理"——失败由 cache-sync 在 summary 里上报
        this.ackedFiles += 1;
        this.ackedBytes += event.size;
        return;
      }

      case "upload_done":
        this.stopTimer();
        if (!event.aborted && this.uploadTotalFiles > 0) {
          // 先把进度强行推到 100% 重绘一帧——否则最后一次 100ms tick 可能没赶上，
          // 用户在 scrollback 里看到的最后"同步中"快照会停在中间百分比
          this.ackedBytes = this.uploadTotalBytes;
          this.ackedFiles = this.uploadTotalFiles;
          this.inFlight = [];
          this.inFlightBytes = 0;
          this.displayedHead = null;
          this.displayedHeadAt = 0;
          this.headPendingSince = 0;
          this.renderUpload();
        }
        this.clearLines();
        this.displayedHead = null;
        this.displayedHeadAt = 0;
        this.headPendingSince = 0;
        if (!event.aborted && this.uploadTotalFiles > 0) {
          this.out.write(
            `${colorGreen}✓${colorReset} 同步完成 (${event.totalFiles} 文件, ${formatBytes(event.totalBytes)}, ${formatDuration(event.elapsedMs)})\n`,
          );
        }
        this.state = "done";
        return;
    }
  }

  /**
   * 提前结束渲染。如果 cache-sync 因异常没有走到 upload_done，外层应调用此方法
   * 清掉残留 spinner 行，避免留下脏屏幕。
   */
  dispose(): void {
    this.stopTimer();
    this.clearLines();
    this.displayedHead = null;
    this.displayedHeadAt = 0;
    this.headPendingSince = 0;
    this.state = "done";
  }

  // ---------- 渲染调度 ----------

  private startTimer(): void {
    if (this.renderTimer) return;
    this.render();
    this.renderTimer = setInterval(() => this.render(), RENDER_INTERVAL_MS);
    if (typeof this.renderTimer.unref === "function") {
      this.renderTimer.unref();
    }
  }

  private stopTimer(): void {
    if (this.renderTimer) {
      clearInterval(this.renderTimer);
      this.renderTimer = null;
    }
  }

  private render(): void {
    if (this.state === "scanning") {
      this.renderScan();
    } else if (this.state === "uploading") {
      this.renderUpload();
    }
    // 每个 tick 推进一帧
    this.spinnerIndex = (this.spinnerIndex + 1) % SPINNER_FRAMES.length;
  }

  private renderScan(): void {
    const frame = SPINNER_FRAMES[this.spinnerIndex];
    const elapsed = Date.now() - this.scanStartedAt;
    this.clearLines();
    const columns = this.out.columns ?? 80;
    const line = this.hashTotalFiles > 0 || this.hashCompletedFiles > 0
      ? formatHashProgressLine({
        frame,
        completedFiles: this.hashCompletedFiles,
        totalFiles: this.hashTotalFiles,
        columns,
      })
      : fitToColumns(
        `${colorCyan}${frame}${colorReset} 扫描目录 (${formatDuration(elapsed)})`,
        columns,
      );
    this.out.write(line);
    this.out.write("\n");
    this.linesRendered = 1;
  }

  private renderUpload(): void {
    const now = Date.now();
    const columns = this.out.columns ?? 80;
    const { line1, line2 } = formatUploadLines({
      frame: SPINNER_FRAMES[this.spinnerIndex],
      uploadTotalFiles: this.uploadTotalFiles,
      uploadTotalBytes: this.uploadTotalBytes,
      ackedFiles: this.ackedFiles,
      ackedBytes: this.ackedBytes,
      inFlightHead: this.resolveDisplayedHead(now),
      inFlightCount: this.inFlight.length,
      inFlightBytes: this.inFlightBytes,
      columns,
    });
    this.clearLines();
    this.out.write(line1);
    this.out.write("\n");
    if (line2) {
      this.out.write(line2);
      this.out.write("\n");
      this.linesRendered = 2;
    } else {
      this.linesRendered = 1;
    }
  }

  /**
   * 把 cursor 移回最近一次 render 的内容首行并擦除到屏末。每次 render 都以 \n 结尾，
   * 因此调用前 cursor 必然处于内容下方一行的列 0：上移 linesRendered 行即可对齐到首行。
   */
  private clearLines(): void {
    if (this.linesRendered === 0) return;
    this.out.write("\r");
    for (let i = 0; i < this.linesRendered; i += 1) {
      this.out.write("\x1b[1A");
    }
    this.out.write("\x1b[J");
    this.linesRendered = 0;
  }

  private resolveDisplayedHead(now: number): InflightItem | null {
    const currentHead = this.inFlight[0] ?? null;
    if (!currentHead) {
      return this.setDisplayedHead(null, now);
    }
    if (!this.displayedHead) {
      return this.setDisplayedHead(currentHead, now);
    }
    if (this.displayedHead.seq === currentHead.seq) {
      if (this.displayedHeadAt === 0) {
        this.displayedHeadAt = now;
      }
      this.headPendingSince = 0;
      return this.displayedHead;
    }
    const displayedStillInQueue = this.inFlight.some((item) => item.seq === this.displayedHead?.seq);
    if (!displayedStillInQueue) {
      return this.setDisplayedHead(currentHead, now);
    }
    if (this.headPendingSince === 0) {
      this.headPendingSince = Math.max(now, this.displayedHeadAt);
      return this.displayedHead;
    }
    if (now - this.headPendingSince >= CacheSyncProgressView.HEAD_STABLE_MS) {
      return this.setDisplayedHead(currentHead, now);
    }
    return this.displayedHead;
  }

  private setDisplayedHead(next: InflightItem | null, now: number): InflightItem | null {
    this.displayedHead = next;
    this.displayedHeadAt = next ? now : 0;
    this.headPendingSince = 0;
    return this.displayedHead;
  }
}

// ---------- 渲染纯函数（便于单测） ----------

interface FormatUploadLinesArgs {
  frame: string;
  uploadTotalFiles: number;
  uploadTotalBytes: number;
  ackedFiles: number;
  ackedBytes: number;
  /** in-flight 队列头部（最早未 ack）；为空表示当前没有 in-flight */
  inFlightHead: InflightItem | null;
  inFlightCount: number;
  inFlightBytes: number;
  columns: number;
}

interface FormatHashProgressLineArgs {
  frame: string;
  completedFiles: number;
  totalFiles: number;
  columns: number;
}

/**
 * 把上传期的两行 UI 拍扁为字符串，方便测试。
 * - line1：聚合所有数字字段——spinner + 进度条 + 百分比 + ack 文件数 + ack 字节 +
 *   (可选) in-flight 计数/字节。`·` 作为视觉分隔符
 * - line2：仅渲染当前 ack 等待的文件路径（`→ <path>`）。in-flight 为空时返回空串。
 *   箭头紧贴左侧边缘 → 路径起点保持恒定列，文件名切换时不会左右漂移
 */
export function formatUploadLines(args: FormatUploadLinesArgs): { line1: string; line2: string } {
  const {
    frame,
    uploadTotalFiles,
    uploadTotalBytes,
    ackedFiles,
    ackedBytes,
    inFlightHead,
    inFlightCount,
    inFlightBytes,
    columns,
  } = args;

  // 总进度按 ack 字节精确计算
  const overallRatio = uploadTotalBytes > 0 ? ackedBytes / uploadTotalBytes : 1;
  const overallBar = renderBar(overallRatio, 10);
  const percentText = `${(Math.min(1, Math.max(0, overallRatio)) * 100).toFixed(1).padStart(5)}%`;

  const separator = `  ${colorGray}·${colorReset}  `;
  const segments: string[] = [
    `${colorCyan}${frame}${colorReset} 同步中`,
    overallBar,
    percentText,
    `${ackedFiles}/${uploadTotalFiles} 文件`,
    `${formatBytes(ackedBytes)}/${formatBytes(uploadTotalBytes)}`,
  ];
  if (inFlightCount > 0) {
    segments.push(
      `${colorGray}in-flight ${inFlightCount} / ${formatBytes(inFlightBytes)}${colorReset}`,
    );
  }
  const line1 = fitToColumns(segments.join(separator), columns);

  if (!inFlightHead) {
    return { line1, line2: "" };
  }

  const prefix = `  ${colorGray}→${colorReset} `;
  const maxPathWidth = Math.max(0, columns - displayWidth(prefix));
  const truncatedPath = truncateMiddle(inFlightHead.displayPath, maxPathWidth);
  const line2 = fitToColumns(`${prefix}${truncatedPath}`, columns);
  return { line1, line2 };
}

export function formatHashProgressLine(args: FormatHashProgressLineArgs): string {
  const totalFiles = Math.max(0, args.totalFiles);
  const completedFiles = Math.max(0, Math.min(args.completedFiles, totalFiles));
  const ratio = totalFiles > 0 ? completedFiles / totalFiles : 1;
  const bar = renderBar(ratio, 10);
  const percentText = `${(Math.min(1, Math.max(0, ratio)) * 100).toFixed(1).padStart(5)}%`;
  return fitToColumns(
    `${colorCyan}${args.frame}${colorReset} 计算文件指纹 ${bar} ${percentText}` +
    ` (已 hash ${completedFiles}/${totalFiles} 文件)`,
    args.columns,
  );
}

/** 进度条：固定宽度，█ 满 / ░ 空 */
export function renderBar(ratio: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * width);
  return "[" + "█".repeat(filled) + "░".repeat(width - filled) + "]";
}

/** 字节格式化：自动选 B/KB/MB/GB，保留 1 位小数（B 不带小数） */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** 时长格式化：< 1s 显示 ms，< 60s 显示 1 位小数秒，更长显示 mMs 格式 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

/** 中间省略截断：保留前后两段，超长时插入 … */
export function truncateMiddle(text: string, maxDisplayWidth: number): string {
  if (maxDisplayWidth <= 0) return "";
  if (displayWidth(text) <= maxDisplayWidth) return text;
  if (maxDisplayWidth === 1) return "…";

  const glyphs = [...text];
  const keepWidth = maxDisplayWidth - 1;
  const headBudget = Math.ceil(keepWidth / 2);
  const tailBudget = keepWidth - headBudget;

  let headEnd = 0;
  let headWidth = 0;
  while (headEnd < glyphs.length) {
    const nextWidth = displayWidth(glyphs[headEnd]);
    if (headWidth + nextWidth > headBudget) break;
    headWidth += nextWidth;
    headEnd += 1;
  }

  let tailStart = glyphs.length;
  let tailWidth = 0;
  while (tailStart > headEnd) {
    const nextWidth = displayWidth(glyphs[tailStart - 1]);
    if (tailWidth + nextWidth > tailBudget) break;
    tailWidth += nextWidth;
    tailStart -= 1;
  }

  return glyphs.slice(0, headEnd).join("") + "…" + glyphs.slice(tailStart).join("");
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const glyph of stripAnsi(text)) {
    const codePoint = glyph.codePointAt(0);
    if (codePoint === undefined) continue;
    if (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x200d ||
      isVariationSelector(codePoint) ||
      COMBINING_MARK_RE.test(glyph)
    ) {
      continue;
    }
    width += isWideGlyph(glyph, codePoint) ? 2 : 1;
  }
  return width;
}

function fitToColumns(line: string, columns: number): string {
  const targetWidth = Math.max(1, columns);
  const visibleWidth = displayWidth(line);
  if (visibleWidth <= targetWidth) {
    return line + " ".repeat(targetWidth - visibleWidth);
  }
  if (targetWidth === 1) {
    return "…";
  }

  const truncated = sliceAnsiByDisplayWidth(line, targetWidth - 1);
  let fitted = `${truncated.text}…`;
  if (truncated.hasOpenStyle && !fitted.endsWith(colorReset)) {
    fitted += colorReset;
  }
  return fitted + " ".repeat(Math.max(0, targetWidth - displayWidth(fitted)));
}

/** 简化的 ANSI 序列剥离，只用于宽度估算（不追求覆盖所有 escape 类型） */
function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN_GLOBAL, "");
}

function sliceAnsiByDisplayWidth(text: string, maxWidth: number): { text: string; hasOpenStyle: boolean } {
  let out = "";
  let width = 0;
  let offset = 0;
  let hasOpenStyle = false;

  while (offset < text.length) {
    const ansi = matchAnsiAt(text, offset);
    if (ansi) {
      out += ansi;
      offset += ansi.length;
      if (ansi.endsWith("m")) {
        hasOpenStyle = !RESET_SGR_RE.test(ansi);
      }
      continue;
    }

    const glyph = text.slice(offset, offset + (text.codePointAt(offset)! > 0xffff ? 2 : 1));
    const glyphWidth = displayWidth(glyph);
    if (width + glyphWidth > maxWidth) {
      break;
    }
    out += glyph;
    width += glyphWidth;
    offset += glyph.length;
  }

  return { text: out, hasOpenStyle };
}

function matchAnsiAt(text: string, offset: number): string | null {
  const match = ANSI_PATTERN_STICKY.exec(text.slice(offset));
  return match?.index === 0 ? match[0] : null;
}

function isVariationSelector(codePoint: number): boolean {
  return (
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  );
}

function isWideGlyph(glyph: string, codePoint: number): boolean {
  return EXTENDED_PICTOGRAPHIC_RE.test(glyph) || isFullWidthCodePoint(codePoint);
}

function isFullWidthCodePoint(codePoint: number): boolean {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0x3247 && codePoint !== 0x303f) ||
    (codePoint >= 0x3250 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0xa4c6) ||
    (codePoint >= 0xa960 && codePoint <= 0xa97c) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6b) ||
    (codePoint >= 0xff01 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1b000 && codePoint <= 0x1b2ff) ||
    (codePoint >= 0x1f200 && codePoint <= 0x1f251) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

const ANSI_PATTERN_GLOBAL = /\x1b\[[0-9;]*[A-Za-z]/g;
const ANSI_PATTERN_STICKY = /^\x1b\[[0-9;]*[A-Za-z]/;
const RESET_SGR_RE = /^\x1b\[(?:0)?m$/;
const COMBINING_MARK_RE = /\p{Mark}/u;
const EXTENDED_PICTOGRAPHIC_RE = /\p{Extended_Pictographic}/u;
