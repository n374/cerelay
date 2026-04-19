import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  SessionInfo,
  ServerToHandMessage,
  ToolCall,
  ToolCallComplete,
} from "./protocol.js";
import { createLogger, type Logger } from "./logger.js";
import { ToolRelay, type RemoteToolResult } from "./relay.js";
import { isBuiltinHandToolName, isMcpToolName } from "./tool-routing.js";
import type { SdkMcpServerConfig } from "./mcp-types.js";

export const CLAUDE_EXECUTABLE_CANDIDATES = [
  "/opt/homebrew/bin/claude",
  "/usr/local/bin/claude",
  path.join(os.homedir(), ".claude/local/claude"),
];

type SessionStatus = "idle" | "active" | "ended";
type CanUseToolHandler = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal;
    suggestions?: unknown[];
    blockedPath?: string;
    decisionReason?: string;
    title?: string;
    displayName?: string;
    description?: string;
    toolUseID: string;
    agentID?: string;
  }
) => Promise<
  | { behavior: "allow" }
  | { behavior: "deny"; message: string }
>;

export interface HookInput {
  tool_name: string;
  tool_use_id?: string;
  tool_input: unknown;
}

interface AssistantBlock {
  type: string;
  text?: string;
  thinking?: string;
}

interface AssistantMessage {
  type: "assistant";
  session_id?: string;
  message: {
    content: AssistantBlock[];
  };
}

interface ResultMessage {
  type: "result";
  session_id?: string;
  subtype?: string;
  result?: string;
  error?: string;
  stopReason?: string;
}

type QueryMessage = AssistantMessage | ResultMessage | { type: string; [key: string]: unknown };
export type SyncHookJsonOutput = {
  decision?: "approve" | "block";
  reason?: string;
  hookSpecificOutput?: {
    hookEventName: "PreToolUse";
    permissionDecision?: "allow" | "deny" | "ask" | "defer";
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
    additionalContext?: string;
  };
};

interface HookCallbackMatcher {
  matcher?: string;
  hooks: Array<(input: HookInput, toolUseId: string | undefined, options: { signal: AbortSignal }) => Promise<SyncHookJsonOutput>>;
  timeout?: number;
}

interface SpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
}

type SpawnedProcess = ChildProcess;

interface SessionQueryOptions {
  cwd: string;
  model: string;
  mcpServers?: Record<string, SdkMcpServerConfig>;
  resume?: string;
  env?: Record<string, string | undefined>;
  hooks?: Partial<Record<"PreToolUse", HookCallbackMatcher[]>>;
  pathToClaudeCodeExecutable: string;
  spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess;
  permissionMode: "default";
  canUseTool: CanUseToolHandler;
  maxTurns: number;
}

interface QueryRunnerInput {
  prompt: string;
  options: SessionQueryOptions;
}

type QueryRunner = (input: QueryRunnerInput) => AsyncIterable<QueryMessage>;

export interface SessionTransport {
  send(message: ServerToHandMessage): Promise<void>;
}

export interface ServerSessionOptions {
  claudeHomeDir?: string;
  claudeEnv?: Record<string, string | undefined>;
  cwd: string;
  clientHomeDir?: string;
  id: string;
  model: string;
  mcpServers?: Record<string, SdkMcpServerConfig>;
  sdkCwd?: string;
  spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess;
  onClose?: () => void | Promise<void>;
  transport: SessionTransport;
  shouldRouteToolToClient?: (toolName: string) => boolean;
  queryRunner?: QueryRunner;
}

export class ServerSession {
  readonly id: string;
  readonly cwd: string;
  readonly model: string;
  readonly createdAt: Date;

  private readonly claudeHomeDir: string;
  private readonly claudeEnv?: Record<string, string | undefined>;
  private readonly clientHomeDir?: string;
  private readonly relay = new ToolRelay();
  private mcpServers?: Record<string, SdkMcpServerConfig>;
  private readonly sdkCwd: string;
  private readonly transport: SessionTransport;
  private readonly canUseTool: CanUseToolHandler;
  private readonly onClose?: () => void | Promise<void>;
  private readonly shouldRouteToolToClient: (toolName: string) => boolean;
  private readonly queryRunner: QueryRunner;
  private readonly spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess;
  private readonly log: Logger;
  private status: SessionStatus = "idle";
  private closed = false;
  private claudeSessionId?: string;
  private promptChain: Promise<void> = Promise.resolve();

