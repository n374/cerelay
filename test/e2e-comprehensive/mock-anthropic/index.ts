import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

// ============================================================
// 数据类型
// ============================================================

type Predicate =
  | { path: string; op: "contains" | "equals"; value: string };

interface ScriptMatch {
  turnIndex?: number;
  predicate?: Predicate;
  headerEquals?: Record<string, string>;
}

interface ScriptStreamEvent {
  kind:
    | "message_start"
    | "content_block_start"
    | "content_block_delta"      // 规范 Anthropic SSE event 名（涵盖 text_delta 和 input_json_delta payload）
    | "input_json_delta"         // 保留为 content_block_delta 的 alias（spec 早期示例笔误，向后兼容保留）
    | "content_block_stop"
    | "message_delta"
    | "message_stop";
  [key: string]: unknown;
}

interface ScriptDef {
  name: string;
  match: ScriptMatch;
  respond: { type: "stream"; events: ScriptStreamEvent[] };
}

interface CapturedRequest {
  index: number;       // reset 后递增
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  toolResults: Array<{ tool_use_id: string; content: string; is_error: boolean }>;
  matchedScript: string | null;
  receivedAt: string;  // ISO
}

// ============================================================
// 全局状态
// ============================================================

const scripts: ScriptDef[] = [];
const captured: CapturedRequest[] = [];
let counter = 0;

function reset(): void {
  scripts.length = 0;
  captured.length = 0;
  counter = 0;
}

function pickScript(req: CapturedRequest): ScriptDef | null {
  for (const s of scripts) {
    if (s.match.turnIndex !== undefined && s.match.turnIndex !== req.index) continue;
    if (s.match.headerEquals) {
      let ok = true;
      for (const [k, v] of Object.entries(s.match.headerEquals)) {
        if (req.headers[k.toLowerCase()] !== v) { ok = false; break; }
      }
      if (!ok) continue;
    }
    if (s.match.predicate) {
      const v = getByPath(req.body, s.match.predicate.path);
      if (typeof v !== "string") continue;
      if (s.match.predicate.op === "contains" && !v.includes(s.match.predicate.value)) continue;
      if (s.match.predicate.op === "equals" && v !== s.match.predicate.value) continue;
    }
    return s;
  }
  return null;
}

function getByPath(obj: unknown, path: string): unknown {
  // 支持 "messages[0].content" 这种 dotted+index 路径
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function flattenToolResults(body: Record<string, unknown>): CapturedRequest["toolResults"] {
  const out: CapturedRequest["toolResults"] = [];
  const messages = (body.messages as Array<{ role: string; content: unknown }>) || [];
  for (const m of messages) {
    if (m.role !== "user") continue;
    if (typeof m.content !== "object" || m.content === null) continue;
    const blocks = m.content as Array<Record<string, unknown>>;
    for (const b of blocks) {
      if (b.type !== "tool_result") continue;
      const id = (b.tool_use_id as string) || "";
      const content = typeof b.content === "string"
        ? b.content
        : JSON.stringify(b.content);
      const isError = (b.is_error as boolean) ?? false;
      out.push({ tool_use_id: id, content, is_error: isError });
    }
  }
  return out;
}

// ============================================================
// HTTP handlers
// ============================================================

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function streamScript(res: ServerResponse, script: ScriptDef): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "connection": "keep-alive",
  });
  // 简化：每个 event 输出 `event: <type>\ndata: <json>\n\n`
  for (const ev of script.respond.events) {
    res.write(`event: ${ev.kind}\n`);
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  }
  res.end();
}

function streamFallbackText(res: ServerResponse, text: string): void {
  // 没匹配到剧本时的兜底：返回一段普通文本
  const id = `msg_${randomUUID()}`;
  const events: ScriptStreamEvent[] = [
    { kind: "message_start", message: { id, role: "assistant", model: "claude-mock", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } },
    { kind: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { kind: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { kind: "content_block_stop", index: 0 },
    { kind: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { kind: "message_stop" },
  ];
  streamScript(res, { name: "<fallback>", match: {}, respond: { type: "stream", events } });
}

const server = createServer(async (req, res) => {
  try {
    const url = req.url || "/";
    if (url === "/admin/reset" && req.method === "POST") {
      reset();
      return sendJson(res, 200, { ok: true });
    }
    if (url === "/admin/scripts" && req.method === "POST") {
      const body = JSON.parse(await readBody(req)) as ScriptDef;
      scripts.push(body);
      return sendJson(res, 200, { ok: true, total: scripts.length });
    }
    if (url === "/admin/captured" && req.method === "GET") {
      return sendJson(res, 200, captured);
    }
    if (url === "/v1/messages" && req.method === "POST") {
      counter += 1;
      const raw = await readBody(req);
      const body = JSON.parse(raw);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers[k] = v;
        else if (Array.isArray(v)) headers[k] = v.join(",");
      }
      const cap: CapturedRequest = {
        index: counter,
        url,
        method: req.method,
        headers,
        body,
        toolResults: flattenToolResults(body),
        matchedScript: null,
        receivedAt: new Date().toISOString(),
      };
      const script = pickScript(cap);
      cap.matchedScript = script?.name ?? null;
      captured.push(cap);
      if (script) {
        streamScript(res, script);
      } else {
        streamFallbackText(res, "[mock fallback] no script matched");
      }
      return;
    }
    sendJson(res, 404, { error: "not found", url });
  } catch (err) {
    sendJson(res, 500, { error: String(err) });
  }
});

const port = Number.parseInt(process.env.PORT || "8080", 10);
server.listen(port, () => {
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr !== null ? addr.port : port;
  // eslint-disable-next-line no-console
  console.log(`[mock-anthropic] listening on :${actualPort}`);
});
