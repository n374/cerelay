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
// - 两阶段渲染：扫描期单行 spinner + 计时；上传期双行（总进度 + in-flight 头部信息）
// - 100ms 节拍刷新，事件驱动只更新内部状态、不直接写 stdout，避免抖动
// - 总进度按 ack 文件/字节精确计算（不再依赖 ws.bufferedAmount 近似）
// - Pipeline 模式下同时有多个文件 in-flight；line2 显示队列头部（最早未 ack 的文件）
//   + in-flight 计数与字节总量。单文件进度条因为多文件字节混在 OS 缓冲中无法精确
//   测量，故不再展示
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

  // 渲染状态
  private renderTimer: NodeJS.Timeout | null = null;
  /** 当前在 stdout 上"占用"的渲染行数；clearLines 用它把光标恢复到顶 */
  private linesRendered = 0;
  /** spinner 自驱帧索引（不依赖 wallclock，避免暂停时位置错乱） */
  private spinnerIndex = 0;

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
        this.startTimer();
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
        this.clearLines();
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
    const line = `${colorCyan}${frame}${colorReset} 扫描 Claude 配置 (${formatDuration(elapsed)})`;
    this.out.write(line);
    this.linesRendered = 1;
  }

  private renderUpload(): void {
    const { line1, line2 } = formatUploadLines({
      frame: SPINNER_FRAMES[this.spinnerIndex],
      uploadTotalFiles: this.uploadTotalFiles,
      uploadTotalBytes: this.uploadTotalBytes,
      ackedFiles: this.ackedFiles,
      ackedBytes: this.ackedBytes,
      inFlightHead: this.inFlight[0] ?? null,
      inFlightCount: this.inFlight.length,
      inFlightBytes: this.inFlightBytes,
      columns: this.out.columns ?? 80,
    });
    this.clearLines();
    this.out.write(line1);
    if (line2) {
      this.out.write("\n");
      this.out.write(line2);
      this.linesRendered = 2;
    } else {
      this.linesRendered = 1;
    }
  }

  private clearLines(): void {
    if (this.linesRendered === 0) return;
    this.out.write("\r");
    for (let i = 0; i < this.linesRendered - 1; i += 1) {
      this.out.write("\x1b[1A");
    }
    this.out.write("\x1b[J");
    this.linesRendered = 0;
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

/**
 * 把上传期的两行 UI 拍扁为字符串，方便测试。
 * - line1：总进度（spinner + 进度条 + 百分比 + 已 ack 文件数 + 已 ack 字节）
 * - line2：当前等待 ack 的文件（→ 路径 + in-flight 计数与字节）；in-flight 为空时返回空串
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

  const line1 =
    `${colorCyan}${frame}${colorReset} 同步中 ${overallBar} ${percentText}` +
    ` (${ackedFiles}/${uploadTotalFiles} 文件,` +
    ` ${formatBytes(ackedBytes)}/${formatBytes(uploadTotalBytes)})`;

  if (!inFlightHead) {
    return { line1, line2: "" };
  }

  const tail = `  ${colorGray}(in-flight ${inFlightCount} 文件 / ${formatBytes(inFlightBytes)})${colorReset}`;
  const prefix = `  ${colorGray}→${colorReset} 当前 ack 等待: `;
  const reservedWidth = stripAnsi(prefix).length + stripAnsi(tail).length;
  const maxPathWidth = Math.max(20, columns - reservedWidth);
  const truncatedPath = truncateMiddle(inFlightHead.displayPath, maxPathWidth);
  const line2 = `${prefix}${truncatedPath}${tail}`;
  return { line1, line2 };
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
export function truncateMiddle(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  if (maxWidth <= 3) return text.slice(0, maxWidth);
  const keep = maxWidth - 1;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return text.slice(0, head) + "…" + text.slice(text.length - tail);
}

/** 简化的 ANSI 序列剥离，只用于宽度估算（不追求覆盖所有 escape 类型） */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}
