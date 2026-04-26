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
  /** 本机持久化的 deviceId，Server 用它定位 cache 目录 */
  deviceId?: string;
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
// Client 文件缓存同步协议（与 server/src/protocol.ts 对齐）
// Server 以 (deviceId, cwd) 为 key 维护 cache task，active client 负责：
//   1. 收到 cache_task_assignment 后执行 initial reconcile
//   2. 持续发送 cache_task_delta 增量更新
//   3. 在 watcher 建立后发送 cache_task_sync_complete 切到 ready
// ============================================================

export type CacheScope = "claude-home" | "claude-json";

export interface CacheEntry {
  size: number;
  mtime: number;
  sha256: string | null;
  skipped?: boolean;
}

export interface CacheManifestData {
  entries: Record<string, CacheEntry>;
  truncated?: boolean;
}

export interface CacheTaskManifestSnapshot {
  revision: number;
  scopes: Record<CacheScope, CacheManifestData>;
}

export type CacheTaskRole = "active" | "inactive";

export type CacheTaskAssignmentReason =
  | "elected"
  | "standby"
  | "failover"
  | "resync"
  | "server_restart"
  | "capability_missing";

export type CacheTaskPhase = "assigned-syncing" | "assigned-watching";

export type CacheTaskFaultCode =
  | "WATCHER_OVERFLOW"
  | "WATCHER_PERMISSION_DENIED"
  | "WATCHER_ROOT_MISSING"
  | "LOCAL_SCAN_FAILED"
  | "INTERNAL_ERROR";

export type CacheTaskAckErrorCode =
  | "STALE_ASSIGNMENT"
  | "STALE_REVISION"
  | "NOT_ACTIVE"
  | "SHA256_MISMATCH"
  | "STORE_WRITE_FAILED"
  | "PAYLOAD_TOO_LARGE";

export interface ClientHello {
  type: "client_hello";
  deviceId?: string;
  cwd: string;
  capabilities: {
    cacheTaskV1?: {
      protocolVersion: 1;
      maxFileBytes: number;
      maxBatchBytes: number;
      debounceMs: number;
      watcherBackend: "chokidar";
    };
  };
}

export interface CacheTaskAssignment {
  type: "cache_task_assignment";
  deviceId: string;
  cwd: string;
  assignmentId: string;
  role: CacheTaskRole;
  reason: CacheTaskAssignmentReason;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  manifest?: CacheTaskManifestSnapshot;
}

export interface CacheTaskMutationHintTarget {
  scope: CacheScope;
  path: string;
}

export interface CacheTaskMutationHint {
  type: "cache_task_mutation_hint";
  assignmentId: string;
  mutationId: string;
  targets: CacheTaskMutationHintTarget[];
  issuedAt: number;
}

export interface CacheTaskUpsertChange {
  kind: "upsert";
  scope: CacheScope;
  path: string;
  size: number;
  mtime: number;
  sha256: string | null;
  contentBase64?: string;
  skipped?: boolean;
  mutationId?: string;
}

export interface CacheTaskDeleteChange {
  kind: "delete";
  scope: CacheScope;
  path: string;
  mutationId?: string;
}

export type CacheTaskChange = CacheTaskUpsertChange | CacheTaskDeleteChange;

export type CacheTaskDeltaMode = "initial" | "live";

export interface CacheTaskDelta {
  type: "cache_task_delta";
  assignmentId: string;
  batchId: string;
  baseRevision: number;
  mode: CacheTaskDeltaMode;
  changes: CacheTaskChange[];
  sentAt: number;
}

export interface CacheTaskDeltaAck {
  type: "cache_task_delta_ack";
  assignmentId: string;
  batchId: string;
  ok: boolean;
  appliedRevision?: number;
  errorCode?: CacheTaskAckErrorCode;
  error?: string;
  resyncRequired?: boolean;
}

export interface CacheTaskSyncComplete {
  type: "cache_task_sync_complete";
  assignmentId: string;
  /**
   * Client 完成 initial reconcile 时所知的最新 revision。
   * 这个值可以是接收 assignment 时的 manifest.revision，
   * 也可以是最后一次 cache_task_delta_ack.appliedRevision。
   * Server 接受 baseRevision <= task.revision，只在 baseRevision 反常地超过当前 task.revision 时要求 resync。
   */
  baseRevision: number;
  scannedAt: number;
}

export interface CacheTaskHeartbeat {
  type: "cache_task_heartbeat";
  assignmentId: string;
  phase: CacheTaskPhase;
  watcherHealth: "ok" | "degraded";
  lastFlushAt?: number;
  sentAt: number;
}

export interface CacheTaskFault {
  type: "cache_task_fault";
  assignmentId: string;
  code: CacheTaskFaultCode;
  fatal: boolean;
  message: string;
  sentAt: number;
}

// ============================================================
// Union 类型
// ============================================================

export type ServerToHandMessage =
  | CacheTaskAssignment
  | CacheTaskMutationHint
  | CacheTaskDeltaAck
  | Connected
  | FileProxyRequest
  | PtySessionCreated
  | PtyOutput
  | PtyExit
  | ServerError
  | ToolCall
  | ToolCallComplete;

export type HandToServerMessage =
  | CacheTaskDelta
  | CacheTaskFault
  | CacheTaskHeartbeat
  | CacheTaskSyncComplete
  | ClientHello
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
