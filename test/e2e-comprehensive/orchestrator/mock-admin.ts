const BASE = process.env.MOCK_ANTHROPIC_URL || "http://mock-anthropic:8080";

export interface ScriptDef {
  name: string;
  match: {
    turnIndex?: number;
    predicate?: { path: string; op: "contains" | "equals"; value: string };
    headerEquals?: Record<string, string>;
  };
  respond: { type: "stream"; events: Array<Record<string, unknown>> };
}

export interface CapturedRequest {
  index: number;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  toolResults: Array<{ tool_use_id: string; content: string; is_error: boolean }>;
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
