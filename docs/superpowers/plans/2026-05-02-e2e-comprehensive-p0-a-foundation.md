# E2E 综合测试 P0-A：Foundation + Canary Cases 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 立起 docs/e2e-comprehensive-testing.md §3 描述的全链路 e2e 框架（多容器：orchestrator + mock-anthropic + server + N×client + thin agent），并跑通 2 个 canary case（A1-bash-basic、B4-ancestor-claudemd）证明框架闭环 + 守住 IFS bug 类 regression。

**Architecture:**
- 多容器拓扑（docker-compose.e2e.yml），orchestrator 容器跑 node-test 框架，纯 HTTP 调 mock-anthropic admin / client agent / server admin events
- mock-anthropic 是个独立 node http 服务（扩展自现有 `server/test/fixtures/mock-anthropic-api.ts`），暴露 `/v1/messages` + `/admin/*`
- client agent 是 ~50 行 thin http 包装，spawn 真 cerelay-client CLI
- server 端**新增** `/admin/events`（gated by `CERELAY_ADMIN_EVENTS=true`），orchestrator 用现有 admin token 鉴权拉取结构化事件

**与 spec 的偏差 / Spec deviations:**
- spec §3.1/§4.2 给的拓扑图标了 server admin events 走独立 `:8766` 端口；本 plan 复用现有 `:8765` 上的 `/admin/*` 路由组（已经有 token 鉴权基础设施），少一个 docker port mapping。spec 待 plan 落地后同步修正。
- spec §4.1 列了 `orchestrator/index.ts`；本 plan 用 `phase-p0.test.ts` 直接当入口，不需要再开一个壳子文件（node:test 会直接 run test 文件）。
- 服务名大小写：spec 拓扑图写 `client-A/B`，docker-compose 实际用全小写 `client-a/client-b`（保持与现有 `docker-compose.test.yml` 一致），orchestrator 内仍用 `"client-a"` 字符串当 label。

**Tech Stack:** Node 22 + TypeScript + node:test + Docker Compose + 现有 cerelay server/client 二进制

**关联 spec：** [`docs/e2e-comprehensive-testing.md`](../../e2e-comprehensive-testing.md)

---

## 0. 文件结构 / File Structure

| 路径 | 职责 | 创建/修改 |
|---|---|---|
| `docker-compose.e2e.yml` | 多容器拓扑（orchestrator + mock + server + client-A + client-B） | Create |
| `Dockerfile.e2e-orchestrator` | orchestrator 镜像 | Create |
| `Dockerfile.e2e-client-agent` | client agent 镜像（基于 Dockerfile） | Create |
| `Dockerfile.e2e-mock-anthropic` | mock-anthropic 镜像（基于 node:22-slim） | Create |
| `test/run-e2e-comprehensive.sh` | shell 入口，被 `run-host-tests.sh` 调起 | Create |
| `test/run-host-tests.sh` | 在末尾追加 `run-e2e-comprehensive.sh` 调用 | Modify |
| `package.json` | 加 `test:e2e` script | Modify |
| `test/e2e-comprehensive/orchestrator/mock-admin.ts` | 调 mock-anthropic admin 的薄 client | Create |
| `test/e2e-comprehensive/orchestrator/clients.ts` | 调 client agent 的薄 client | Create |
| `test/e2e-comprehensive/orchestrator/server-events.ts` | 调 server admin events 的薄 client | Create |
| `test/e2e-comprehensive/orchestrator/fixtures.ts` | 测试数据生成（写入 client 共享 volume） | Create |
| `test/e2e-comprehensive/orchestrator/phase-p0.test.ts` | A1 + B4 两个 canary case | Create |
| `test/e2e-comprehensive/orchestrator/package.json` | orchestrator workspace（独立 tsx + node:test） | Create |
| `test/e2e-comprehensive/orchestrator/tsconfig.json` | TS 配置 | Create |
| `test/e2e-comprehensive/agent/index.ts` | client thin HTTP agent | Create |
| `test/e2e-comprehensive/mock-anthropic/index.ts` | 可编程 mock + admin endpoints | Create |
| `server/src/admin-events.ts` | 结构化事件 ring buffer + admin endpoint handler | Create |
| `server/src/server.ts` | 注册 `/admin/events`（gated）+ 全局 emit hook | Modify |
| `server/src/pty-session.ts` | namespace bootstrap ready / tool relay 完成时 emit event | Modify |

**目录约定**：
- `test/e2e-comprehensive/` 是独立子树，不跟 server/client/web workspaces 混在一起。其内的 `orchestrator/` 和 `agent/` 各有自己的 npm scripts，但不参与根 `npm run typecheck`（因为它们运行在容器里，依赖路径与宿主不同）。
- `mock-anthropic/` 同样独立，从 `server/test/fixtures/mock-anthropic-api.ts` 复制核心逻辑后扩展（不直接 import server 内部 module，避免拉一堆 deps）。

---

## Stage A：Foundation（Tasks 1-7）

### Task 1：mock-anthropic 服务实现

**Files:**
- Create: `test/e2e-comprehensive/mock-anthropic/index.ts`
- Create: `test/e2e-comprehensive/mock-anthropic/package.json`
- Create: `test/e2e-comprehensive/mock-anthropic/tsconfig.json`
- Create: `test/e2e-comprehensive/mock-anthropic/index.test.ts`（自验证 mock 行为）

- [ ] **Step 1.1: 创建 package.json**

```json
{
  "name": "cerelay-e2e-mock-anthropic",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "tsx index.ts",
    "test": "node --import tsx --test index.test.ts"
  },
  "dependencies": {},
  "devDependencies": {
    "tsx": "latest",
    "typescript": "latest",
    "@types/node": "latest"
  }
}
```

- [ ] **Step 1.2: 创建 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true
  }
}
```

- [ ] **Step 1.3: 编写 index.ts（核心 mock + admin endpoints）**

```typescript
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
    | "input_json_delta"
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
    { kind: "input_json_delta", index: 0, delta: { type: "text_delta", text } },
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
  // eslint-disable-next-line no-console
  console.log(`[mock-anthropic] listening on :${port}`);
});
```

- [ ] **Step 1.4: 编写 index.test.ts（自验证 mock 行为）**

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const MOCK_PORT = 18080;
let proc: ChildProcess | null = null;

async function startMock(): Promise<void> {
  proc = spawn("node", ["--import", "tsx", path.join(import.meta.dirname, "index.ts")], {
    env: { ...process.env, PORT: String(MOCK_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // 等监听
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${MOCK_PORT}/admin/captured`);
      if (r.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error("mock 启动超时");
}

