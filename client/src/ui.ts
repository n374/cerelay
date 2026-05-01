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
// 启动期进度视图（Phase 抽象）
//
// 客户端启动期目前有 3 个进度展示场景：
//   1. cache sync 扫描期（计算文件指纹）
//   2. cache sync 上传期（同步中）
//   3. PTY 启动期（正在启动 Claude Code...）
//
// 历史上这 3 个 spinner 各自独立实现，每个都被同样的 bug 模式（不到 100% 就跳完成、
// 外部 stdout 注入污染 cursor 行追踪）打中过，修复需要在每处分别落地。本模块用
// Phase 抽象统一收口：
//
// - 任何一个 phase 在任意时刻最多只有一个活跃；并发的 phase（如 cache sync 还在跑
//   时 PTY 已连接）走 pendingPhase 队列等待，禁止两个 spinner 争 stdout
// - 通用不变量在 view 层一次性实现，所有 phase 自动继承：
//     a) phase 完成前先调 forceComplete() + render() 重绘一帧 100%，避免最后一次
//        100ms tick 没赶上让 scrollback 残留中间百分比
//     b) 每次渲染所有行以 \n 收尾、cursor 落在内容下方一行的列 0；clearLines 上移
//        linesRendered 行后 `\x1b[J` 擦除；外部代码（如 `[PTY 已连接]`）想要"持久
//        写入"必须经 printPersistent，否则会污染行追踪导致脏屏
//     c) 100ms 渲染节拍由 view 持有的 timer 统一驱动，phase 切换时自动 stop/start
// - 新增 phase 只需扩展 Phase 子类即可，不必再写一个 setInterval + \r 单行覆写
// ============================================================

export interface CacheSyncProgressOptions {
  out?: NodeJS.WriteStream;
}

interface InflightItem {
  seq: number;
  displayPath: string;
  size: number;
}

type PhaseId = "scan" | "upload" | "pty-startup";

interface RenderContext {
  /** 当前 spinner 帧字符 */
  frame: string;
  /** 终端宽度（fitToColumns 用） */
  columns: number;
  /** 渲染时刻；phase 用来计时长 */
  now: number;
}

/**
 * 单一进度阶段的抽象。每个 phase 自管状态 + 怎么渲染 + 完成消息怎么写，
 * 但 100% 帧 / clearLines / 持久行 / timer 节拍这些不变量全部由 view 接管。
 */
abstract class Phase {
  abstract readonly id: PhaseId;
  /** 是否需要 100ms timer 自动重渲（spinner 动画）。默认 true */
  readonly needsTimer: boolean = true;
  /**
   * 是否在完成前调 forceComplete() 重渲一帧。只有有数字进度的 phase 才需要——
   * pty-startup 这种没有 0~100 状态的 spinner 跳过即可
   */
  readonly showsFinalFrame: boolean = true;
  /** 强行把进度推到完成态。无数字进度的 phase 是 no-op */
  forceComplete(): void {}
  /**
   * 渲染本 phase 占用的若干行（不含尾部 \n）。返回行数等于 view 写到 stdout
   * 的内容行数，view 据此维护 linesRendered。
   */
  abstract render(ctx: RenderContext): string[];
  /** 完成时的成功消息（不含尾部 \n）；返回 null 表示不写成功消息（如 pty-startup） */
  successMessage(): string | null { return null; }
}

class ScanPhase extends Phase {
  readonly id: PhaseId = "scan";
  private readonly startedAt: number;
  private hashCompleted = 0;
  private hashTotal = 0;
  private completionInfo: { totalFiles: number; totalBytes: number; elapsedMs: number } | null = null;

  constructor(now: number) {
    super();
    this.startedAt = now;
  }

  walkDone(totalFiles: number): void {
    this.hashTotal = totalFiles;
    this.hashCompleted = 0;
  }

  hashProgress(completed: number, total: number): void {
    this.hashCompleted = completed;
    this.hashTotal = total;
  }

  recordDone(info: { totalFiles: number; totalBytes: number; elapsedMs: number }): void {
    this.completionInfo = info;
  }

  override forceComplete(): void {
    if (this.hashTotal > 0) {
      this.hashCompleted = this.hashTotal;
    }
  }

  render(ctx: RenderContext): string[] {
    if (this.hashTotal > 0 || this.hashCompleted > 0) {
      return [
        formatHashProgressLine({
          frame: ctx.frame,
          completedFiles: this.hashCompleted,
          totalFiles: this.hashTotal,
          columns: ctx.columns,
        }),
      ];
    }
    return [
      fitToColumns(
        `${colorCyan}${ctx.frame}${colorReset} 扫描目录 (${formatDuration(ctx.now - this.startedAt)})`,
        ctx.columns,
      ),
    ];
  }