  private constructor(options: ServerSessionOptions) {
    this.id = options.id;
    this.claudeHomeDir = options.claudeHomeDir?.trim() || os.homedir();
    this.claudeEnv = options.claudeEnv;
    this.cwd = options.cwd;
    this.clientHomeDir = options.clientHomeDir?.trim() || undefined;
    this.model = options.model;
    this.mcpServers = options.mcpServers;
    this.transport = options.transport;
    this.sdkCwd = options.sdkCwd ?? os.tmpdir();
    this.onClose = options.onClose;
    this.spawnClaudeCodeProcess = options.spawnClaudeCodeProcess;
    this.createdAt = new Date();
    this.shouldRouteToolToClient = options.shouldRouteToolToClient ?? ((toolName) => isClientRoutedToolName(toolName));
    this.canUseTool = async (toolName: string) => this.handleCanUseTool(toolName);
    this.queryRunner = options.queryRunner ?? runSdkQuery;
    this.log = createLogger("session").child({
      sessionId: this.id,
      cwd: this.cwd,
      model: this.model,
    });
  }

  static createSession(options: ServerSessionOptions): ServerSession {
    return new ServerSession(options);
  }

  info(): SessionInfo {
    return {
      sessionId: this.id,
      cwd: this.cwd,
      model: this.model,
      status: this.status,
      createdAt: this.createdAt.toISOString(),
    };
  }

  setMcpServers(mcpServers: Record<string, SdkMcpServerConfig> | undefined): void {
    this.mcpServers = mcpServers;
    this.log.debug("更新 session MCP proxy servers", {
      serverCount: Object.keys(mcpServers ?? {}).length,
      servers: Object.keys(mcpServers ?? {}),
    });
  }

  prompt(text: string): Promise<void> {
    this.log.debug("收到 prompt 排队请求", {
      status: this.status,
      textLength: text.length,
      preview: previewText(text),
    });
    this.promptChain = this.promptChain
      .catch(() => undefined)
      .then(() => this.runPrompt(text));
    return this.promptChain;
  }

  resolveToolResult(requestId: string, result: RemoteToolResult): void {
    this.log.debug("收到远端工具结果", {
      requestId,
      hasError: Boolean(result.error),
      hasSummary: Boolean(result.summary),
      outputType: result.output === undefined ? "undefined" : typeof result.output,
    });
    this.relay.resolve(requestId, result);
  }

  close(): void {
    if (this.closed) {
      this.log.debug("重复关闭会话已忽略");
      return;
    }

    this.log.debug("关闭会话并清理挂起工具调用", {
      pendingToolCalls: this.relay.size(),
      previousStatus: this.status,
    });
    this.closed = true;
    this.status = "ended";
    this.relay.cleanup();
    if (this.onClose) {
      Promise.resolve(this.onClose()).catch((error) => {
        this.log.warn("执行 session 清理回调失败", {
          error: asError(error).message,
        });
      });
    }
  }

  private async runPrompt(text: string): Promise<void> {
    if (this.closed) {
      this.log.warn("会话已关闭，拒绝执行 prompt");
      await this.sendSessionEnd("", new Error("会话已关闭"));
      return;
    }

    this.status = "active";
    this.log.debug("开始执行 prompt", {
      textLength: text.length,
      preview: previewText(text),
      claudeCodeExecutable: resolveClaudeCodeExecutable(),
      claudeSessionId: this.claudeSessionId,
    });

    try {
      const stream = this.queryRunner({
        prompt: text,
        options: {
          // Claude CLI 在 session runtime 的 cwd 中启动。runtime 可能是普通目录，
          // 也可能是挂好 HOME/cwd 视图的 mount namespace。
          cwd: this.sdkCwd,
          model: this.model,
          mcpServers: this.mcpServers,
          resume: this.claudeSessionId,
          env: this.claudeEnv,
          hooks: {
            PreToolUse: [
              {
                matcher: ".*",
                hooks: [
                  async (input: HookInput) => this.handleInjectedPreToolUse({
                    tool_name: input.tool_name,
                    tool_input: input.tool_input,
                    tool_use_id: input.tool_use_id,
                  }),
                ],
              },
            ],
          },
          pathToClaudeCodeExecutable: resolveClaudeCodeExecutable(),
          spawnClaudeCodeProcess: this.spawnClaudeCodeProcess,
          permissionMode: "default",
          canUseTool: this.canUseTool,
          maxTurns: 100,
        },
      });

      for await (const message of stream) {
        this.captureClaudeSessionId(message);
        this.log.debug("收到 query 流消息", { type: message.type });
        if (message.type === "assistant") {
          await this.handleAssistantMessage(message as AssistantMessage);
          continue;
        }

        if (message.type === "result") {
          await this.handleResultMessage(message as ResultMessage);
        }
      }
    } catch (error) {
      this.log.error("prompt 执行异常", { error: asError(error).message });
      await this.sendSessionEnd("", asError(error));
    } finally {
      if (!this.closed) {
        this.status = "idle";
      }
      this.log.debug("prompt 执行结束", {
        closed: this.closed,
        nextStatus: this.status,
      });
    }
  }

