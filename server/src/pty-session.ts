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
import { MCPIpcHost, buildMcpIpcSocketPath } from "./mcp-ipc-host.js";
import {
  buildShadowFallbackReason,
  buildShadowMcpInjectionArgs,
  SHADOWED_BUILTIN_TOOL_SET,
} from "./mcp-cc-injection.js";

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
  /**
   * 启动诊断：用于在 PTY 子进程启动后周期性 log "尚未首次 stdout" 时合并 FUSE
   * 活动统计。返回 undefined 表示无 file-proxy 上下文（裸 runtime / 测试 stub）。
   */
  getFileProxyStartupStats?: () => unknown;
  /**
   * Plan D shadow MCP 注入开关。enabled=true 时 ClaudePtySession 会：
   * 1. 启动 per-session MCPIpcHost（unix socket）
   * 2. spawn CC 时追加 --mcp-config / --append-system-prompt / --disallowedTools
   * 3. session 关闭时关 host
   *
   * 默认从 CERELAY_ENABLE_SHADOW_MCP env 读，缺省 false（Phase 3 灰度阶段保守
   * 关闭，避免 ALL 用户 PTY session 受影响）。Phase 6 落地 e2e 守护后再翻
   * 默认值。CERELAY_PTY_COMMAND override 路径下永远 disabled。
   */
  shadowMcp?: {
    enabled: boolean;
    /**
     * unix socket 父目录。优先级：options.socketDir > CERELAY_SHADOW_MCP_SOCKET_DIR env >
     * `${CERELAY_DATA_DIR}/sockets/` > `/tmp` 兜底。
     */
    socketDir?: string;
  };
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
  private readonly shadowMcpEnabled: boolean;
  private readonly shadowMcpSocketDir: string;
  private readonly relay = new ToolRelay();
  private readonly log: Logger;
  private child: ChildProcess | null = null;
  private helperDir: string | null = null;
  private controlStream: NodeJS.WritableStream | null = null;
  private readonly abortController = new AbortController();
  private started = false;
  private closed = false;
  private mcpIpcHost: MCPIpcHost | null = null;
  private readonly getFileProxyStartupStats?: () => unknown;

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
    this.shadowMcpEnabled = options.shadowMcp?.enabled ?? readShadowMcpEnvDefault();
    this.shadowMcpSocketDir = options.shadowMcp?.socketDir ?? resolveShadowMcpSocketDir();
    this.getFileProxyStartupStats = options.getFileProxyStartupStats;
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

    // Plan D：启动 per-session MCPIpcHost，把 socketPath/token 注入到 CC 启动参数。
    // CERELAY_PTY_COMMAND override（测试用）下不注入，因为那条路径根本不跑真实 CC。
    let mcpInjectionArgs: string[] = [];
    if (this.shadowMcpEnabled && !process.env.CERELAY_PTY_COMMAND?.trim()) {
      mcpInjectionArgs = await this.startShadowMcpHost();
    }

    const commandLine = buildClaudeCommandArgs(this.model, mcpInjectionArgs);
    this.log.debug("启动 Claude PTY passthrough 会话", {
      cols,
      rows,
      helperPath,
      command: commandLine[0],
      args: commandLine.slice(1),
      shadowMcpEnabled: this.shadowMcpEnabled && mcpInjectionArgs.length > 0,
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

    const spawnedAt = Date.now();
    const childPid = this.child?.pid;
    this.log.info("PTY 子进程已 spawn", {
      pid: childPid,
      command: commandLine[0],
    });

    // 启动诊断：从 spawn 起每 5s 周期打印 "尚未首次 stdout"。让用户在长时间无输出
    // 时直接从日志看到：FUSE 是否还在转发请求、pending 多少、累计 round-trip 多久。
    // 如果 FUSE 计数器全为 0 → 瓶颈在 CC 自身（spawn MCP 子进程 / 网络 / API 等）。
    let gotFirstOutput = false;
    let totalOutputBytes = 0;
    let totalOutputChunks = 0;
    let lastOutputStatsLoggedAt = 0;
    const startupDiagTimer = setInterval(() => {
      if (gotFirstOutput || this.closed) {
        clearInterval(startupDiagTimer);
        return;
      }
      const elapsedMs = Date.now() - spawnedAt;
      this.log.warn("PTY 子进程启动后尚未输出 stdout", {
        elapsedMs,
        pid: childPid,
        fileProxyStats: this.getFileProxyStartupStats?.(),
      });
    }, 5_000);
    startupDiagTimer.unref?.();

    this.child.stdout?.on("data", (chunk: Buffer) => {
      totalOutputBytes += chunk.length;
      totalOutputChunks++;
      if (!gotFirstOutput) {
        gotFirstOutput = true;
        clearInterval(startupDiagTimer);
        const elapsedMs = Date.now() - spawnedAt;
        this.log.info("PTY 首次 stdout 输出", {
          bytes: chunk.length,
          elapsedMsSinceSpawn: elapsedMs,
          fileProxyStats: this.getFileProxyStartupStats?.(),
        });
        lastOutputStatsLoggedAt = Date.now();
      } else if (Date.now() - lastOutputStatsLoggedAt >= 5_000) {
        // 首次 stdout 之后，每 5s 输出一次累计量。CC 启动期 TUI 有时会分多次写入
        // （边读 FUSE 边输出），用户观感上需要 N 秒后界面才稳定。这条日志反映出
        // 真实的输出节奏，方便区分 "server 没数据" vs "client 没渲染"。
        this.log.info("PTY stdout 累计输出统计", {
          totalBytes: totalOutputBytes,
          totalChunks: totalOutputChunks,
          elapsedMsSinceFirstOutput: Date.now() - spawnedAt,
        });
        lastOutputStatsLoggedAt = Date.now();
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
      clearInterval(startupDiagTimer);
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
    // 关 mcp host 在 runtime cleanup 之前——避免 mcp 子进程残留 fd 阻塞
    // unmount/cleanup 流程。host.close 内部 unlink socket 文件 + destroy 活跃连接。
    if (this.mcpIpcHost) {
      const host = this.mcpIpcHost;
      this.mcpIpcHost = null;
      await host.close().catch((err) => {
        this.log.debug("关闭 MCPIpcHost 失败（忽略）", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    if (this.helperDir) {
      await rm(this.helperDir, { recursive: true, force: true }).catch(() => undefined);
      this.helperDir = null;
    }
    await this.runtime.cleanup().catch(() => undefined);
  }

  resolveToolResult(requestId: string, result: RemoteToolResult): void {
    this.relay.resolve(requestId, result);
  }

  /**
   * 公开给 cerelay-routed MCP 子进程通过 MCPIpcHost 调用的 dispatch API。
   * 内部走与 PreToolUse hook 路径相同的 client-routed 转发链：路径重写 →
   * relay → ws → client → tool 执行 → relay resolve → 返回原始 RemoteToolResult。
   *
   * 跟 handleInjectedPreToolUse 的区别：
   * - 不裹 hook 协议返回（CallToolResult 由子进程的 handler 渲染）
   * - 没有 toolUseId（MCP tools/call 本身不用 anthropic tool_use_id）
   */
  async dispatchToolToClient(toolName: string, input: unknown): Promise<RemoteToolResult> {
    return this.executeToolViaClient(toolName, input, undefined, "mcp");
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

    // Plan D §4.5：shadow MCP 已启用 + 模型违规调用了被 disallowedTools 列入
    // 黑名单的内置工具（Bash/Read/Write/Edit/MultiEdit/Glob/Grep）→ 不执行，
    // deny + permissionDecisionReason 引导模型改用 mcp__cerelay__X 替代。
    // 模型下一轮会改用 shadow 版本，本轮仅浪费一次 round-trip。
    if (this.mcpIpcHost && SHADOWED_BUILTIN_TOOL_SET.has(input.tool_name)) {
      const fallback = buildShadowFallbackReason(input.tool_name);
      if (fallback) {
        this.log.info("PTY tool 命中 shadow 黑名单，引导模型改用 mcp__cerelay__*", {
          toolName: input.tool_name,
        });
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: fallback,
            additionalContext: fallback,
          },
        };
      }
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

  /**
   * 启动 per-session MCPIpcHost 并返回需要追加到 CC 启动命令的 CLI flags。
   * 出错时不抛出（保留"MCP 起不来时退回纯 hook 路径"的 G5 不变量）。
   */
  private async startShadowMcpHost(): Promise<string[]> {
    const token = randomUUID();
    const socketPath = buildMcpIpcSocketPath(this.shadowMcpSocketDir, this.id);
    const host = new MCPIpcHost({
      sessionId: this.id,
      socketPath,
      token,
      dispatcher: (toolName, input) => this.dispatchToolToClient(toolName, input),
    });
    try {
      await host.start();
    } catch (err) {
      this.log.warn("启动 MCPIpcHost 失败，退回纯 hook 路径（不阻塞 session）", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
    this.mcpIpcHost = host;
    return buildShadowMcpInjectionArgs({
      sessionId: this.id,
      socketPath,
      token,
    });
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

  private async executeToolViaClient(
    toolName: string,
    toolInput: unknown,
    toolUseId?: string,
    /** 调用来源标签，用于 requestId 前缀区分 PreToolUse hook 与 MCP dispatch 路径。 */
    origin: "hook" | "mcp" = "hook",
  ): Promise<RemoteToolResult> {
    if (this.closed) {
      throw new Error("会话已关闭");
    }

    const rewrittenInput = rewriteToolInputForClient(toolName, toolInput, {
      serverHomeDir: this.runtime.env.HOME?.trim() || process.env.HOME || "/home/node",
      clientHomeDir: this.clientHomeDir,
      serverCwd: this.runtime.cwd,
      clientCwd: this.cwd,
    });
    const requestId = `${origin}-${this.id}-${randomUUID()}`;
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

/**
 * 从 CERELAY_ENABLE_SHADOW_MCP env 读默认开关。
 *
 * 默认 true（Plan D 已经在 server workspace 159 单测 + e2e-mcp-shadow-bash 守护下
 * 稳定）。只有显式设为 "false" / "0" / "no" / "off" 才会关闭——主要给以下场景：
 *   - 老用户回退到 legacy hook 路径排查问题
 *   - 不希望注入 --disallowedTools 的特殊环境
 * CERELAY_PTY_COMMAND override 路径下永远 disabled（与 mcp 注入无关的 stub 测试）。
 */
function readShadowMcpEnvDefault(): boolean {
  const raw = process.env.CERELAY_ENABLE_SHADOW_MCP?.trim().toLowerCase();
  if (raw === undefined || raw === "") return true;
  return !(raw === "0" || raw === "false" || raw === "no" || raw === "off");
}

/**
 * 解析 shadow MCP unix socket 父目录：
 *   1. CERELAY_SHADOW_MCP_SOCKET_DIR env（运维显式覆盖）
 *   2. ${CERELAY_DATA_DIR}/sockets/（与项目其他持久化路径对齐）
 *   3. /tmp 兜底
 * 注意：buildMcpIpcSocketPath 自身有 macOS 104 byte 长度硬限制，过长目录会抛错。
 */
function resolveShadowMcpSocketDir(): string {
  const explicit = process.env.CERELAY_SHADOW_MCP_SOCKET_DIR?.trim();
  if (explicit) {
    return explicit;
  }
  const dataDir = process.env.CERELAY_DATA_DIR?.trim();
  if (dataDir) {
    return path.join(dataDir, "sockets");
  }
  return "/tmp";
}

function buildClaudeCommandArgs(model: string | undefined, extraArgs: string[] = []): string[] {
  const override = process.env.CERELAY_PTY_COMMAND?.trim();
  if (override) {
    // Test/dev override 下不混入 mcp 注入——override 通常用于跑 cat / sh
    // 一类的 stub，传入 --mcp-config 会让 stub 把它当成 stdin 输入。
    return ["/bin/sh", "-lc", override];
  }

  return [
    resolveClaudeCodeExecutable(),
    ...(model ? ["--model", model] : []),
    ...extraArgs,
  ];
}
