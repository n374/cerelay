// ============================================================
// cerelay-routed MCP server ↔ cerelay-server 主进程 IPC 协议
// IPC ↔ main process protocol for cerelay-routed MCP server
//
// 通过 per-session Unix socket 行式 JSON 通信。
// Per-session line-delimited JSON over Unix socket.
// ============================================================

export interface IpcHello {
  type: "hello";
  token: string;
}

export interface IpcHelloAck {
  type: "hello_ack";
  ok: boolean;
  error?: string;
}

export interface IpcToolCallRequest {
  type: "tool_call";
  id: string;
  /** 镜像内置工具名（Bash/Read/Write/Edit/MultiEdit/Glob/Grep） */
  toolName: string;
  input: unknown;
}

export interface IpcToolCallResponse {
  type: "tool_result";
  id: string;
  output?: unknown;
  summary?: string;
  error?: string;
}

export type IpcMessage = IpcHello | IpcHelloAck | IpcToolCallRequest | IpcToolCallResponse;

export function encodeIpcMessage(message: IpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * 把累积的 buffer 切成完整行，返回解析出的消息 + 残留未完整行。
 * Split accumulated buffer into complete lines. Returns parsed messages + leftover.
 */
export function decodeIpcLines(buffer: string): { messages: IpcMessage[]; rest: string } {
  const messages: IpcMessage[] = [];
  let start = 0;
  let idx: number;
  while ((idx = buffer.indexOf("\n", start)) !== -1) {
    const line = buffer.slice(start, idx).trim();
    start = idx + 1;
    if (!line) {
      continue;
    }
    const parsed = parseIpcLine(line);
    if (parsed) {
      messages.push(parsed);
    }
  }
  return { messages, rest: buffer.slice(start) };
}

function parseIpcLine(line: string): IpcMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const type = (value as { type?: unknown }).type;
  if (type !== "hello" && type !== "hello_ack" && type !== "tool_call" && type !== "tool_result") {
    return null;
  }
  return value as IpcMessage;
}
