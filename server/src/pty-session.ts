import { type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import type { ClaudeSessionRuntime, SpawnOptions, SpawnedProcess } from "./claude-session-runtime.js";
import { createLogger, type Logger } from "./logger.js";
import { ToolRelay, type RemoteToolResult } from "./relay.js";
import { randomUUID } from "node:crypto";
import { PYTHON_PTY_HOST_SCRIPT } from "./pty-host-script.js";
import {
  renderToolResultForClaude,
  rewriteToolInputForClient,
  type HookInput,
  type SyncHookJsonOutput,
} from "./claude-tool-bridge.js";
import { resolveClaudeCodeExecutable } from "./claude-executable.js";
import { isClientRoutedToolName } from "./tool-routing.js";

const log = createLogger("pty-session");

export interface PtySessionTransport {
  sendOutput(sessionId: string, data: Buffer): Promise<void>;
  sendExit(sessionId: string, exitCode?: number, signal?: string): Promise<void>;
  sendToolCall(sessionId: string, requestId: string, toolName: string, toolUseId: string | undefined, input: unknown): Promise<void>;
  sendToolCallComplete(sessionId: string, requestId: string, toolName: string): Promise<void>;
}

export interface ClaudePtySessionOptions {
  id: string;
  cwd: string;
  model?: string;
  runtime: ClaudeSessionRuntime;
  transport: PtySessionTransport;
  term?: string;
  colorTerm?: string;
  termProgram?: string;
  termProgramVersion?: string;
  clientHomeDir?: string;
  shouldRouteToolToClient?: (toolName: string) => boolean;
}

export class ClaudePtySession {
  readonly id: string;
  readonly cwd: string;

  private readonly model?: string;
  private readonly runtime: ClaudeSessionRuntime;
  private readonly transport: PtySessionTransport;
  private readonly term?: string;
  private readonly colorTerm?: string;
  private readonly termProgram?: string;
  private readonly termProgramVersion?: string;
  private readonly clientHomeDir?: string;
  private readonly shouldRouteToolToClient: (toolName: string) => boolean;
  private readonly relay = new ToolRelay();
  private readonly log: Logger;
  private child: ChildProcess | null = null;
  private helperDir: string | null = null;
  private controlStream: NodeJS.WritableStream | null = null;
  private readonly abortController = new AbortController();
  private started = false;
  private closed = false;

  constructor(options: ClaudePtySessionOptions) {
    this.id = options.id;
    this.cwd = options.cwd;
    this.model = options.model;
    this.runtime = options.runtime;
    this.transport = options.transport;
    this.term = options.term;
    this.colorTerm = options.colorTerm;
    this.termProgram = options.termProgram;
    this.termProgramVersion = options.termProgramVersion;
    this.clientHomeDir = options.clientHomeDir?.trim() || undefined;
    this.shouldRouteToolToClient = options.shouldRouteToolToClient ?? ((toolName) => isClientRoutedToolName(toolName));
    this.log = log.child({
      sessionId: this.id,
      cwd: this.cwd,
      model: this.model,
    });
  }

  async start(cols: number, rows: number): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;

    const spawnInRuntime = this.runtime.spawnInRuntime ?? defaultSpawnInRuntime;
    const helperPath = await this.ensureHelperScript();
    const commandLine = buildClaudeCommandArgs(this.model);
    this.log.debug("启动 Claude PTY passthrough 会话", {
      cols,
      rows,
      helperPath,
      command: commandLine[0],
      args: commandLine.slice(1),
    });

    this.child = spawnInRuntime({
      command: "python3",
      args: [helperPath, ...commandLine],
      cwd: this.runtime.cwd,
      env: {
        ...this.runtime.env,
        TERM: this.term || this.runtime.env.TERM || "xterm-256color",
        COLORTERM: this.colorTerm || this.runtime.env.COLORTERM || "truecolor",
        TERM_PROGRAM: this.termProgram || this.runtime.env.TERM_PROGRAM,
        TERM_PROGRAM_VERSION: this.termProgramVersion || this.runtime.env.TERM_PROGRAM_VERSION,
        CLICOLOR_FORCE: "1",
        FORCE_COLOR: "3",
        CERELAY_PTY_COLS: String(Math.max(cols, 1)),
        CERELAY_PTY_ROWS: String(Math.max(rows, 1)),
        CERELAY_PTY_CONTROL_FD: "3",
      },
      signal: this.abortController.signal,
      extraPipeCount: 1,
    });
    this.controlStream = (this.child.stdio[3] as NodeJS.WritableStream | undefined) ?? null;
    if (this.controlStream && "on" in this.controlStream) {
      this.controlStream.on("error", () => undefined);
    }

    // 启动诊断：如果子进程长时间无 stdout 输出，打印 warn 日志辅助排查
    let gotFirstOutput = false;
    const startupDiagTimer = setTimeout(() => {
      if (!gotFirstOutput && !this.closed) {
        this.log.warn("PTY 子进程启动后 5 秒内无 stdout 输出，可能卡在 FUSE 文件代理或进程启动阶段", {
          command: commandLine[0],
          args: commandLine.slice(1),
          pid: this.child?.pid,
        });
      }
    }, 5_000);

    this.child.stdout?.on("data", (chunk: Buffer) => {
      if (!gotFirstOutput) {
        gotFirstOutput = true;
        clearTimeout(startupDiagTimer);
        this.log.info("PTY 首次 stdout 输出", { bytes: chunk.length });
      }
      void this.transport.sendOutput(this.id, Buffer.from(chunk)).catch((err) => {
        this.log.warn("PTY stdout 转发失败", { error: err instanceof Error ? err.message : String(err) });
      });
    });
    this.child.stderr?.on("data", (chunk: Buffer) => {
      void this.transport.sendOutput(this.id, Buffer.from(chunk)).catch((err) => {
        this.log.warn("PTY stderr 转发失败", { error: err instanceof Error ? err.message : String(err) });
      });
    });
    this.child.on("exit", (code, signal) => {
      clearTimeout(startupDiagTimer);
      // 注意：此处的 child 是 pty_host.py helper，不是 CC 本身；helper 在 CC 死后
      // 还要走 master_fd close + thread join(0.2s ×2) + proc.wait + sys.exit，
      // 因此 'exit' 比 CC 实际退出晚约 400-500ms。这条日志记录 helper 退出时间，
      // 与下方 'close' 触发的 "PTY Session 已销毁" 之间的差值即 stdio drain 耗时，
      // 用于诊断退出延迟究竟在 CC、helper 还是 Node stdio 三段中的哪一段。
      this.log.info("Claude PTY helper 进程退出", {
        exitCode: code ?? undefined,
        signal: signal ?? undefined,
      });
      // 注意：不在 exit 事件中触发 sendExit / close，因为 exit 早于 stdio 流关闭。
      // 如果在此处 destroyPtySession，stdout pipe 中尚未读取的 PTY 输出会因
      // session entry 被删除而在 sendOutput 中静默丢失（.catch(() => undefined)）。
    });
    this.child.on("close", (code, signal) => {
      // close 事件在所有 stdio 流关闭后触发，确保 stdout data 全部被
      // 读取并通过 sendOutput 发出后，才发送 pty_exit 并清理 session。
      void this.transport.sendExit(this.id, code ?? undefined, signal ?? undefined).catch(() => undefined);
      void this.close();
    });
    this.child.on("error", (error) => {
      this.log.warn("Claude PTY 会话异常", {
        error: error.message,
      });
      void this.transport.sendOutput(this.id, Buffer.from(`\r\n[cerelay] PTY error: ${error.message}\r\n`, "utf8")).catch(() => undefined);
    });
  }

  write(data: Buffer): void {
    if (!this.child?.stdin || this.child.stdin.destroyed) {
      return;
    }
    this.child.stdin.write(data);
  }

  resize(cols: number, rows: number): void {
    this.log.debug("收到 PTY resize 请求", { cols, rows });
    this.sendControlMessage({
      type: "resize",
      cols: Math.max(cols, 1),
      rows: Math.max(rows, 1),
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    this.relay.cleanup();
    this.abortController.abort();
    this.sendControlMessage({ type: "close" });
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
    }
    this.controlStream = null;
    if (this.helperDir) {
      await rm(this.helperDir, { recursive: true, force: true }).catch(() => undefined);
      this.helperDir = null;
    }
    await this.runtime.cleanup().catch(() => undefined);
  }

  resolveToolResult(requestId: string, result: RemoteToolResult): void {
    this.relay.resolve(requestId, result);
  }

  async handleInjectedPreToolUse(input: HookInput): Promise<SyncHookJsonOutput> {
    if (this.closed) {
      throw new Error("会话已关闭");
    }

    this.log.info("收到 PTY PreToolUse hook", {
      toolName: input.tool_name,
      toolUseId: input.tool_use_id,
      inputSummary: summarizeUnknown(input.tool_input),
    });

    if (!this.shouldRouteToolToClient(input.tool_name)) {
      this.log.info("PTY tool 未配置为通过 Client 转发，直接放行", {
        toolName: input.tool_name,
      });
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: `Tool ${input.tool_name} approved`,
        },
      };
    }

    const result = await this.executeToolViaClient(input.tool_name, input.tool_input, input.tool_use_id);
    const rendered = renderToolResultForClaude(input.tool_name, result);
    // CC `cli.js` 在 deny 分支会把 permissionDecisionReason 直接写进
    // tool_result.content（is_error: true）反馈给模型；additionalContext 走
    // 独立的 <system-reminder> 文本块。两条都会到达 LLM，但 tool_result 是
    // 模型最直接的反馈通道，additionalContext 则被裹在 "PreToolUse:Bash hook
    // additional context: ..." 的元消息前缀里，模型不一定能稳定地把它当成
    // 工具的真实输出来用——实测会出现 tool_result.is_error=true 让 Claude
    // 判定工具失败、再忽略 system-reminder 的情况。
    // 因此把渲染后的工具结果同步塞进 permissionDecisionReason，让
    // tool_result.content 自身就携带真实数据；additionalContext 保留作为
    // 冗余通道。空输出时回退到占位串以保 deny 协议非空 reason 不变量。
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: rendered.length > 0 ? rendered : "Tool response ready",
        additionalContext: rendered,
      },
    };
  }

  private async ensureHelperScript(): Promise<string> {
    if (this.helperDir) {
      return path.join(this.helperDir, "pty_host.py");
    }

    this.helperDir = await mkdtemp(path.join(tmpdir(), "cerelay-pty-host-"));
    const helperPath = path.join(this.helperDir, "pty_host.py");
    await writeFile(helperPath, PYTHON_PTY_HOST_SCRIPT, "utf8");
    await chmod(helperPath, 0o755);
    return helperPath;
  }

  private sendControlMessage(message: Record<string, unknown>): void {
    if (!this.controlStream || "destroyed" in this.controlStream && this.controlStream.destroyed) {
      return;
    }
    try {
      this.controlStream.write(`${JSON.stringify(message)}\n`, () => undefined);
    } catch {
      // ignore closed control pipe races during shutdown
    }
  }

  private async executeToolViaClient(toolName: string, toolInput: unknown, toolUseId?: string): Promise<RemoteToolResult> {
    if (this.closed) {
      throw new Error("会话已关闭");
    }

    const rewrittenInput = rewriteToolInputForClient(toolName, toolInput, {
      serverHomeDir: this.runtime.env.HOME?.trim() || process.env.HOME || "/home/node",
      clientHomeDir: this.clientHomeDir,
      serverCwd: this.runtime.cwd,
      clientCwd: this.cwd,
    });
    const requestId = `hook-${this.id}-${randomUUID()}`;
    const pending = this.relay.createPending(requestId, toolName);
    void pending.catch(() => undefined);

    this.log.info("PTY tool 准备转发到 Client", {
      requestId,
      toolName,
      toolUseId,
      inputSummary: summarizeUnknown(rewrittenInput),
    });

    try {
      await this.transport.sendToolCall(this.id, requestId, toolName, toolUseId, rewrittenInput);
      this.log.info("PTY tool 已发送到 Client", {
        requestId,
        toolName,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.log.warn("PTY tool 发送到 Client 失败", {
        requestId,
        toolName,
        error: err.message,
      });
      this.relay.reject(requestId, err);
      throw err;
    }

    const result = await pending;
    this.log.info("PTY tool 收到 Client 结果", {
      requestId,
      toolName,
      hasError: Boolean(result.error),
      outputSummary: summarizeUnknown(result.output),
    });
    await this.transport.sendToolCallComplete(this.id, requestId, toolName);
    return result;
  }
}

function summarizeUnknown(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "string") {
    return previewText(value, 120);
  }
  try {
    return previewText(JSON.stringify(value), 120);
  } catch {
    return String(value);
  }
}

function previewText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}...`;
}

function defaultSpawnInRuntime(options: SpawnOptions): SpawnedProcess {
  throw new Error(`session runtime does not support PTY spawn: ${options.command}`);
}

function buildClaudeCommandArgs(model: string | undefined): string[] {
  const override = process.env.CERELAY_PTY_COMMAND?.trim();
  if (override) {
    return ["/bin/sh", "-lc", override];
  }

  return [
    resolveClaudeCodeExecutable(),
    ...(model ? ["--model", model] : []),
  ];
}
