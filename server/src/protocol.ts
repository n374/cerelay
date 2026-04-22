export interface Envelope {
  type: string;
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

// ============================================================
// File Proxy：Hand 侧文件系统代理（FUSE 透传）
// ============================================================

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