  override successMessage(): string | null {
    if (!this.completionInfo) return null;
    const { totalFiles, totalBytes, elapsedMs } = this.completionInfo;
    return `${colorCyan}✓${colorReset} 扫描 Claude 配置 (${totalFiles} 文件, ${formatBytes(totalBytes)}, ${formatDuration(elapsedMs)})`;
  }
}

class UploadPhase extends Phase {
  readonly id: PhaseId = "upload";
  static readonly HEAD_STABLE_MS = 250;

  private readonly uploadTotalFiles: number;
  private readonly uploadTotalBytes: number;
  /** 已 ack 文件数（精确） */
  private ackedFiles = 0;
  /** 已 ack 文件累计字节（精确） */
  private ackedBytes = 0;
  /** in-flight 队列：按 push 顺序的 FIFO；line2 取队首作为"当前 ack 等待" */
  private inFlight: InflightItem[] = [];
  /** in-flight 字节累计；line1 in-flight 段显示用 */
  private inFlightBytes = 0;
  /** line2 当前展示的队首文件；做轻微防抖避免文件名闪烁 */
  private displayedHead: InflightItem | null = null;
  private displayedHeadAt = 0;
  private headPendingSince = 0;
  private completionInfo: { totalFiles: number; totalBytes: number; elapsedMs: number } | null = null;

  constructor(totalFiles: number, totalBytes: number) {
    super();
    this.uploadTotalFiles = totalFiles;
    this.uploadTotalBytes = totalBytes;
  }

  filePushed(seq: number, displayPath: string, size: number): void {
    this.inFlight.push({ seq, displayPath, size });
    this.inFlightBytes += size;
  }

  fileAcked(seq: number, size: number): void {
    // 按 seq 从队列中移除（通常就是队首，但流控异常时可能乱序）
    const idx = this.inFlight.findIndex((item) => item.seq === seq);
    if (idx >= 0) {
      const removed = this.inFlight[idx];
      this.inFlightBytes -= removed.size;
      this.inFlight.splice(idx, 1);
    }
    // 不论成功失败都计入"已处理"——失败由 cache-sync 在 summary 里上报
    this.ackedFiles += 1;
    this.ackedBytes += size;
  }

  recordDone(info: { totalFiles: number; totalBytes: number; elapsedMs: number }): void {
    this.completionInfo = info;
  }

  override forceComplete(): void {
    this.ackedBytes = this.uploadTotalBytes;
    this.ackedFiles = this.uploadTotalFiles;
    this.inFlight = [];
    this.inFlightBytes = 0;
    this.displayedHead = null;
    this.displayedHeadAt = 0;
    this.headPendingSince = 0;
  }

  render(ctx: RenderContext): string[] {
    const { line1, line2 } = formatUploadLines({
      frame: ctx.frame,
      uploadTotalFiles: this.uploadTotalFiles,
      uploadTotalBytes: this.uploadTotalBytes,
      ackedFiles: this.ackedFiles,
      ackedBytes: this.ackedBytes,
      inFlightHead: this.resolveDisplayedHead(ctx.now),
      inFlightCount: this.inFlight.length,
      inFlightBytes: this.inFlightBytes,
      columns: ctx.columns,
    });
    return line2 ? [line1, line2] : [line1];
  }