test.after(async () => {
  if (proc && !proc.killed) {
    proc.kill("SIGTERM");
    await new Promise<void>((r) => proc!.once("exit", () => r()));
  }
});

test("mock-anthropic: turnIndex 匹配 + captured 返回 + reset 清空", async () => {
  await startMock();
  await fetch(`http://127.0.0.1:${MOCK_PORT}/admin/reset`, { method: "POST" });

  await fetch(`http://127.0.0.1:${MOCK_PORT}/admin/scripts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "test-1",
      match: { turnIndex: 1 },
      respond: { type: "stream", events: [{ kind: "message_stop" }] },
    }),
  });

  const r = await fetch(`http://127.0.0.1:${MOCK_PORT}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "x", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(r.status, 200);
  // 消费 SSE 流避免 server 端写完整数据
  await r.text();

  const cap = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/admin/captured`)).json() as Array<{ index: number; matchedScript: string | null }>;
  assert.equal(cap.length, 1);
  assert.equal(cap[0].index, 1);
  assert.equal(cap[0].matchedScript, "test-1");

  await fetch(`http://127.0.0.1:${MOCK_PORT}/admin/reset`, { method: "POST" });
  const after = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/admin/captured`)).json() as unknown[];
  assert.equal(after.length, 0);
});

test("mock-anthropic: predicate 路径匹配（messages[0].content contains marker）", async () => {
  await fetch(`http://127.0.0.1:${MOCK_PORT}/admin/reset`, { method: "POST" });
  await fetch(`http://127.0.0.1:${MOCK_PORT}/admin/scripts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "marker-A",
      match: { predicate: { path: "messages[0].content", op: "contains", value: "MARKER-A" } },
      respond: { type: "stream", events: [{ kind: "message_stop" }] },
    }),
  });
  await fetch(`http://127.0.0.1:${MOCK_PORT}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "x", messages: [{ role: "user", content: "hello MARKER-A please" }] }),
  }).then((r) => r.text());

  const cap = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/admin/captured`)).json() as Array<{ matchedScript: string | null }>;
  assert.equal(cap.at(-1)?.matchedScript, "marker-A");
});
```

- [ ] **Step 1.5: 跑测试验证 mock 自身行为**

Run: `cd test/e2e-comprehensive/mock-anthropic && npm install && npm test`
Expected: 2 个 test 全 pass

- [ ] **Step 1.6: Commit**

```bash
git add test/e2e-comprehensive/mock-anthropic/
git commit -m "$(cat <<'EOF'
🌱 e2e / Foundation: mock-anthropic 可编程 SSE mock + admin endpoints

实现 docs/e2e-comprehensive-testing.md §3.2 的 mock 协议：
- POST /v1/messages：捕获请求 + 按 script 流式回放
- POST /admin/scripts：注入剧本（turnIndex / predicate / headerEquals 匹配）
- POST /admin/reset：清 captured + scripts
- GET  /admin/captured：返回所有捕获请求 + 是否命中剧本

自验证测试覆盖 turnIndex 匹配 + predicate 路径匹配 + reset 清空。

e2e coverage: 本身是 e2e 框架的一部分；后续在 phase-p0.test.ts 验证完整链路

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2：client thin agent 实现

**Files:**
- Create: `test/e2e-comprehensive/agent/index.ts`
- Create: `test/e2e-comprehensive/agent/package.json`
- Create: `test/e2e-comprehensive/agent/tsconfig.json`

- [ ] **Step 2.1: package.json**

```json
{
  "name": "cerelay-e2e-client-agent",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "tsx index.ts"
  },
  "devDependencies": {
    "tsx": "latest",
    "typescript": "latest",
    "@types/node": "latest"
  }
}
```

- [ ] **Step 2.2: tsconfig.json**

同 mock-anthropic（同样的 minimal config）：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true
  }
}
```

- [ ] **Step 2.3: index.ts**

```typescript
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

interface RunRequest {
  prompt: string;
  cwd: string;
  deviceLabel?: string;     // 仅日志用
  extraArgs?: string[];
  timeoutMs?: number;
}

interface RunResponse {
  exitCode: number;
  stdout: string;
  stderr: string;
  sessionId: string;        // 由 agent 生成（client 内部 sessionId 由 server 端分配，agent 仅给一个 trace id）
  durationMs: number;
}

const CLIENT_BIN = process.env.CLIENT_BIN || "/app/client/dist/index.js";
const SERVER_URL = process.env.SERVER_URL || "ws://server:8765/ws";

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function runClient(req: RunRequest): Promise<RunResponse> {
  const traceId = randomUUID();
  const startedAt = Date.now();
  const args = [
    CLIENT_BIN,
    "--server", SERVER_URL,
    "--cwd", req.cwd,
    "--prompt", req.prompt,
    ...(req.extraArgs ?? []),
  ];

  return await new Promise<RunResponse>((resolve, reject) => {
    const child = spawn("node", args, {
      env: {
        ...process.env,
        CERELAY_E2E_TRACE_ID: traceId,
        CERELAY_E2E_DEVICE_LABEL: req.deviceLabel || "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on("data", (c) => stdoutChunks.push(Buffer.from(c)));
    child.stderr?.on("data", (c) => stderrChunks.push(Buffer.from(c)));

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`client timeout after ${req.timeoutMs ?? 60_000}ms`));
    }, req.timeoutMs ?? 60_000);

    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        sessionId: traceId,
        durationMs: Date.now() - startedAt,
      });
    });

    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

const server = createServer(async (req, res) => {
  try {
    if (req.url === "/healthz" && req.method === "GET") {
      return sendJson(res, 200, { ok: true });
    }
    if (req.url === "/run" && req.method === "POST") {
      const body = JSON.parse(await readBody(req)) as RunRequest;
      if (!body.prompt || !body.cwd) {
        return sendJson(res, 400, { error: "prompt + cwd required" });
      }
      try {
        const result = await runClient(body);
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, 500, { error: String(err) });
      }
    }
    sendJson(res, 404, { error: "not found", url: req.url });
  } catch (err) {
    sendJson(res, 500, { error: String(err) });
  }
});

const port = Number.parseInt(process.env.PORT || "9100", 10);
server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`[client-agent] listening on :${port} → ${SERVER_URL} (bin=${CLIENT_BIN})`);
});
```

- [ ] **Step 2.4: 本地 lint check（不跑实际逻辑，只确认语法）**

Run: `cd test/e2e-comprehensive/agent && npm install && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 2.5: Commit**

```bash
git add test/e2e-comprehensive/agent/
git commit -m "$(cat <<'EOF'
🌱 e2e / Foundation: client thin agent（HTTP wrapper for spawning cerelay-client）

实现 docs/e2e-comprehensive-testing.md §3.3：
- POST /run {prompt, cwd, deviceLabel?, extraArgs?, timeoutMs?}
- 内部 spawn `node /app/client/dist/index.js --server <SERVER_URL> --cwd <cwd> --prompt <prompt>`
- 收齐 stdout/stderr 后回写；CERELAY_E2E_TRACE_ID 注入 client env 便于日志关联
- GET /healthz 用于 docker-compose healthcheck

后续 docker compose 会启 N 个 agent 容器（client-A/B/C），每个独立 deviceId。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3：server 端 admin-events 模块 + 注册

**Files:**
- Create: `server/src/admin-events.ts`
- Modify: `server/src/server.ts`（注册 endpoint + 暴露 emitter 给 pty-session）
- Modify: `server/src/pty-session.ts`（关键节点 emit event）
- Create: `server/test/admin-events.test.ts`

- [ ] **Step 3.1: 写 admin-events.ts**

```typescript
// server/src/admin-events.ts
// ============================================================
// 测试用结构化事件 ring buffer。
// 仅当 process.env.CERELAY_ADMIN_EVENTS === "true" 时启用 record；
// 关闭时 record/fetch 都是 no-op，零开销。
// 通过 server.ts 注册到 /admin/events?sessionId=&since=
// ============================================================

export interface AdminEvent {
  /** 单调递增 id，从 1 开始；orchestrator 用 since=<id> 增量拉取 */
  id: number;
  ts: string;       // ISO
  sessionId: string | null;
  kind: string;     // 例如 "namespace.bootstrap.ready" / "tool.relay.completed"
  detail?: Record<string, unknown>;
}

const MAX_BUFFER = 10_000;

export class AdminEventBuffer {
  private buf: AdminEvent[] = [];
  private nextId = 1;

  constructor(private readonly enabled: boolean) {}

  record(kind: string, sessionId: string | null, detail?: Record<string, unknown>): void {
    if (!this.enabled) return;
    const ev: AdminEvent = {
      id: this.nextId++,
      ts: new Date().toISOString(),
      sessionId,
      kind,
      detail,
    };
    this.buf.push(ev);
    if (this.buf.length > MAX_BUFFER) {
      this.buf.splice(0, this.buf.length - MAX_BUFFER);
    }
  }

  fetch(opts: { sessionId?: string; since?: number }): AdminEvent[] {
    if (!this.enabled) return [];
    return this.buf.filter((e) => {
      if (opts.sessionId && e.sessionId !== opts.sessionId) return false;
      if (opts.since !== undefined && e.id <= opts.since) return false;
      return true;
    });
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}

export function createAdminEventBuffer(): AdminEventBuffer {
  return new AdminEventBuffer(process.env.CERELAY_ADMIN_EVENTS === "true");
}
```

- [ ] **Step 3.2: 写 admin-events.test.ts**

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { AdminEventBuffer } from "../src/admin-events.js";

test("AdminEventBuffer: 关闭时 record/fetch 都是 no-op", () => {
  const buf = new AdminEventBuffer(false);
  buf.record("test.kind", "s1", { foo: "bar" });
  assert.deepEqual(buf.fetch({}), []);
});

test("AdminEventBuffer: 开启时 record + 单调 id + sessionId/since 过滤", () => {
  const buf = new AdminEventBuffer(true);
  buf.record("a", "s1");
  buf.record("b", "s2");
  buf.record("c", "s1");
  const all = buf.fetch({});
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((e) => e.id), [1, 2, 3]);

  const onlyS1 = buf.fetch({ sessionId: "s1" });
  assert.deepEqual(onlyS1.map((e) => e.kind), ["a", "c"]);

  const sinceFirst = buf.fetch({ since: 1 });
  assert.deepEqual(sinceFirst.map((e) => e.id), [2, 3]);
});

