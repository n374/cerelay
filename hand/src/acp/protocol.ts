// ============================================================
// ACP (Agent Communication Protocol) 协议类型定义
// 基于 JSON-RPC 2.0，通过 stdio 传输
// 编辑器（如 Zed、VS Code）通过此协议与 Hand 通信
// ============================================================

// ---- JSON-RPC 2.0 基础类型 ----

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: T;
  error?: JsonRpcError;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  // 通知消息没有 id
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// ---- ACP 标准错误码 ----
export const ACP_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // 自定义错误码（-32000 到 -32099 保留给实现）
  SESSION_NOT_FOUND: -32001,
  SESSION_BUSY: -32002,
  TOOL_EXECUTION_FAILED: -32003,
} as const;

// ---- ACP 方法请求/响应类型 ----

// initialize：客户端初始连接，协商能力
export interface InitializeParams {
  protocolVersion: string;
  clientInfo: {
    name: string;
    version: string;
  };
  capabilities?: Record<string, unknown>;
}

export interface InitializeResult {
  protocolVersion: string;
  serverInfo: {
    name: string;
    version: string;
  };
  capabilities: {
    streaming: boolean;
    multiSession: boolean;
    tools: string[];
  };
}

// session/new：创建新会话
export interface SessionNewParams {
  cwd: string;
  model?: string;
}

export interface SessionNewResult {
  sessionId: string;
}

// session/prompt：发送 prompt 并流式获取结果
export interface SessionPromptParams {
  sessionId: string;
  prompt: string;
}

// session/prompt 为流式响应，通过通知逐步推送
// 最终返回 result
export interface SessionPromptResult {
  sessionId: string;
  result?: string;
  error?: string;
}

// session/update：对话中提交额外信息（如工具结果或中断）
export interface SessionUpdateParams {
  sessionId: string;
  action: "cancel";
}

export interface SessionUpdateResult {
  sessionId: string;
  status: "cancelled" | "ok";
}

// session/close：关闭会话
export interface SessionCloseParams {
  sessionId: string;
}

export interface SessionCloseResult {
  sessionId: string;
}

// ---- ACP 通知类型（Server -> Client Push）----

// text_chunk 通知：流式文本块
export interface TextChunkNotification extends JsonRpcNotification {
  method: "$/textChunk";
  params: {
    sessionId: string;
    text: string;
  };
}

// thought_chunk 通知：流式思考内容
export interface ThoughtChunkNotification extends JsonRpcNotification {
  method: "$/thoughtChunk";
  params: {
    sessionId: string;
    text: string;
  };
}

// tool_call 通知：工具调用信息（供 UI 展示）
export interface ToolCallNotification extends JsonRpcNotification {
  method: "$/toolCall";
  params: {
    sessionId: string;
    toolName: string;
    requestId: string;
    input: unknown;
  };
}

// tool_call_complete 通知：工具执行完成
export interface ToolCallCompleteNotification extends JsonRpcNotification {
  method: "$/toolCallComplete";
  params: {
    sessionId: string;
    toolName: string;
    requestId: string;
  };
}