  private async handleAssistantMessage(message: AssistantMessage): Promise<void> {
    this.log.debug("处理 assistant 消息", {
      blockCount: message.message.content.length,
    });
    for (const block of message.message.content) {
      if (block.type === "text" && block.text) {
        this.log.debug("发送文本分片", { textLength: block.text.length });
        await this.transport.send({
          type: "text_chunk",
          sessionId: this.id,
          text: block.text,
        });
        continue;
      }

      const thought = block.type === "thinking" ? block.thinking ?? block.text : undefined;
      if (thought) {
        this.log.debug("发送思考分片", { textLength: thought.length });
        await this.transport.send({
          type: "thought_chunk",
          sessionId: this.id,
          text: thought,
        });
      }
    }
  }

  private async handleResultMessage(message: ResultMessage): Promise<void> {
    this.log.debug("处理 result 消息", {
      subtype: message.subtype ?? "success",
      claudeSessionId: message.session_id,
      stopReason: message.stopReason,
      hasError: Boolean(message.error),
      resultLength: (message.result ?? "").length,
    });
    if (message.subtype && message.subtype !== "success") {
      const errorText = (message.error ?? message.result ?? message.stopReason ?? "").trim();
      this.log.warn("query 返回失败结果", {
        subtype: message.subtype,
        error: errorText || "query() 执行失败",
      });
      await this.sendSessionEnd("", new Error(errorText || "query() 执行失败"));
      return;
    }

    const result = (message.result ?? message.stopReason ?? "").trim();
    await this.sendSessionEnd(result, null);
  }