test("AdminEventBuffer: 超过 MAX_BUFFER (10k) 时自动丢最早", () => {
  const buf = new AdminEventBuffer(true);
  for (let i = 0; i < 10_005; i++) buf.record("k", null);
  const all = buf.fetch({});
  assert.equal(all.length, 10_000);
  assert.equal(all[0].id, 6);             // 1-5 被丢
  assert.equal(all.at(-1)?.id, 10_005);
});
```

- [ ] **Step 3.3: 跑测试验证 buffer 自身行为**

Run: `cd server && node --import tsx --test test/admin-events.test.ts`
Expected: 3/3 pass

- [ ] **Step 3.4: 在 server.ts 注册 /admin/events endpoint**

Modify `server/src/server.ts`：

(a) 在 imports 末尾加：

```typescript
import { createAdminEventBuffer, type AdminEventBuffer } from "./admin-events.js";
```

(b) 在 `class Server` 字段区加（找到 `tokenStore` 旁边）：

```typescript
  readonly adminEvents: AdminEventBuffer = createAdminEventBuffer();
```

(c) 在 admin handler 里（找到 `if (url === "/admin/sessions" && req.method === "GET")` 那段附近）加：

```typescript
    if (url.startsWith("/admin/events") && req.method === "GET") {
      const u = new URL(url, "http://x");
      const sessionId = u.searchParams.get("sessionId") ?? undefined;
      const sinceStr = u.searchParams.get("since");
      const since = sinceStr ? Number.parseInt(sinceStr, 10) : undefined;
      const events = this.adminEvents.fetch({ sessionId, since });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ enabled: this.adminEvents.isEnabled(), events }));
      return;
    }
