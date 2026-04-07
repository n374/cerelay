import { randomUUID } from "node:crypto";
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

const DEFAULT_CLAUDE_CODE_EXECUTABLE = "/usr/local/bin/claude";

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

interface HookInput {
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
  message: {
    content: AssistantBlock[];
  };
}

interface ResultMessage {
  type: "result";
  subtype?: string;
  result?: string;
  error?: string;
  stopReason?: string;
}

type QueryMessage = AssistantMessage | ResultMessage | { type: string; [key: string]: unknown };
type PreToolUseHookResult = {
  hookEventName: "PreToolUse";
  permissionDecision: "deny";
  permissionDecisionReason: string;
  additionalContext: string;
};

interface SessionQueryOptions {
  cwd: string;
  model: string;
  pathToClaudeCodeExecutable: string;
  permissionMode: "default";
  canUseTool: CanUseToolHandler;
  maxTurns: number;
  hooks: {
    PreToolUse: Array<{
      matcher: string;
      hooks: Array<(input: HookInput) => Promise<PreToolUseHookResult>>;
    }>;
  };
}

interface QueryRunnerInput {
  prompt: string;
  options: SessionQueryOptions;
}

type QueryRunner = (input: QueryRunnerInput) => AsyncIterable<QueryMessage>;

export interface SessionTransport {
  send(message: ServerToHandMessage): Promise<void>;
}

export interface BrainSessionOptions {
  cwd: string;
  id: string;
  model: string;
  transport: SessionTransport;
  shouldRouteToolToHand?: (toolName: string) => boolean;
  queryRunner?: QueryRunner;
}

export class BrainSession {
  readonly id: string;
  readonly cwd: string;
  readonly model: string;
  readonly createdAt: Date;

  private readonly relay = new ToolRelay();
  private readonly transport: SessionTransport;
  private readonly canUseTool: CanUseToolHandler;
  private readonly shouldRouteToolToHand: (toolName: string) => boolean;
  private readonly queryRunner: QueryRunner;
  private readonly log: Logger;
  private status: SessionStatus = "idle";
  private closed = false;
  private promptChain: Promise<void> = Promise.resolve();

  private constructor(options: BrainSessionOptions) {
    this.id = options.id;
    this.cwd = options.cwd;
    this.model = options.model;
    this.transport = options.transport;
    this.createdAt = new Date();
    this.shouldRouteToolToHand = options.shouldRouteToolToHand ?? ((toolName) => isHandRoutedToolName(toolName));
    this.canUseTool = async (toolName: string) => this.handleCanUseTool(toolName);
    this.queryRunner = options.queryRunner ?? runSdkQuery;
    this.log = createLogger("session").child({
      sessionId: this.id,
      cwd: this.cwd,
      model: this.model,
    });
  }

  static createSession(options: BrainSessionOptions): BrainSession {
    return new BrainSession(options);
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
    });

    try {
      const stream = this.queryRunner({
        prompt: text,
        options: {
          cwd: this.cwd,
          model: this.model,
          pathToClaudeCodeExecutable: resolveClaudeCodeExecutable(),
          permissionMode: "default",
          canUseTool: this.canUseTool,
          maxTurns: 100,
          hooks: {
            PreToolUse: [
              { matcher: ".*", hooks: [async (input: HookInput) => this.handlePreToolUse(input)] },
            ],
          },
        },
      });

      for await (const message of stream) {
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

  private async handlePreToolUse(input: HookInput): Promise<PreToolUseHookResult> {
    if (this.closed) {
      this.log.warn("会话已关闭，无法继续工具调用");
      throw new Error("会话已关闭");
    }

    if (!this.shouldRouteToolToHand(input.tool_name)) {
      this.log.debug("工具未配置为通过 Hand 转发", {
        toolName: input.tool_name,
      });
      return {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `Axon 不支持工具 ${input.tool_name}`,
        additionalContext: "",
      };
    }

    const requestId = `hook-${this.id}-${randomUUID()}`;
    this.log.debug("准备转发工具调用到 Hand", {
      requestId,
      toolName: input.tool_name,
      toolUseId: input.tool_use_id,
      inputSummary: summarizeUnknown(input.tool_input),
    });
    const pending = this.relay.createPending(requestId, input.tool_name);

    const toolCall: ToolCall = {
      type: "tool_call",
      sessionId: this.id,
      requestId,
      toolName: input.tool_name,
      toolUseId: input.tool_use_id,
      input: input.tool_input,
    };

    try {
      await this.transport.send(toolCall);
      this.log.debug("工具调用已发送到 Hand", {
        requestId,
        toolName: input.tool_name,
      });
    } catch (error) {
      this.log.error("发送工具调用到 Hand 失败", {
        requestId,
        toolName: input.tool_name,
        error: asError(error).message,
      });
      this.relay.reject(requestId, asError(error));
      throw error;
    }

    const result = await pending;
    this.log.debug("收到 Hand 返回的工具结果", {
      requestId,
      toolName: input.tool_name,
      hasError: Boolean(result.error),
      summaryLength: result.summary?.length ?? 0,
      outputSummary: summarizeUnknown(result.output),
    });

    const toolCallComplete: ToolCallComplete = {
      type: "tool_call_complete",
      sessionId: this.id,
      requestId,
      toolName: input.tool_name,
    };
    await this.transport.send(toolCallComplete);
    this.log.debug("工具调用完成通知已发送", {
      requestId,
      toolName: input.tool_name,
    });

    return {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Tool executed remotely via Axon Hand",
      additionalContext: summarizeToolResult(result),
    };
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
    if (this.shouldRouteToolToHand(toolName)) {
      this.log.debug("允许工具调用", { toolName });
      return { behavior: "allow" };
    }

    this.log.debug("拒绝工具调用", { toolName });
    return {
      behavior: "deny",
      message: `Axon 当前未配置通过 Hand 执行工具 ${toolName}`,
    };
  }
}

function summarizeToolResult(result: RemoteToolResult): string {
  if (result.summary) {
    return result.summary;
  }

  if (result.error) {
    return result.error;
  }

  if (result.output === undefined) {
    return "";
  }

  if (typeof result.output === "string") {
    return result.output;
  }

  return JSON.stringify(result.output);
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

export function isHandRoutedToolName(toolName: string): boolean {
  return isBuiltinHandToolName(toolName) || isMcpToolName(toolName);
}

export function resolveClaudeCodeExecutable(env = process.env): string {
  const configured = env.CLAUDE_CODE_EXECUTABLE?.trim();
  return configured || DEFAULT_CLAUDE_CODE_EXECUTABLE;
}

function runSdkQuery(input: QueryRunnerInput): AsyncIterable<QueryMessage> {
  return query(input as unknown as Parameters<typeof query>[0]) as AsyncIterable<QueryMessage>;
}
