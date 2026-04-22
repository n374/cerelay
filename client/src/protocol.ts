// Hand 端使用的 WebSocket 消息协议类型定义
// 与 server/src/protocol.ts 完全对齐，仅保留 Hand 端发送和接收的消息类型

// ============================================================
// Server -> Hand 消息
// ============================================================

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

export interface ServerError {
  type: "error";
  sessionId?: string;
  message: string;
}

export interface Connected {
  type: "connected";
  sessionId?: string;
}

export interface CreatePtySession {
  type: "create_pty_session";
  cwd: string;
  homeDir?: string;
  model?: string;
  projectClaudeSettingsLocalContent?: string;
  cols?: number;
  rows?: number;
  term?: string;
  colorTerm?: string;
  termProgram?: string;
  termProgramVersion?: string;
}

export interface PtySessionCreated {
  type: "pty_session_created";
  sessionId: string;
}

export interface PtyInput {
  type: "pty_input";
  sessionId: string;
  data: string;
}

export interface PtyResize {
  type: "pty_resize";
  sessionId: string;
  cols: number;
  rows: number;
}

export interface PtyOutput {
  type: "pty_output";
  sessionId: string;
  data: string;
}

export interface PtyExit {
  type: "pty_exit";
  sessionId: string;
  exitCode?: number;
  signal?: string;
}

export interface McpToolDescriptor {
  name: string;
  title?: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
  outputSchema?: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  _meta?: Record<string, unknown>;
}

export interface McpServerCatalogEntry {
  tools: McpToolDescriptor[];
}

export type StdioMcpServerConfig = {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type SseMcpServerConfig = {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
};

export type HttpMcpServerConfig = {
  type: "http";
  url: string;
  headers?: Record<string, string>;
};

export type McpServerConfig =
  | StdioMcpServerConfig
  | SseMcpServerConfig
  | HttpMcpServerConfig;

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

export type FileProxyOp =
  | "getattr"
  | "readdir"
  | "read"
  | "write"
  | "create"
  | "unlink"
  | "mkdir"
  | "rmdir"
  | "rename"
  | "truncate"
  | "utimens"
  | "snapshot";

export interface FileProxyRequest {
  type: "file_proxy_request";
  reqId: string;
  sessionId: string;
  op: FileProxyOp;
  path: string;
  data?: string;
  offset?: number;
  size?: number;
  newPath?: string;
  mode?: number;
  mtime?: number;
  atime?: number;
}

export interface FileProxyStat {
  mode: number;
  size: number;
  mtime: number;
  atime: number;
  uid: number;
  gid: number;
  isDir: boolean;
}

/** snapshot 操作返回的单个文件/目录条目 */
export interface FileProxySnapshotEntry {
  path: string;
  stat: FileProxyStat;
  entries?: string[];
  data?: string;
}

export interface FileProxyResponse {
  type: "file_proxy_response";
  reqId: string;
  sessionId: string;
  error?: { code: number; message: string };
  stat?: FileProxyStat;
  entries?: string[];
  data?: string;
  written?: number;
  snapshot?: FileProxySnapshotEntry[];
}

// ============================================================
// Union 类型
// ============================================================

export type ServerToHandMessage =
  | Connected
  | FileProxyRequest
  | PtySessionCreated
  | PtyOutput
  | PtyExit
  | ServerError
  | ToolCall
  | ToolCallComplete;

export type HandToServerMessage =
  | CloseSession
  | CreatePtySession
  | FileProxyResponse
  | PtyInput
  | PtyResize
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

export function isToolCall(msg: ServerToHandMessage): msg is ToolCall {
  return msg.type === "tool_call";
}

export function isServerError(msg: ServerToHandMessage): msg is ServerError {
  return msg.type === "error";
}

export function isConnected(msg: ServerToHandMessage): msg is Connected {
  return msg.type === "connected";
}

export function isFileProxyRequest(msg: ServerToHandMessage): msg is FileProxyRequest {
  return msg.type === "file_proxy_request";
}
