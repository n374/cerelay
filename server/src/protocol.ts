export interface Envelope {
  type: string;
}

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

export interface CreateSession {
  type: "create_session";
  cwd: string;
  model?: string;
}

export interface CreateSessionResponse {
  type: "session_created";
  sessionId: string;
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

export interface ListSessions {
  type: "list_sessions";
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

export interface CloseSession {
  type: "close_session";
  sessionId: string;
}

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