```

(d) 暴露给 pty-session：找到 `new ClaudePtySession({...})` 构造点，加一个字段 `adminEvents: this.adminEvents`（这要求 ClaudePtySession 接受新字段，见 Step 3.5）。

- [ ] **Step 3.5: pty-session.ts 接 adminEvents**

定位 `server/src/pty-session.ts` 内 `class ClaudePtySession` 的构造参数 interface（搜 `interface .* { ... cwd: string` 类似的），添加 `adminEvents?: AdminEventBuffer`。在三个关键节点 emit event：

(a) `start()` 里 namespace runtime 创建成功后：

```typescript
this.options.adminEvents?.record("namespace.bootstrap.ready", this.sessionId, {
  cwd: this.options.cwd,
  homeDir: this.options.homeDir,
});
```

(b) `dispatchToolToClient` 收到 client tool_result 后（成功路径）：

```typescript
this.options.adminEvents?.record("tool.relay.completed", this.sessionId, {
  tool: toolCall.name,
  durationMs: Date.now() - startedAt,
  ok: true,
});
```

(c) namespace bootstrap 失败（catch 块内）：

```typescript
this.options.adminEvents?.record("namespace.bootstrap.failed", this.sessionId, {
  error: errorMsg,
});
```

> **执行者注意**：实际改 pty-session.ts 时先 `Read` 文件定位 class 与方法，再用 `Edit` 增量加；不要重写整个文件。

- [ ] **Step 3.6: 跑现有 server 测试验证不破坏**

Run: `cd server && npm run typecheck && npm test 2>&1 | tail -20`
Expected: typecheck 通过；测试无新失败

- [ ] **Step 3.7: Commit**

```bash
git add server/src/admin-events.ts server/test/admin-events.test.ts server/src/server.ts server/src/pty-session.ts
git commit -m "$(cat <<'EOF'
🌱 e2e / Foundation: server 端 admin-events ring buffer + /admin/events endpoint

为 e2e orchestrator 提供结构化事件流，仅在 CERELAY_ADMIN_EVENTS=true
时启用，生产环境零开销：

- AdminEventBuffer: 10k 容量环形 buffer，record/fetch 关闭时 no-op
- /admin/events?sessionId=&since=：增量拉取（since=最大 id 避免重复）
- pty-session 在 namespace.bootstrap.ready / tool.relay.completed /
  namespace.bootstrap.failed 三个关键节点 emit

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4：orchestrator HTTP clients（mock-admin / clients / server-events）

**Files:**
- Create: `test/e2e-comprehensive/orchestrator/package.json`
- Create: `test/e2e-comprehensive/orchestrator/tsconfig.json`
- Create: `test/e2e-comprehensive/orchestrator/mock-admin.ts`
- Create: `test/e2e-comprehensive/orchestrator/clients.ts`
- Create: `test/e2e-comprehensive/orchestrator/server-events.ts`
- Create: `test/e2e-comprehensive/orchestrator/fixtures.ts`

- [ ] **Step 4.1: package.json**

```json
{
  "name": "cerelay-e2e-orchestrator",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --import tsx --test --test-concurrency=1 phase-p0.test.ts"
  },
  "devDependencies": {
    "tsx": "latest",
    "typescript": "latest",
    "@types/node": "latest"
  }
}
```

- [ ] **Step 4.2: tsconfig.json**

同 mock-anthropic（minimal noEmit）。

- [ ] **Step 4.3: mock-admin.ts**

```typescript
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

export function scriptToolUse(opts: { toolName: string; toolUseId: string; input: Record<string, unknown> }): ScriptDef["respond"] {
  return {
    type: "stream",
    events: [
      { kind: "message_start", message: { id: `msg_${opts.toolUseId}`, role: "assistant", model: "claude-mock", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } },
      { kind: "content_block_start", index: 0, content_block: { type: "tool_use", id: opts.toolUseId, name: opts.toolName, input: {} } },
      { kind: "input_json_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(opts.input) } },
      { kind: "content_block_stop", index: 0 },
      { kind: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
      { kind: "message_stop" },
    ],
  };
}

export function scriptText(text: string): ScriptDef["respond"] {
  return {
    type: "stream",
    events: [
      { kind: "message_start", message: { id: "msg_text", role: "assistant", model: "claude-mock", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } },
      { kind: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { kind: "input_json_delta", index: 0, delta: { type: "text_delta", text } },
      { kind: "content_block_stop", index: 0 },
      { kind: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { kind: "message_stop" },
    ],
  };
}
```

- [ ] **Step 4.4: clients.ts**

```typescript
export interface RunRequest {
  prompt: string;
  cwd: string;
  deviceLabel?: string;
  extraArgs?: string[];
  timeoutMs?: number;
}

export interface RunResponse {
  exitCode: number;
  stdout: string;
  stderr: string;
  sessionId: string;
  durationMs: number;
}

const HOSTS: Record<string, string> = {
  "client-a": process.env.CLIENT_A_URL || "http://client-a:9100",
  "client-b": process.env.CLIENT_B_URL || "http://client-b:9100",
};

export const clients = {
  hosts: () => Object.keys(HOSTS),

  async run(label: string, req: RunRequest): Promise<RunResponse> {
    const base = HOSTS[label];
    if (!base) throw new Error(`unknown client label: ${label}`);
    const r = await fetch(`${base}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceLabel: label, ...req }),
    });
    if (!r.ok) throw new Error(`client ${label} /run → ${r.status}: ${await r.text()}`);
    return await r.json() as RunResponse;
  },

  async healthz(label: string): Promise<boolean> {
    const base = HOSTS[label];
    try {
      const r = await fetch(`${base}/healthz`);
      return r.ok;
    } catch {
      return false;
    }
  },
};
```

- [ ] **Step 4.5: server-events.ts**

```typescript
const BASE = process.env.SERVER_ADMIN_URL || "http://server:8765";
const TOKEN = process.env.SERVER_ADMIN_TOKEN || "e2e-admin-token";

