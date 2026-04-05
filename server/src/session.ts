import { randomUUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  SessionInfo,
  ServerToHandMessage,
  ToolCall,
  ToolCallComplete,
} from "./protocol.js";
import { ToolRelay, type RemoteToolResult } from "./relay.js";

type SessionStatus = "idle" | "active" | "ended";
type SupportedToolName = "Read" | "Write" | "Edit" | "MultiEdit" | "Bash" | "Grep" | "Glob";
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

const SUPPORTED_REMOTE_TOOLS = new Set<SupportedToolName>([
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Bash",
  "Grep",
  "Glob",
]);

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

export interface SessionTransport {
  send(message: ServerToHandMessage): Promise<void>;
}

export interface BrainSessionOptions {
  cwd: string;
  id: string;
  model: string;
  transport: SessionTransport;
}

export class BrainSession {
  readonly id: string;
  readonly cwd: string;
  readonly model: string;
  readonly createdAt: Date;

  private readonly relay = new ToolRelay();
  private readonly transport: SessionTransport;
  private readonly canUseTool: CanUseToolHandler;
  private status: SessionStatus = "idle";
  private closed = false;
  private promptChain: Promise<void> = Promise.resolve();

  private constructor(options: BrainSessionOptions) {
    this.id = options.id;
    this.cwd = options.cwd;
    this.model = options.model;
    this.transport = options.transport;
    this.createdAt = new Date();
    this.canUseTool = async (toolName: string) => this.handleCanUseTool(toolName);
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
    this.promptChain = this.promptChain
      .catch(() => undefined)
      .then(() => this.runPrompt(text));
    return this.promptChain;
  }

  resolveToolResult(requestId: string, result: RemoteToolResult): void {
    this.relay.resolve(requestId, result);
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.status = "ended";
    this.relay.cleanup();
  }

  private async runPrompt(text: string): Promise<void> {
    if (this.closed) {
      await this.sendSessionEnd("", new Error("会话已关闭"));
      return;
    }

    this.status = "active";

    try {
      const stream = query({
        prompt: text,
        options: {
          cwd: this.cwd,
          model: this.model,
          permissionMode: "default",
          canUseTool: this.canUseTool,
          maxTurns: 100,
          hooks: {
            PreToolUse: [
              {
                matcher: ".*",
                hooks: [async (input: HookInput) => this.handlePreToolUse(input)],
              },
            ],
          },
        },
      }) as AsyncIterable<QueryMessage>;

      for await (const message of stream) {
        if (message.type === "assistant") {
          await this.handleAssistantMessage(message as AssistantMessage);
          continue;
        }

        if (message.type === "result") {
          await this.handleResultMessage(message as ResultMessage);
        }
      }
    } catch (error) {
      await this.sendSessionEnd("", asError(error));
    } finally {
      if (!this.closed) {
        this.status = "idle";
      }
    }
  }

  private async handleAssistantMessage(message: AssistantMessage): Promise<void> {
    for (const block of message.message.content) {
      if (block.type === "text" && block.text) {
        await this.transport.send({
          type: "text_chunk",
          sessionId: this.id,
          text: block.text,
        });
        continue;
      }

      const thought = block.type === "thinking" ? block.thinking ?? block.text : undefined;
      if (thought) {
        await this.transport.send({
          type: "thought_chunk",
          sessionId: this.id,
          text: thought,
        });
      }
    }
  }

  private async handleResultMessage(message: ResultMessage): Promise<void> {
    if (message.subtype && message.subtype !== "success") {
      const errorText = (message.error ?? message.result ?? message.stopReason ?? "").trim();
      await this.sendSessionEnd("", new Error(errorText || "query() 执行失败"));
      return;
    }

    const result = (message.result ?? message.stopReason ?? "").trim();
    await this.sendSessionEnd(result, null);
  }

  private async handlePreToolUse(input: HookInput): Promise<{
    hookEventName: "PreToolUse";
    permissionDecision: "deny";
    permissionDecisionReason: string;
    additionalContext: string;
  }> {
    if (this.closed) {
      throw new Error("会话已关闭");
    }

    if (!isSupportedRemoteTool(input.tool_name)) {
      return {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `Axon 不支持工具 ${input.tool_name}`,
        additionalContext: "",
      };
    }

    const requestId = `hook-${this.id}-${randomUUID()}`;
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
    } catch (error) {
      this.relay.reject(requestId, asError(error));
      throw error;
    }

    const result = await pending;

    const toolCallComplete: ToolCallComplete = {
      type: "tool_call_complete",
      sessionId: this.id,
      requestId,
      toolName: input.tool_name,
    };
    await this.transport.send(toolCallComplete);

    return {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Tool executed remotely via Axon Hand",
      additionalContext: summarizeToolResult(result),
    };
  }

  private async sendSessionEnd(result: string, error: Error | null): Promise<void> {
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
    if (isSupportedRemoteTool(toolName)) {
      return { behavior: "allow" };
    }

    return {
      behavior: "deny",
      message: `Axon 当前仅允许远程执行以下工具: ${Array.from(SUPPORTED_REMOTE_TOOLS).join(", ")}`,
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

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(typeof error === "string" ? error : JSON.stringify(error));
}

function isSupportedRemoteTool(toolName: string): toolName is SupportedToolName {
  return SUPPORTED_REMOTE_TOOLS.has(toolName as SupportedToolName);
}
