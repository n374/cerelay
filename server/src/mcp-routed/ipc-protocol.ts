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
  const obj = value as Record<string, unknown>;
  switch (obj.type) {
    case "hello":
      return typeof obj.token === "string" ? ({ type: "hello", token: obj.token } satisfies IpcHello) : null;
    case "hello_ack":
      if (typeof obj.ok !== "boolean") {
        return null;
      }
      return {
        type: "hello_ack",
        ok: obj.ok,
        error: typeof obj.error === "string" ? obj.error : undefined,
      } satisfies IpcHelloAck;
    case "tool_call":
      if (typeof obj.id !== "string" || typeof obj.toolName !== "string") {
        return null;
      }
      return {
        type: "tool_call",
        id: obj.id,
        toolName: obj.toolName,
        input: obj.input,
      } satisfies IpcToolCallRequest;
    case "tool_result":
      if (typeof obj.id !== "string") {
        return null;
      }
      return {
        type: "tool_result",
        id: obj.id,
        output: obj.output,
        summary: typeof obj.summary === "string" ? obj.summary : undefined,
        error: typeof obj.error === "string" ? obj.error : undefined,
      } satisfies IpcToolCallResponse;
    default:
      return null;
  }
}