  override successMessage(): string | null {
    if (!this.completionInfo || this.uploadTotalFiles === 0) return null;
    const { totalFiles, totalBytes, elapsedMs } = this.completionInfo;
    return `${colorGreen}✓${colorReset} 同步完成 (${totalFiles} 文件, ${formatBytes(totalBytes)}, ${formatDuration(elapsedMs)})`;
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
    const displayedStillInQueue = this.inFlight.some(
      (item) => item.seq === this.displayedHead?.seq,
    );
    if (!displayedStillInQueue) {
      return this.setDisplayedHead(currentHead, now);
    }
    if (this.headPendingSince === 0) {
      this.headPendingSince = Math.max(now, this.displayedHeadAt);
      return this.displayedHead;
    }
    if (now - this.headPendingSince >= UploadPhase.HEAD_STABLE_MS) {
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

class PtyStartupPhase extends Phase {
  readonly id: PhaseId = "pty-startup";
  /** 没有 0~100 数字进度，跳过 force-100 帧；直接 clearLines 即可 */
  override readonly showsFinalFrame = false;

  constructor(private readonly message: string = "正在启动 Claude Code...") {
    super();
  }

  render(ctx: RenderContext): string[] {
    return [
      fitToColumns(`${colorCyan}${ctx.frame}${colorReset} ${this.message}`, ctx.columns),
    ];
  }
}

/**
 * 启动期进度视图。负责：
 *   - 持有"当前活跃 phase + 等待中的 phase"；保证同一时刻只有一个 phase 在写 stdout
 *   - 100ms 渲染 timer 与 spinnerIndex 帧推进
 *   - clearLines / linesRendered 行追踪、trailing \n 不变量
 *   - phase 完成时强推 100% 重渲 + 写成功消息
 *   - printPersistent 把外部"持久行"挤到 spinner 上方
 *
 * 名字保留 `CacheSyncProgressView`（曾经只服务 cache sync），现实际承载所有启动期
 * 进度展示。沿用旧名是为了避免大面积改 import。
 */
export class CacheSyncProgressView {
  private readonly out: NodeJS.WriteStream;
  private currentPhase: Phase | null = null;
  /** cache sync 仍在跑时被 begin 的 phase（如 pty-startup）排队等当前 phase 结束 */
  private pendingPhase: Phase | null = null;

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
   * 处理来自 cache-sync 的进度事件。事件被映射到 scan / upload phase 的状态变化。
   * 事件流相对外层固定，view 内部只更新状态 + 必要时立即重绘；周期性刷新由 timer 负责。
   */
  handle(event: CacheSyncEvent): void {
    switch (event.kind) {
      case "skipped":
        // 整体跳过：不展示任何 UI（沉默降级，与旧行为一致）
        return;

      case "scan_start":
        this.beginPhase(new ScanPhase(Date.now()));
        return;

      case "walk_done": {
        const phase = this.expectPhase<ScanPhase>("scan");
        if (phase) {
          phase.walkDone(event.totalFiles);
          this.render();
        }
        return;
      }

      case "hash_progress": {
        const phase = this.expectPhase<ScanPhase>("scan");
        if (phase) {
          phase.hashProgress(event.completedFiles, event.totalFiles);
          this.render();
        }
        return;
      }

      case "scan_done": {
        const phase = this.expectPhase<ScanPhase>("scan");
        if (phase) {
          phase.recordDone({
            totalFiles: event.totalFiles,
            totalBytes: event.totalBytes,
            elapsedMs: event.elapsedMs,
          });
        }
        this.completePhase("scan");
        return;
      }

      case "upload_start":
        if (event.totalFiles === 0) {
          // 没有要上传的内容（全 unchanged 或全 skipped）——不开 phase，直接走默认排队
          this.startNextPhase();
          return;
        }
        this.beginPhase(new UploadPhase(event.totalFiles, event.totalBytes));
        return;

      case "file_pushed": {
        const phase = this.expectPhase<UploadPhase>("upload");
        phase?.filePushed(event.seq, event.displayPath, event.size);
        return;
      }

      case "file_acked": {
        const phase = this.expectPhase<UploadPhase>("upload");
        phase?.fileAcked(event.seq, event.size);
        return;
      }

      case "upload_done": {
        const phase = this.expectPhase<UploadPhase>("upload");
        if (event.aborted) {
          // abort 不写成功消息，只 clearLines 收尾——同样会触发 startNextPhase
          this.abortPhase("upload");
          return;
        }
        if (phase) {
          phase.recordDone({
            totalFiles: event.totalFiles,
            totalBytes: event.totalBytes,
            elapsedMs: event.elapsedMs,
          });
        }
        this.completePhase("upload");
        return;
      }
    }
  }

  /**
   * 启动 PTY 启动 spinner（"正在启动 Claude Code..."）。
   *
   * 如果 cache sync 还在跑（currentPhase 非空），新 phase 进 pending 队列，等当前
   * phase 结束（complete/abort/dispose）后再激活；这样保证同一时刻只有一个 spinner
   * 在写 stdout，避免两个 spinner 互相争行。
   *
   * 如果在 pending 期间用户调 endPtyStartup（PTY 在 cache sync 完成前已就绪），
   * pending phase 会被静默丢弃——没显示就没需要清理。
   */
  beginPtyStartup(message?: string): void {
    const phase = new PtyStartupPhase(message);
    if (this.currentPhase) {
      this.pendingPhase = phase;
      return;
    }
    this.beginPhase(phase);
  }

  /**
   * 结束 PTY 启动 spinner（PTY 第一帧到达 / pty_exit / 错误时调用）。
   * - 当前活跃 phase 是 pty-startup → 走 completePhase 清屏
   * - pty-startup 在 pending 队列里 → 直接丢弃
   * - 其他情况 → no-op（cache sync 还在跑、PTY 启动还没 begin 之类）
   */
  endPtyStartup(): void {
    if (this.currentPhase?.id === "pty-startup") {
      this.completePhase("pty-startup");
      return;
    }
    if (this.pendingPhase?.id === "pty-startup") {
      this.pendingPhase = null;
    }
  }

  /**
   * 在 spinner 上方写一行持久内容（如 `[PTY 已连接]`、日志路径等）。
   *
   * 设计：activePhase 与外部 stdout 写入并行时，linesRendered 只追踪我们自己写的
   * 行数，无法感知外部写入造成的 cursor 位移。一旦外部代码直接 `process.stdout.write`，
   * 下次 clearLines 用 `\x1b[1A` × linesRendered 上移就会跨过外部行，留下脏屏。
   *
   * 解决：所有持久行必须经此 API 走"先擦 spinner、写持久行、再立即重渲 spinner"
   * 三步：擦 spinner 后 cursor 落在内容首行 col 0，写持久行 + \n 后 cursor 落在新
   * 一行，re-render 让 spinner 重新出现在持久行下方。spinner 始终"占据"终端最底部。
   *
   * 没有活跃 phase 时（idle/done）：spinner 不存在，直接写。
   */
  printPersistent(content: string): void {
    const text = content.endsWith("\n") ? content : `${content}\n`;
    if (!this.currentPhase) {
      this.out.write(text);
      return;
    }
    this.clearLines();
    this.out.write(text);
    // 立即重绘 spinner 让它落到持久行下方；不等 100ms tick 否则会有短暂"消失"
    this.render();
  }

  /**
   * 当前没有任何活跃或排队的 phase 时返回 true。外层据此判断 view 是否可以
   * 安全 dispose（避免在 cache sync / pty-startup 仍跑时误关掉）。
   */
  isIdle(): boolean {
    return this.currentPhase === null && this.pendingPhase === null;
  }

  /**
   * 提前结束渲染。如果 cache sync / PTY startup 因异常没有走到正常完成事件，
   * 外层应调用此方法清掉残留 spinner 行，避免留下脏屏幕。
   */
  dispose(): void {
    this.stopTimer();
    this.clearLines();
    this.currentPhase = null;
    this.pendingPhase = null;
  }

  // ---------- 私有：phase 生命周期 ----------

  private expectPhase<T extends Phase>(id: PhaseId): T | null {
    if (this.currentPhase?.id !== id) return null;
    return this.currentPhase as T;
  }

  private beginPhase(phase: Phase): void {
    if (this.currentPhase) {
      // 防御性：上一个 phase 没 complete 就开始新的（事件流异常）→ 无消息收尾
      this.abortPhase(this.currentPhase.id);
    }
    this.currentPhase = phase;
    if (phase.needsTimer) {
      this.startTimer();
    }
    this.render();
  }

  private completePhase(id: PhaseId): void {
    if (this.currentPhase?.id !== id) return;
    const phase = this.currentPhase;
    this.stopTimer();

    // 1. 强推到完成态，重渲一帧 100%——即便最后一次 100ms tick 没赶上，
    //    或者外部 stdout 写入污染了行追踪，这一帧也会替换掉残留的旧进度行
    if (phase.showsFinalFrame) {
      phase.forceComplete();
      this.render();
    }

    // 2. 清屏，把活跃行擦干净
    this.clearLines();

    // 3. 写成功消息（如有）
    const success = phase.successMessage();
    if (success) {
      this.out.write(success.endsWith("\n") ? success : `${success}\n`);
    }

    this.currentPhase = null;
    this.startNextPhase();
  }

  private abortPhase(id: PhaseId): void {
    if (this.currentPhase?.id !== id) return;
    this.stopTimer();
    this.clearLines();
    this.currentPhase = null;
    this.startNextPhase();
  }

  private startNextPhase(): void {
    if (!this.pendingPhase) return;
    const next = this.pendingPhase;
    this.pendingPhase = null;
    this.beginPhase(next);
  }

  // ---------- 私有：渲染调度 ----------

  private startTimer(): void {
    if (this.renderTimer) return;
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
    if (!this.currentPhase) return;
    const ctx: RenderContext = {
      frame: SPINNER_FRAMES[this.spinnerIndex],
      columns: this.out.columns ?? 80,
      now: Date.now(),
    };
    const lines = this.currentPhase.render(ctx);
    this.clearLines();
    for (const line of lines) {
      this.out.write(line);
      this.out.write("\n");
    }
    this.linesRendered = lines.length;
    // 每个 tick 推进一帧（match 旧实现：先用当前 frame 渲染，再前进）
    this.spinnerIndex = (this.spinnerIndex + 1) % SPINNER_FRAMES.length;
  }

  /**
   * 把 cursor 移回最近一次 render 的内容首行并擦除到屏末。每次 render 都以 \n 收尾，
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
