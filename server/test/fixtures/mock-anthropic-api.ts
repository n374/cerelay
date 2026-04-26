/**
 * Mock Anthropic Messages API (SSE streaming) for e2e tests.
 *
 * 用于在不依赖真实 api.anthropic.com 的情况下，把真实 `claude` CLI
 * 接到测试 harness。测试只关心 hook 协议的正确性，所以 mock 用一段
 * 写死的 SSE 脚本回放 tool_use → tool_result → text 的两轮对话，
 * 并把每一轮请求体存起来供测试断言。
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

// ============================================================
// Anthropic Messages API 类型（仅覆盖测试用到的子集）
// ============================================================

export interface MessagesRequestBody {
  model: string;
  max_tokens?: number;
  messages: Array<{
    role: "user" | "assistant";
    content: string | Array<Record<string, unknown>>;
  }>;
  tools?: Array<Record<string, unknown>>;
  system?: string | Array<Record<string, unknown>>;
  stream?: boolean;
}

export interface CapturedRequest {
  /** 第几次请求（从 1 开始） */
  index: number;
  url: string;
  headers: Record<string, string>;
  body: MessagesRequestBody;
  /** 把所有 user-role 消息中的 tool_result 内容平铺出来，便于断言 */
  toolResults: Array<{
    tool_use_id: string;
    content: string;
    is_error: boolean;
  }>;
}

export interface MockAnthropicHandle {
  url: string;
  port: number;
  /** 以请求顺序记录所有 /v1/messages 的请求体 */
  captured: CapturedRequest[];
  close: () => Promise<void>;
}

export interface MockAnthropicOptions {
  /** 第一轮 assistant 让 Claude 调用的工具 */
  firstTurn: {
    toolUseId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
  };
  /** 第二轮（拿到 tool_result 之后）assistant 输出的最终文本 */
  finalText: string;
}

// ============================================================
// 启动 mock server
// ============================================================

export async function startMockAnthropicApi(options: MockAnthropicOptions): Promise<MockAnthropicHandle> {
  const captured: CapturedRequest[] = [];

  const server: Server = createServer((req, res) => {
    handleRequest(req, res, options, captured).catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[mock-anthropic] handler error", err);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain" });
      }
      try {
        res.end(`mock error: ${err instanceof Error ? err.message : String(err)}`);
      } catch {
        // ignore
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("mock anthropic server: 无法获取监听地址");
  }
  const port = address.port;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    port,
    captured,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// ============================================================
// 请求处理
// ============================================================

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: MockAnthropicOptions,
  captured: CapturedRequest[]
): Promise<void> {
  // 健康检查 / 版本探测
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, mock: "anthropic" }));
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "text/plain" });
    res.end("method not allowed");
    return;
  }

  // 读完请求体
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");

  // 路由：仅 /v1/messages 走脚本逻辑，其他端点（model list、count_tokens 等）返回简单 stub
  const url = req.url ?? "";

  if (!url.startsWith("/v1/messages")) {
    if (url.startsWith("/v1/messages/count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: 0 }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "not_found", message: `unsupported endpoint: ${url}` } }));
    return;
  }

  let body: MessagesRequestBody;
  try {
    body = JSON.parse(raw) as MessagesRequestBody;
  } catch (err) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "invalid_request_error", message: `bad JSON: ${String(err)}` } }));
    return;
  }

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    headers[k] = Array.isArray(v) ? v.join(",") : (v ?? "");
  }

  const entry: CapturedRequest = {
    index: captured.length + 1,
    url,
    headers,
    body,
    toolResults: collectToolResults(body),
  };
  captured.push(entry);

  // 选择本次返回的脚本
  const isFirstTurn = entry.toolResults.length === 0;
  const stream = body.stream === true;

  if (isFirstTurn) {
    if (stream) {
      sendSseToolUse(res, options.firstTurn);
    } else {
      sendJsonToolUse(res, options.firstTurn);
    }
  } else {
    if (stream) {
      sendSseText(res, options.finalText);
    } else {
      sendJsonText(res, options.finalText);
    }
  }
}

function collectToolResults(body: MessagesRequestBody): CapturedRequest["toolResults"] {
  const out: CapturedRequest["toolResults"] = [];
  for (const msg of body.messages ?? []) {
    if (msg.role !== "user" || typeof msg.content === "string") continue;
    for (const block of msg.content) {
      if (!block || typeof block !== "object") continue;
      if ((block as { type?: unknown }).type !== "tool_result") continue;
      const id = (block as { tool_use_id?: unknown }).tool_use_id;
      const isError = Boolean((block as { is_error?: unknown }).is_error);
      const content = (block as { content?: unknown }).content;
      out.push({
        tool_use_id: typeof id === "string" ? id : "",
        content: stringifyToolResultContent(content),
        is_error: isError,
      });
    }
  }
  return out;
}

function stringifyToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? "");
  // tool_result.content 可以是 array of blocks
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if ((block as { type?: unknown }).type === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    } else {
      parts.push(JSON.stringify(block));
    }
  }
  return parts.join("\n");
}

// ============================================================
// SSE 输出
// ============================================================

function writeSseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    "connection": "keep-alive",
  });
}

function writeSseEvent(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sendSseToolUse(res: ServerResponse, tool: MockAnthropicOptions["firstTurn"]): void {
  writeSseHeaders(res);
  const messageId = `msg_${randomUUID().replace(/-/g, "")}`;
  const inputJson = JSON.stringify(tool.toolInput);

  writeSseEvent(res, "message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      content: [],
      model: "claude-mock",
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });

  writeSseEvent(res, "content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: {
      type: "tool_use",
      id: tool.toolUseId,
      name: tool.toolName,
      input: {},
    },
  });

  // 一次性把 input JSON 灌进去
  writeSseEvent(res, "content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: inputJson },
  });

  writeSseEvent(res, "content_block_stop", { type: "content_block_stop", index: 0 });

  writeSseEvent(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: { output_tokens: 16 },
  });

  writeSseEvent(res, "message_stop", { type: "message_stop" });
  res.end();
}

function sendSseText(res: ServerResponse, text: string): void {
  writeSseHeaders(res);
  const messageId = `msg_${randomUUID().replace(/-/g, "")}`;

  writeSseEvent(res, "message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      content: [],
      model: "claude-mock",
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });

  writeSseEvent(res, "content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });

  writeSseEvent(res, "content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text },
  });

  writeSseEvent(res, "content_block_stop", { type: "content_block_stop", index: 0 });

  writeSseEvent(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: text.length },
  });

  writeSseEvent(res, "message_stop", { type: "message_stop" });
  res.end();
}

// ============================================================
// 非流式输出（claude CLI 极少使用，但稳妥起见也 stub）
// ============================================================

function sendJsonToolUse(res: ServerResponse, tool: MockAnthropicOptions["firstTurn"]): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    id: `msg_${randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    model: "claude-mock",
    content: [
      {
        type: "tool_use",
        id: tool.toolUseId,
        name: tool.toolName,
        input: tool.toolInput,
      },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 16 },
  }));
}

function sendJsonText(res: ServerResponse, text: string): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    id: `msg_${randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    model: "claude-mock",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: text.length },
  }));
}
