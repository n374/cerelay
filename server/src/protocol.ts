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

// ============================================================
// Client 文件缓存同步协议
// Hand 连接 Server 时，先用 deviceId + cwd 作为 key 做一次缓存握手：
//   1. Hand → Server: cache_handshake，声明要同步哪些 scope
//   2. Server → Hand: cache_manifest，返回 Server 当前已持有的文件元数据
//   3. Hand 本地扫描 + diff，只上传 add/delete
//   4. Hand → Server: cache_push；Server → Hand: cache_push_ack
//
// 单文件上限 1MB、目录累计上限 100MB（按 mtime 倒序挑选），超限文件标记 skipped。
// ============================================================

/** 缓存覆盖的路径子集。claude-home = `~/.claude/` 目录，claude-json = `~/.claude.json` 单文件。 */
export type CacheScope = "claude-home" | "claude-json";

/** Server 侧缓存 manifest 中的单个条目。 */
export interface CacheEntry {
  /** 文件字节数（跳过的大文件也记录真实大小，便于后续判断） */
  size: number;
  /** 修改时间，毫秒 epoch */
  mtime: number;
  /**
   * 内容 sha256。skipped 的文件也可能填入实际 hash（如果 Hand 侧算过），
   * null 表示 Hand 侧没算也没传。
   */
  sha256: string | null;
  /**
   * true = 超过大小阈值被跳过，Server 侧没有 blob，读取时需要穿透 Client。
   * 未设置或 false = 正常缓存。
   */
  skipped?: boolean;
}

/** Server 端 manifest：按 scope 组织，每个 scope 下是 relativePath → CacheEntry 的映射。 */
export interface CacheManifestData {
  entries: Record<string, CacheEntry>;
}

/** Hand → Server：缓存握手，请求当前 Server 端的 manifest。 */
export interface CacheHandshake {
  type: "cache_handshake";
  deviceId: string;
  /** Hand 本次启动的工作目录绝对路径 */
  cwd: string;
  scopes: CacheScope[];
}

/** Server → Hand：返回 Server 端当前 manifest（新设备 / 新 cwd 时 entries 为空）。 */
export interface CacheManifest {
  type: "cache_manifest";
  deviceId: string;
  cwd: string;
  /** key = scope */
  manifests: Record<CacheScope, CacheManifestData>;
}

/** 单次推送中的一条新增/更新条目。 */
export interface CachePushEntry {
  /** 相对路径；claude-json scope 固定为 "" */
  path: string;
  size: number;
  mtime: number;
  /** 文件内容 sha256，skipped 的文件可选 */
  sha256: string;
  /** base64 编码的文件内容；skipped = true 时不携带 */
  content?: string;
  /** true 表示该文件超过大小阈值，仅更新元数据，Server 不保存 blob */
  skipped?: boolean;
}

/** Hand → Server：推送增量。adds/deletes/skippedExtras 均为相对路径。 */
export interface CachePush {
  type: "cache_push";
  deviceId: string;
  cwd: string;
  scope: CacheScope;
  adds: CachePushEntry[];
  deletes: string[];
  /**
   * true 表示该 scope 累计大小超过 100MB 阈值，Hand 已放弃同步剩余文件。
   * Server 侧应保留此标记以便后续诊断（manifest.truncated）。
   */
  truncated?: boolean;
}

/** Server → Hand：推送 ack。 */
export interface CachePushAck {
  type: "cache_push_ack";
  deviceId: string;
  cwd: string;
  scope: CacheScope;
  ok: boolean;
  error?: string;
}

export type ServerToHandMessage =
  | CacheManifest
  | CachePushAck
  | Connected
  | FileProxyRequest
  | PtySessionCreated
  | PtyOutput
  | PtyExit
  | ServerError
  | ToolCall
  | ToolCallComplete;

export type HandToServerMessage =
  | CacheHandshake
  | CachePush
  | CloseSession
  | CreatePtySession
  | FileProxyResponse
  | PtyInput
  | PtyResize
  | ToolResult;
