const BASE = process.env.MOCK_ANTHROPIC_URL || "http://mock-anthropic:8080";

/**
 * INF-9: respond 支持两种模式。
 * - stream: 正常 SSE 模型响应
 * - error: 直接返回 HTTP error (G3-mock-5xx case 用)
 */
export type ScriptResponse =
  | { type: "stream"; events: Array<Record<string, unknown>> }
  | { type: "error"; status: number; body?: string | Record<string, unknown> };

export interface ScriptDef {
  name: string;
  match: {
    turnIndex?: number;
    predicate?: { path: string; op: "contains" | "equals"; value: string };
    headerEquals?: Record<string, string>;
  };
  respond: ScriptResponse;
}

export interface ToolResultBlock {
  tool_use_id: string;
  content: string;
  is_error: boolean;
}

export interface CapturedRequest {
  index: number;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  /** I4: 全部历史 tool_result（累计所有 user message）。仅 transcript 级断言用。 */
  toolResultsAll: ToolResultBlock[];
  /**
   * I4: 仅当前 turn 的 tool_result（messages 末尾 user message 内的 tool_result blocks）。
   * 日常 case 应使用本字段：1 个 turn 1 tool 时取 [0]，并发多 tool 时取整个数组。
   */
  toolResultsCurrentTurn: ToolResultBlock[];
  matchedScript: string | null;
  receivedAt: string;
}

async function postJson(path: string, body?: unknown): Promise<unknown> {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`mock POST ${path} → ${r.status}: ${await r.text()}`);
  return r.json();
}

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`);
  if (!r.ok) throw new Error(`mock GET ${path} → ${r.status}: ${await r.text()}`);
  return await r.json() as T;
}

export const mockAdmin = {
  async reset(): Promise<void> {
    await postJson("/admin/reset");
  },
  async loadScript(script: ScriptDef): Promise<void> {
    await postJson("/admin/scripts", script);
  },
  async captured(): Promise<CapturedRequest[]> {
    return await getJson<CapturedRequest[]>("/admin/captured");
  },
};

// ---- 常用剧本 builders ----
// 注意：events[*].kind 直接对应 SSE wire-format 的 event: 名（content_block_delta 是
// Anthropic 规范名，data payload 内 delta.type 区分 text_delta / input_json_delta）。
// 详见 docs/e2e-comprehensive-testing.md §3.2 SSE event 命名说明。

export function scriptToolUse(opts: { toolName: string; toolUseId: string; input: Record<string, unknown> }): ScriptDef["respond"] {
  return {
    type: "stream",
    events: [
      { type: "message_start", message: { id: `msg_${opts.toolUseId}`, type: "message", role: "assistant", model: "claude-mock", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: opts.toolUseId, name: opts.toolName, input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(opts.input) } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 16 } },
      { type: "message_stop" },
    ],
  };
}

/**
 * 单条 assistant message 内多 tool_use 块（并发工具调用）。
 * 用于 F1：模型一次返回 N 个 tool_use，CC 应并发执行。
 * 索引从 0 起；每个 block 独立的 content_block_start/delta/stop。
 */
export function scriptParallelToolUse(
  tools: Array<{ toolName: string; toolUseId: string; input: Record<string, unknown> }>,
): ScriptDef["respond"] {
  const events: Array<Record<string, unknown>> = [
    { type: "message_start", message: { id: `msg_par_${tools[0]?.toolUseId ?? "x"}`, type: "message", role: "assistant", model: "claude-mock", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
  ];
  tools.forEach((t, i) => {
    events.push(
      { type: "content_block_start", index: i, content_block: { type: "tool_use", id: t.toolUseId, name: t.toolName, input: {} } },
      { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(t.input) } },
      { type: "content_block_stop", index: i },
    );
  });
  events.push(
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: tools.length } },
    { type: "message_stop" },
  );
  return { type: "stream", events };
}

/**
 * INF-9: 让 mock 直接返回 HTTP error,不走 SSE。
 * - status: 5xx (G3 用 500/502/503),也可 4xx
 * - body: string 或对象,默认 { error: { type: "api_error", message: ... } }
 *
 * 用于 G3-mock-5xx case:验 cerelay session 在 anthropic 上游 5xx 时
 * 优雅终止 (server 应抛错 + cleanup,不应 partial stream 卡住或 OOM)
 */
export function scriptError(status: number, body?: string | Record<string, unknown>): ScriptDef["respond"] {
  return body !== undefined ? { type: "error", status, body } : { type: "error", status };
}

export function scriptText(text: string): ScriptDef["respond"] {
  return {
    type: "stream",
    events: [
      { type: "message_start", message: { id: "msg_text", type: "message", role: "assistant", model: "claude-mock", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: text.length || 1 } },
      { type: "message_stop" },
    ],
  };
}