export interface AdminEvent {
  id: number;
  ts: string;
  sessionId: string | null;
  kind: string;
  detail?: Record<string, unknown>;
}

export const serverEvents = {
  async fetch(opts: { sessionId?: string; since?: number } = {}): Promise<AdminEvent[]> {
    const u = new URL("/admin/events", BASE);
    if (opts.sessionId) u.searchParams.set("sessionId", opts.sessionId);
    if (opts.since !== undefined) u.searchParams.set("since", String(opts.since));
    const r = await fetch(u, { headers: { authorization: `Bearer ${TOKEN}` } });
    if (!r.ok) throw new Error(`server /admin/events → ${r.status}: ${await r.text()}`);
    const body = await r.json() as { enabled: boolean; events: AdminEvent[] };
    if (!body.enabled) throw new Error("CERELAY_ADMIN_EVENTS=false on server, e2e cannot run");
    return body.events;
  },

  async waitForKind(opts: { sessionId?: string; kind: string; timeoutMs?: number }): Promise<AdminEvent> {
    const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
    let since = 0;
    while (Date.now() < deadline) {
      const events = await this.fetch({ sessionId: opts.sessionId, since });
      const hit = events.find((e) => e.kind === opts.kind);
      if (hit) return hit;
      since = events.at(-1)?.id ?? since;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`waitForKind(${opts.kind}) timeout after ${opts.timeoutMs ?? 30_000}ms`);
  },
};
```

- [ ] **Step 4.6: fixtures.ts**

```typescript
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";

// FIXTURE_ROOT 是一个 docker volume，挂在 orchestrator + 所有 client 容器的同一路径。
// 测试在 orchestrator 写，client 在自己的容器内同路径读。
const FIXTURE_ROOT = process.env.FIXTURE_ROOT || "/workspace/fixtures";

export async function writeFixture(
  caseId: string,
  files: Record<string, string>
): Promise<string> {
  const root = path.join(FIXTURE_ROOT, caseId);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  return root;
}

export function fixturePath(caseId: string, sub = ""): string {
  return path.join(FIXTURE_ROOT, caseId, sub);
}

export async function cleanupFixture(caseId: string): Promise<void> {
  await rm(path.join(FIXTURE_ROOT, caseId), { recursive: true, force: true });
}
```

- [ ] **Step 4.7: 本地 lint check**

Run: `cd test/e2e-comprehensive/orchestrator && npm install && npx tsc --noEmit *.ts`
Expected: 无错误

- [ ] **Step 4.8: Commit**

```bash
git add test/e2e-comprehensive/orchestrator/
git commit -m "$(cat <<'EOF'
🌱 e2e / Foundation: orchestrator HTTP clients + fixture writer