  async handleInjectedPreToolUse(input: HookInput): Promise<SyncHookJsonOutput> {
    if (this.closed) {
      this.log.warn("会话已关闭，无法继续工具调用");
      throw new Error("会话已关闭");
    }

    if (!this.shouldRouteToolToClient(input.tool_name)) {
      this.log.debug("工具未配置为通过 Client 转发", {
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
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Tool response ready",
        additionalContext: renderToolResultForClaude(input.tool_name, result),
      },
    };
  }

  async executeToolViaClient(toolName: string, toolInput: unknown, toolUseId?: string): Promise<RemoteToolResult> {
    if (this.closed) {
      this.log.warn("会话已关闭，无法继续工具调用");
      throw new Error("会话已关闭");
    }

    const rewrittenInput = rewriteToolInputForClient(toolName, toolInput, {
      serverHomeDir: this.claudeHomeDir,
      clientHomeDir: this.clientHomeDir,
      serverCwd: this.sdkCwd,
      clientCwd: this.cwd,
    });
    const requestId = `hook-${this.id}-${randomUUID()}`;
    this.log.info("准备转发工具调用到 Client", {
      requestId,
      toolName,
      toolUseId,
      inputSummary: summarizeUnknown(rewrittenInput),
    });
    const pending = this.relay.createPending(requestId, toolName);

    const toolCall: ToolCall = {
      type: "tool_call",
      sessionId: this.id,
      requestId,
      toolName,
      toolUseId,
      input: rewrittenInput,
    };

    try {
      await this.transport.send(toolCall);
      this.log.info("工具调用已发送到 Client", {
        requestId,
        toolName,
      });
    } catch (error) {
      this.log.error("发送工具调用到 Client 失败", {
        requestId,
        toolName,
        error: asError(error).message,
      });
      this.relay.reject(requestId, asError(error));
      throw error;
    }

    const result = await pending;
    this.log.info("收到 Client 返回的工具结果", {
      requestId,
      toolName,
      hasError: Boolean(result.error),
      summaryLength: result.summary?.length ?? 0,
      outputSummary: summarizeUnknown(result.output),
    });

    const toolCallComplete: ToolCallComplete = {
      type: "tool_call_complete",
      sessionId: this.id,
      requestId,
      toolName,
    };
    await this.transport.send(toolCallComplete);
    this.log.info("工具调用完成通知已发送", {
      requestId,
      toolName,
    });

    return result;
  }

  private async sendSessionEnd(result: string, error: Error | null): Promise<void> {
    this.log.debug("发送 session_end", {
      hasError: Boolean(error),
      error: error?.message,
      resultLength: result.length,
    });
    await this.transport.send({
      type: "session_end",
      sessionId: this.id,
      result: error ? undefined : result || undefined,
      error: error ? error.message : undefined,
    });
  }

  private async handleCanUseTool(toolName: string): Promise<{
    behavior: "allow";
  } | {
    behavior: "deny";
    message: string;
  }> {
    if (this.shouldRouteToolToClient(toolName)) {
      this.log.debug("允许工具调用", { toolName });
      return { behavior: "allow" };
    }

    this.log.debug("拒绝工具调用", { toolName });
    return {
      behavior: "deny",
      message: `Tool ${toolName} is not available in this session`,
    };
  }

  private captureClaudeSessionId(message: QueryMessage): void {
    const sessionId = extractClaudeSessionId(message);
    if (!sessionId) {
      return;
    }

    if (this.claudeSessionId === sessionId) {
      return;
    }

    if (this.claudeSessionId && this.claudeSessionId !== sessionId) {
      this.log.warn("Claude 会话 ID 发生变化", {
        previousClaudeSessionId: this.claudeSessionId,
        nextClaudeSessionId: sessionId,
      });
    } else {
      this.log.debug("绑定 Claude 原生会话", {
        claudeSessionId: sessionId,
      });
    }

    this.claudeSessionId = sessionId;
  }
}

export function renderToolResultForClaude(toolName: string, result: RemoteToolResult): string {
  if (result.error) {
    return result.error;
  }

  const output = result.output;
  if (output === undefined) {
    return result.summary ?? "";
  }

  if (typeof output === "string") {
    return output;
  }

  if (!output || typeof output !== "object") {
    return String(output);
  }

  if (toolName === "Read" && typeof (output as { content?: unknown }).content === "string") {
    return (output as { content: string }).content;
  }

  if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") {
    const pathValue = (output as { path?: unknown }).path;
    if (typeof pathValue === "string") {
      return pathValue;
    }
  }

  if (toolName === "Bash") {
    const bash = output as { stdout?: unknown; stderr?: unknown; exit_code?: unknown };
    const parts: string[] = [];
    if (typeof bash.stdout === "string" && bash.stdout.length > 0) {
      parts.push(`stdout:\n${bash.stdout}`);
    }
    if (typeof bash.stderr === "string" && bash.stderr.length > 0) {
      parts.push(`stderr:\n${bash.stderr}`);
    }
    if (typeof bash.exit_code === "number") {
      parts.push(`exit_code: ${bash.exit_code}`);
    }
    return parts.join("\n");
  }

  if (toolName === "Glob" && Array.isArray((output as { files?: unknown }).files)) {
    return ((output as { files: unknown[] }).files)
      .filter((file): file is string => typeof file === "string")
      .join("\n");
  }

  if (toolName === "Grep" && Array.isArray((output as { matches?: unknown }).matches)) {
    return ((output as { matches: unknown[] }).matches)
      .flatMap((match) => {
        if (!match || typeof match !== "object") {
          return [];
        }
        const file = (match as { file?: unknown }).file;
        const line = (match as { line?: unknown }).line;
        const text = (match as { text?: unknown }).text;
        if (typeof file !== "string" || typeof line !== "number" || typeof text !== "string") {
          return [];
        }
        return [`${file}:${line}:${text}`];
      })
      .join("\n");
  }

  return JSON.stringify(output, null, 2);
}

