// Hand 端使用的 WebSocket 消息协议类型定义
// 与 server/src/protocol.ts 完全对齐，仅保留 Hand 端发送和接收的消息类型

// ============================================================
// Server -> Hand 消息
// ============================================================

export interface TextChunk {
  type: "text_chunk";
  sessionId: string;
  text: string;
}

export interface ThoughtChunk {
  type: "thought_chunk";
  sessionId: string;
  text: string;
}

export interface ToolCall {
  type: "tool_call";
  sessionId: string;
  requestId: string;
  toolName: string;
  toolUseId?: string;
  input: unknown;
}

export interface ToolCallComplete {
  type: "tool_call_complete";
  sessionId: string;
  requestId: string;
  toolName: string;
}

export interface SessionEnd {
  type: "session_end";
  sessionId: string;
  result?: string;
  error?: string;
}

export interface ServerError {
  type: "error";
  sessionId?: string;
  message: string;
}

export interface Connected {
  type: "connected";
  sessionId?: string;
}

export interface CreateSessionResponse {
  type: "session_created";
  sessionId: string;
}

export interface SessionInfo {
  sessionId: string;
  cwd: string;
  model?: string;
  status: "idle" | "active" | "ended";
  createdAt: string;
}

export interface SessionList {
  type: "session_list";
  sessions: SessionInfo[];
}

// ============================================================
// Hand -> Server 消息
// ============================================================

export interface CreateSession {
  type: "create_session";
  cwd: string;
  model?: string;
}

export interface Prompt {
  type: "prompt";
  sessionId: string;
  text: string;
}

export interface ToolResult {
  type: "tool_result";
  sessionId: string;
  requestId: string;
  output?: unknown;
  summary?: string;
  error?: string;
}

export interface CloseSession {
  type: "close_session";
  sessionId: string;
}

export interface ListSessions {
  type: "list_sessions";
}

// ============================================================
// Union 类型
// ============================================================

export type ServerToHandMessage =
  | Connected
  | CreateSessionResponse
  | ServerError
  | SessionEnd
  | SessionList
  | TextChunk
  | ThoughtChunk
  | ToolCall
  | ToolCallComplete;

export type HandToServerMessage =
  | CloseSession
  | CreateSession
  | ListSessions
  | Prompt
  | ToolResult;

// ============================================================
// 通用信封，用于初步解析 type 字段
// ============================================================

export interface Envelope {
  type: string;
}

// ============================================================
// Type guards
// ============================================================

export function isTextChunk(msg: ServerToHandMessage): msg is TextChunk {
  return msg.type === "text_chunk";
}

export function isThoughtChunk(msg: ServerToHandMessage): msg is ThoughtChunk {
  return msg.type === "thought_chunk";
}

export function isToolCall(msg: ServerToHandMessage): msg is ToolCall {
  return msg.type === "tool_call";
}

export function isSessionEnd(msg: ServerToHandMessage): msg is SessionEnd {
  return msg.type === "session_end";
}

export function isServerError(msg: ServerToHandMessage): msg is ServerError {
  return msg.type === "error";
}

export function isConnected(msg: ServerToHandMessage): msg is Connected {
  return msg.type === "connected";
}

export function isCreateSessionResponse(
  msg: ServerToHandMessage
): msg is CreateSessionResponse {
  return msg.type === "session_created";
}