实现 docs/e2e-comprehensive-testing.md §4.1 列出的 4 个薄 client：
- mock-admin.ts: 调 mock-anthropic /admin/* + reset/loadScript/captured 高阶 API
  + scriptToolUse / scriptText builders
- clients.ts: 调 client-A/B 的 thin agent /run + 容器内 host 名解析
- server-events.ts: 调 server /admin/events + waitForKind polling helper
- fixtures.ts: 写入 /workspace/fixtures/<caseId>（orchestrator + client 共享 volume）

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5：Dockerfiles（orchestrator / client-agent / mock-anthropic）

**Files:**
- Create: `Dockerfile.e2e-mock-anthropic`
- Create: `Dockerfile.e2e-client-agent`
- Create: `Dockerfile.e2e-orchestrator`

- [ ] **Step 5.1: Dockerfile.e2e-mock-anthropic**

```dockerfile
# ============================================================
# Cerelay E2E — mock-anthropic 容器
# ============================================================
FROM node:22-slim
WORKDIR /app

COPY test/e2e-comprehensive/mock-anthropic/package.json ./
RUN npm install --omit=optional

COPY test/e2e-comprehensive/mock-anthropic/ ./

ENV PORT=8080
EXPOSE 8080

CMD ["npx", "tsx", "index.ts"]
```

- [ ] **Step 5.2: Dockerfile.e2e-client-agent**

```dockerfile
# ============================================================
# Cerelay E2E — client agent 容器
# 包含真 cerelay-client 编译产物 + thin HTTP agent
# ============================================================
FROM node:22-slim
WORKDIR /app

# 安装 client workspace 的 deps（编译期需要）+ tsx（agent 运行）
COPY package.json package-lock.json ./
COPY client/package.json ./client/
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci --workspaces --include-workspace-root

# 复制 client 源码并构建
COPY client/ ./client/
COPY server/src/protocol.ts ./server/src/protocol.ts
RUN npm run build --workspace=cerelay-client

# 复制 agent 源码
COPY test/e2e-comprehensive/agent/ /agent/
WORKDIR /agent
RUN npm install

# 每个容器启动时生成独立 device-id
RUN mkdir -p /home/clientuser/.config/cerelay
ENV HOME=/home/clientuser
ENV XDG_CONFIG_HOME=/home/clientuser/.config
ENV CLIENT_BIN=/app/client/dist/index.js
ENV PORT=9100

EXPOSE 9100

# entrypoint 生成 device-id（如不存在）后启动 agent
CMD sh -c '\
  if [ ! -f "$XDG_CONFIG_HOME/cerelay/device-id" ]; then \
    cat /proc/sys/kernel/random/uuid > "$XDG_CONFIG_HOME/cerelay/device-id"; \
  fi; \
  exec npx tsx /agent/index.ts \
'
```

- [ ] **Step 5.3: Dockerfile.e2e-orchestrator**

```dockerfile
# ============================================================
# Cerelay E2E — orchestrator 容器
# ============================================================
FROM node:22-slim
WORKDIR /workspace

COPY test/e2e-comprehensive/orchestrator/package.json ./
RUN npm install

COPY test/e2e-comprehensive/orchestrator/ ./

# 默认入口：跑 P0 阶段所有 case
CMD ["npm", "test"]
```

- [ ] **Step 5.4: 本地 build 三个镜像验证 syntax**

Run: `docker build -f Dockerfile.e2e-mock-anthropic -t cerelay-e2e-mock . && docker build -f Dockerfile.e2e-client-agent -t cerelay-e2e-client-agent . && docker build -f Dockerfile.e2e-orchestrator -t cerelay-e2e-orchestrator .`
Expected: 三个都 build 成功

- [ ] **Step 5.5: Commit**

```bash
git add Dockerfile.e2e-mock-anthropic Dockerfile.e2e-client-agent Dockerfile.e2e-orchestrator
git commit -m "$(cat <<'EOF'
🌱 e2e / Foundation: 三个 e2e Dockerfile（mock-anthropic / client-agent / orchestrator）

- Dockerfile.e2e-mock-anthropic: 极简 node:22-slim + tsx 跑 mock 服务
- Dockerfile.e2e-client-agent: 编译 cerelay-client + 装 agent + entrypoint
  生成独立 device-id；每个 container = 独立 deviceId
- Dockerfile.e2e-orchestrator: 装 orchestrator workspace + 默认 npm test 入口

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6：docker-compose.e2e.yml + 共享 volume + healthcheck

**Files:**
- Create: `docker-compose.e2e.yml`

- [ ] **Step 6.1: docker-compose.e2e.yml**

```yaml
# ============================================================
# Cerelay — E2E 综合测试编排
# 拓扑：orchestrator + mock-anthropic + server + client-A + client-B
# 详见 docs/e2e-comprehensive-testing.md §3
# ============================================================

services:
  mock-anthropic:
    build:
      context: .
      dockerfile: Dockerfile.e2e-mock-anthropic
    networks:
      - cerelay-e2e-net
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://localhost:8080/admin/captured', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"]
      interval: 2s
      timeout: 1s
      retries: 15

  server:
    build:
      context: .
      dockerfile: Dockerfile
    cap_add: [SYS_ADMIN]
    devices: ["/dev/fuse:/dev/fuse"]
    security_opt: ["seccomp:unconfined", "apparmor:unconfined"]
    environment:
      - ANTHROPIC_BASE_URL=http://mock-anthropic:8080
      - ANTHROPIC_API_KEY=e2e-fake-key
      - PORT=8765
      - CERELAY_ENABLE_MOUNT_NAMESPACE=true
      - CERELAY_ADMIN_EVENTS=true
      - CERELAY_ADMIN_TOKEN=e2e-admin-token
      - CERELAY_DATA_DIR=/var/lib/cerelay
      - LOG_LEVEL=debug
    tmpfs:
      - /var/lib/cerelay:exec,size=512M
      - /opt/cerelay-runtime:exec,size=512M
    depends_on:
      mock-anthropic:
        condition: service_healthy
    networks:
      - cerelay-e2e-net
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get({host:'localhost',port:8765,path:'/admin/sessions',headers:{authorization:'Bearer e2e-admin-token'}}, (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"]
      interval: 2s
      timeout: 1s
      retries: 30

  client-a:
    build:
      context: .
      dockerfile: Dockerfile.e2e-client-agent
    environment:
      - SERVER_URL=ws://server:8765/ws
    volumes:
      - e2e-fixtures:/workspace/fixtures
    depends_on:
      server:
        condition: service_healthy
    networks:
      - cerelay-e2e-net
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://localhost:9100/healthz', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"]
      interval: 2s
      timeout: 1s
      retries: 15

  client-b:
    build:
      context: .
      dockerfile: Dockerfile.e2e-client-agent
    environment:
      - SERVER_URL=ws://server:8765/ws
    volumes:
      - e2e-fixtures:/workspace/fixtures
    depends_on:
      server:
        condition: service_healthy
    networks:
      - cerelay-e2e-net
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://localhost:9100/healthz', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"]
      interval: 2s
      timeout: 1s
      retries: 15

  orchestrator:
    build:
      context: .
      dockerfile: Dockerfile.e2e-orchestrator
    environment:
      - MOCK_ANTHROPIC_URL=http://mock-anthropic:8080
      - SERVER_ADMIN_URL=http://server:8765
      - SERVER_ADMIN_TOKEN=e2e-admin-token
      - CLIENT_A_URL=http://client-a:9100
      - CLIENT_B_URL=http://client-b:9100
      - FIXTURE_ROOT=/workspace/fixtures
    volumes:
      - e2e-fixtures:/workspace/fixtures
    depends_on:
      mock-anthropic:
        condition: service_healthy
      server:
        condition: service_healthy
      client-a:
        condition: service_healthy
      client-b:
        condition: service_healthy
    networks:
      - cerelay-e2e-net

volumes:
  e2e-fixtures:

networks:
  cerelay-e2e-net:
    driver: bridge
```

- [ ] **Step 6.2: 验证 compose syntax**

Run: `docker compose -f docker-compose.e2e.yml config > /dev/null`
Expected: 无错误，无输出

- [ ] **Step 6.3: 拉起全栈但**不**跑 orchestrator，验证 healthcheck 全过**

Run:
```bash
docker compose -f docker-compose.e2e.yml up -d --build mock-anthropic server client-a client-b
# --wait 内置等所有 healthcheck 转 healthy 才退出，超时返回非零
docker compose -f docker-compose.e2e.yml ps
```
Expected: 4 个服务 STATUS 列全部 `Up ... (healthy)`；任一失败用 `docker compose ... logs <service>` 排查

- [ ] **Step 6.4: 清理**

Run: `docker compose -f docker-compose.e2e.yml down --volumes`

- [ ] **Step 6.5: Commit**

```bash
git add docker-compose.e2e.yml
git commit -m "$(cat <<'EOF'
🌱 e2e / Foundation: docker-compose.e2e.yml 多容器拓扑 + healthcheck

服务编排：
- mock-anthropic: 极简 mock，腾给 server 当 ANTHROPIC_BASE_URL
- server: 真 cerelay-server，CERELAY_ADMIN_EVENTS=true，挂 SYS_ADMIN+FUSE
  CERELAY_DATA_DIR / runtime 都用 tmpfs 不持久化
- client-A / client-B: 两个独立 client agent 容器（多 device 拓扑）
- orchestrator: 测试主体，等四个依赖 healthy 才启动

共享 e2e-fixtures volume：orchestrator 写 fixtures，client 读取自身 cwd。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7：run-e2e-comprehensive.sh + npm test 集成

**Files:**
- Create: `test/run-e2e-comprehensive.sh`
- Modify: `test/run-host-tests.sh`
- Modify: `package.json`

- [ ] **Step 7.1: 写 run-e2e-comprehensive.sh**

```bash
#!/bin/sh
# ============================================================
# Cerelay E2E 综合测试入口
# 详见 docs/e2e-comprehensive-testing.md §3.5
# ============================================================
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)

cd "$repo_root"

compose_file="docker-compose.e2e.yml"
project="cerelay-e2e-$(date +%s)"

echo "[e2e] project=$project"

cleanup_on_success() {
  echo "[e2e] success: tearing down"
  docker compose -p "$project" -f "$compose_file" down --volumes --remove-orphans >/dev/null 2>&1 || true
}

leave_on_failure() {
  echo "[e2e] FAILURE: containers left for inspection (project=$project)"
  echo "[e2e]   docker compose -p $project -f $compose_file ps"
  echo "[e2e]   docker compose -p $project -f $compose_file logs server"
  echo "[e2e]   清理：docker compose -p $project -f $compose_file down --volumes"
}

# 启动支撑容器（带 healthcheck，等就绪）
echo "[e2e] starting supporting services..."
docker compose -p "$project" -f "$compose_file" up -d --build --wait \
  mock-anthropic server client-a client-b

# 跑 orchestrator
echo "[e2e] running orchestrator..."
if docker compose -p "$project" -f "$compose_file" run --rm --build orchestrator; then
  cleanup_on_success
  exit 0
else
  leave_on_failure
  exit 1
fi
```

- [ ] **Step 7.2: 加可执行位 + 改 run-host-tests.sh**

Run: `chmod +x test/run-e2e-comprehensive.sh`

修改 `test/run-host-tests.sh`，在文件末尾追加：

```sh
echo "[host-tests] e2e comprehensive (in containers)"
sh "$script_dir/run-e2e-comprehensive.sh"
```

- [ ] **Step 7.3: 加 npm scripts**

修改 `package.json`，在 `scripts` 内新增：

```json
"test:e2e": "sh ./test/run-e2e-comprehensive.sh"
```

- [ ] **Step 7.4: 验证 shell 语法**

Run: `sh -n test/run-e2e-comprehensive.sh`
Expected: 无错误

- [ ] **Step 7.5: Commit**

```bash
git add test/run-e2e-comprehensive.sh test/run-host-tests.sh package.json
git commit -m "$(cat <<'EOF'
🌱 e2e / Foundation: run-e2e-comprehensive.sh + npm test 接入

- test/run-e2e-comprehensive.sh: docker compose up --wait 全部依赖
  健康后跑 orchestrator；失败时不 down，留容器供 docker logs 排查；
  成功才 down --volumes
- test/run-host-tests.sh: 末尾追加 e2e 调用（host smoke/workspaces 全绿后才进）
- package.json: 加 npm run test:e2e 单独入口

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Stage B：Canary Cases（Task 8）

### Task 8：phase-p0.test.ts canary case + 端到端跑通

**Files:**
- Create: `test/e2e-comprehensive/orchestrator/phase-p0.test.ts`

> **本 task 故意只放 2 个 case**：A1-bash-basic（验证 happy path）+ B4-ancestor-claudemd（守 IFS bug regression）。其余 14 个 case + 3 个 meta-test 在 Plan P0-B 实现。

- [ ] **Step 8.1: 编写 phase-p0.test.ts（仅 2 个 case）**

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { mockAdmin, scriptToolUse, scriptText } from "./mock-admin.js";
import { clients } from "./clients.js";
import { serverEvents } from "./server-events.js";
import { writeFixture, fixturePath, cleanupFixture } from "./fixtures.js";

// 容器内 fixture 路径转 client cwd 视角
function clientCwd(caseId: string): string {
  return `/workspace/fixtures/${caseId}`;
}

test.beforeEach(async () => {
  await mockAdmin.reset();
});

// ============================================================
// A1-bash-basic
// ============================================================
test("A1-bash-basic: model 触发 Bash → server 中转 client 执行 → tool_result 回写", async () => {
  const caseId = "case-a1";
  await writeFixture(caseId, {
    "marker.txt": "hello-from-a1",
    "src/main.ts": "console.log('main')",
  });

  // 第一轮：模型返回 Bash tool_use
  await mockAdmin.loadScript({
    name: "p0-a1-turn1",
    match: { turnIndex: 1 },
    respond: scriptToolUse({
      toolName: "Bash",
      toolUseId: "toolu_a1_01",
      input: { command: "ls -la" },
    }),
  });
  // 第二轮：模型拿到 tool_result 后输出 final text
  await mockAdmin.loadScript({
    name: "p0-a1-turn2",
    match: { turnIndex: 2 },
    respond: scriptText("listing complete"),
  });

  const result = await clients.run("client-a", {
    prompt: "list files in current dir [A1-MARKER]",
    cwd: clientCwd(caseId),
  });

  assert.equal(result.exitCode, 0, `client exit ${result.exitCode}\nstderr: ${result.stderr}`);

  // 断言 mock 收到了两轮请求
  const cap = await mockAdmin.captured();
  assert.equal(cap.length, 2, `expected 2 messages, got ${cap.length}`);

  // 断言第二轮的 tool_result 含 marker 文件名
  const toolResult = cap[1].toolResults[0];
  assert.ok(toolResult, "expected tool_result in turn 2");
  assert.match(toolResult.content, /marker\.txt/, "tool_result.content should mention marker.txt");
  assert.equal(toolResult.is_error, false, "Bash via shadow MCP should not be error");

  await cleanupFixture(caseId);
});

// ============================================================
// B4-ancestor-claudemd（同时守 D3 IFS bug regression）
// ============================================================
test("B4-ancestor-claudemd: ancestor 段 bootstrap 不在 set -u 下崩 + ancestor CLAUDE.md 可读", async () => {
  const caseId = "case-b4";
  // 关键：cwd 与 home 之间至少有 1 层祖先目录，否则 CERELAY_ANCESTOR_DIRS 为空
  // 在 client 容器里 HOME=/home/clientuser，cwd 走 /workspace/fixtures/case-b4/sub/proj
  // 祖先 = /workspace/fixtures/case-b4/sub, /workspace/fixtures/case-b4, /workspace/fixtures, /workspace
  await writeFixture(caseId, {
    "CLAUDE.md": "# Ancestor at case-b4 root\nThis is the closest ancestor CLAUDE.md.",
    "sub/proj/CLAUDE.md": "# Project-level\nThis is the cwd CLAUDE.md.",
    "sub/proj/marker.txt": "hello-from-b4",
  });

  const cwd = `${clientCwd(caseId)}/sub/proj`;

  await mockAdmin.loadScript({
    name: "p0-b4-turn1",
    match: { turnIndex: 1 },
    respond: scriptToolUse({
      toolName: "Bash",
      toolUseId: "toolu_b4_01",
      input: { command: "cat ../../CLAUDE.md" },
    }),
  });
  await mockAdmin.loadScript({
    name: "p0-b4-turn2",
    match: { turnIndex: 2 },
    respond: scriptText("ok"),
  });

  const result = await clients.run("client-a", {
    prompt: "read ancestor CLAUDE.md [B4-MARKER]",
    cwd,
  });

  // 关键断言：client 不能 0 + stderr 含 "IFS: parameter not set" 这种 bootstrap 失败信号
  assert.equal(result.exitCode, 0, `client failed; stderr: ${result.stderr}`);
  assert.doesNotMatch(result.stderr, /IFS: parameter not set/, "regression: bootstrap.sh IFS bug surfaced again");
  assert.doesNotMatch(result.stderr, /初始化 Claude mount namespace 失败/, "namespace 初始化失败 = 框架捞到 regression");

  // server 端事件：必须有 namespace.bootstrap.ready，且没有 namespace.bootstrap.failed
  const events = await serverEvents.fetch({});
  const ready = events.find((e) => e.kind === "namespace.bootstrap.ready");
  const failed = events.find((e) => e.kind === "namespace.bootstrap.failed");
  assert.ok(ready, "expected namespace.bootstrap.ready event");
  assert.equal(failed, undefined, `unexpected bootstrap.failed: ${JSON.stringify(failed?.detail)}`);

  // 断言第二轮 tool_result 含 ancestor CLAUDE.md 内容
  const cap = await mockAdmin.captured();
  const toolResult = cap.at(-1)?.toolResults[0];
  assert.ok(toolResult, "expected tool_result");
  assert.match(toolResult.content, /Ancestor at case-b4 root/, "ancestor CLAUDE.md content should be readable");

  await cleanupFixture(caseId);
});
```

- [ ] **Step 8.2: 完整端到端跑通**

Run: `npm run test:e2e`

Expected:
- docker compose 起所有 service 并 healthy
- orchestrator 跑 2 个 case 都 pass
- 成功后 docker compose down --volumes 干净退出
- 总耗时 ≤ 10 分钟（首次 build 慢，后续 ≤ 3 分钟）

- [ ] **Step 8.3: 故意 revert IFS 修复，验证 B4 case 能拦住**

Run:
```bash
git stash  # 暂存当前未提交改动（如果有）
git revert --no-commit 34b870a  # 临时 revert IFS 修复 commit
npm run test:e2e || echo "[expected] B4 should fail"
git revert --abort                # 撤销 revert
git stash pop 2>/dev/null || true
```

Expected: B4 case 失败，错误信息包含 "IFS: parameter not set" 或 "namespace.bootstrap.failed"。这证明本套件能拦住该类 regression。

- [ ] **Step 8.4: Commit**

```bash
git add test/e2e-comprehensive/orchestrator/phase-p0.test.ts
git commit -m "$(cat <<'EOF'
🌱 e2e / Foundation: phase-p0 canary case（A1-bash-basic + B4-ancestor-claudemd）

实施 docs/e2e-comprehensive-testing.md §2.1 的两个核心 case，证明 e2e
框架闭环：
- A1-bash-basic: 验证 happy path（model → tool_use → client exec → tool_result）
- B4-ancestor-claudemd: 同时守 D3 IFS bug regression 与 ancestor CLAUDE.md
  可读不变量；这是整个 e2e 计划的 raison d'être

剩余 14 个 P0 case + 3 个 meta-test 在 Plan P0-B 实现，本 PR 仅交付
能 npm run test:e2e 一把跑通的最小框架。

e2e coverage: 本身就是 e2e 框架；新增 case 已登记在 §2.1 P0 表格

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## 验证 / Verification

完成 Tasks 1-8 后必须满足：

1. **`npm run test:e2e` 一把跑通**：从零开始（`docker compose down -v` 后），3-10 分钟内 2/2 case 全绿；docker compose 自动清理
2. **`npm test` 顶层入口包含 e2e**：host smoke + workspaces + e2e 串联跑
3. **故意 revert IFS 修复 → B4 case 失败**：证明框架能拦住 regression
4. **server 单元测试无新失败**：admin-events 改动不破坏现有测试
5. **失败容器残留**：手动 throw error 在 orchestrator 内，确认 compose 容器留下且日志可拉

---

## 自审清单 / Self-Review Checklist（写完后跑一遍）

- [ ] 所有 task 都有 commit 步骤
- [ ] 每个 step 要么有完整代码块要么有具体命令
- [ ] 没有 TODO / TBD / "实现细节后补" 文字
- [ ] 类型定义跨 task 一致（mock-admin 的 ScriptDef vs mock-anthropic 内部 ScriptDef 必须匹配）
- [ ] 容器名 + port + env var 跨文件一致：
  - mock-anthropic:8080 / server:8765 / client-a:9100 / client-b:9100
  - SERVER_URL=ws://server:8765/ws
  - CERELAY_ADMIN_EVENTS=true / CERELAY_ADMIN_TOKEN=e2e-admin-token
- [ ] Step 8.3 的 commit hash `34b870a` 是真实的（IFS fix commit）
- [ ] 关联 spec doc 路径 `docs/e2e-comprehensive-testing.md` 真实存在