function previewText(text: string, maxLength = 120): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}...`;
}

function summarizeUnknown(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }

  if (typeof value === "string") {
    return previewText(value, 80);
  }

  try {
    return previewText(JSON.stringify(value), 80);
  } catch {
    return String(value);
  }
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(typeof error === "string" ? error : JSON.stringify(error));
}

export function isClientRoutedToolName(toolName: string): boolean {
  return isBuiltinHandToolName(toolName) || isMcpToolName(toolName);
}

/** @deprecated Use isClientRoutedToolName */
export function isHandRoutedToolName(toolName: string): boolean {
  return isClientRoutedToolName(toolName);
}

export function resolveClaudeCodeExecutable(candidates = CLAUDE_EXECUTABLE_CANDIDATES, env = process.env): string {
  const configured = env.CLAUDE_CODE_EXECUTABLE?.trim();
  if (configured) {
    return configured;
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `Could not find Claude Code executable. Tried: ${candidates.join(", ")}. Set CLAUDE_CODE_EXECUTABLE env var or install via \`brew install --cask claude-code\`.`
  );
}

function extractClaudeSessionId(message: QueryMessage): string | undefined {
  const sessionId = (message as { session_id?: unknown }).session_id;
  return typeof sessionId === "string" && sessionId.trim() ? sessionId : undefined;
}

export function rewriteToolInputForClient(
  toolName: string,
  input: unknown,
  options: {
    serverHomeDir: string;
    clientHomeDir?: string;
    serverCwd: string;
    clientCwd: string;
  }
): unknown {
  if (!input || typeof input !== "object") {
    return input;
  }

  const inputRecord = { ...(input as Record<string, unknown>) };

  switch (toolName) {
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      if (typeof inputRecord.file_path === "string") {
        inputRecord.file_path = rewriteClaudePathForClient(inputRecord.file_path, options);
      }
      return inputRecord;
    case "Grep":
    case "Glob":
      if (typeof inputRecord.path === "string") {
        inputRecord.path = rewriteClaudePathForClient(inputRecord.path, options);
      }
      return inputRecord;
    case "Bash":
      if (typeof inputRecord.command === "string") {
        inputRecord.command = rewriteClaudeCommandForClient(inputRecord.command, options);
      }
      return inputRecord;
    default:
      return input;
  }
}

/** @deprecated Use rewriteToolInputForClient */
export function rewriteToolInputForHand(
  toolName: string,
  input: unknown,
  options: {
    brainHomeDir: string;
    handHomeDir?: string;
    brainCwd: string;
    handCwd: string;
  }
): unknown {
  return rewriteToolInputForClient(toolName, input, {
    serverHomeDir: options.brainHomeDir,
    clientHomeDir: options.handHomeDir,
    serverCwd: options.brainCwd,
    clientCwd: options.handCwd,
  });
}

function rewriteClaudeCommandForClient(
  command: string,
  options: {
    serverHomeDir: string;
    clientHomeDir?: string;
    serverCwd: string;
    clientCwd: string;
  }
): string {
  let rewritten = command;
  rewritten = rewritten.split(options.serverCwd).join(options.clientCwd);

  if (options.clientHomeDir) {
    rewritten = rewritten.split(path.join(options.serverHomeDir, ".claude.json")).join(path.join(options.clientHomeDir, ".claude.json"));
    rewritten = rewritten.split(path.join(options.serverHomeDir, ".claude")).join(path.join(options.clientHomeDir, ".claude"));
    rewritten = rewritten.split(options.serverHomeDir).join(options.clientHomeDir);
  }

  return rewritten;
}

function rewriteClaudePathForClient(
  filePath: string,
  options: {
    serverHomeDir: string;
    clientHomeDir?: string;
    serverCwd: string;
    clientCwd: string;
  }
): string {
  if (filePath === options.serverCwd || filePath.startsWith(`${options.serverCwd}${path.sep}`)) {
    return `${options.clientCwd}${filePath.slice(options.serverCwd.length)}`;
  }

  if (options.clientHomeDir && (filePath === options.serverHomeDir || filePath.startsWith(`${options.serverHomeDir}${path.sep}`))) {
    return `${options.clientHomeDir}${filePath.slice(options.serverHomeDir.length)}`;
  }

  return filePath;
}

function runSdkQuery(input: QueryRunnerInput): AsyncIterable<QueryMessage> {
  return query(input as unknown as Parameters<typeof query>[0]) as AsyncIterable<QueryMessage>;
}
