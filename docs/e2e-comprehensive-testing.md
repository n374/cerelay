## 端到端综合测试 / Comprehensive End-to-End Testing

> 本文档定义 cerelay 的"全链路 e2e 综合测试"——一组**默认在容器内自动跑**的多容器集成测试，覆盖 server、client、mock anthropic 之间从 WebSocket 协议、tool relay、文件代理、cache 同步、namespace 隔离到多 device 多 client 的全部主路径，目标是让每次 `npm test` 就能把"用户手动跑一圈才发现的问题"在 commit 前就拦住。
>
> This document defines cerelay's "comprehensive E2E suite" — a multi-container integration test that runs **by default in containers on every `npm test`**. It covers the full chain across server, client, and the mock Anthropic API: WebSocket protocol, tool relay, file proxy, cache sync, namespace isolation, and multi-device / multi-client topologies. The goal is to catch in CI what would otherwise only surface during manual end-user runs.

---

### 1. 概述 / Overview

#### 1.1 目标 / Goals

| 目标 | 说明 |
|---|---|
| **拦住"手动跑才发现"的 regression** | 例：bootstrap.sh 在 `set -u` 下访问 unset 的 `$IFS` 直接挂 PTY，仅当 `CERELAY_ANCESTOR_DIRS` 非空才触发——单测无法覆盖，必须真启动 server + 真发起 PTY session 才暴露 |
| **把"协议链路"变成 first-class 测试对象** | 现有 e2e 多是"server-only + 测试内手搓 hook bridge"，没有任何一个测试是"真 server 进程 + 真 client 进程 + 走完整 ws"。本套件填补此缺口 |
| **多 device / 多 client 拓扑** | F3 场景（多 deviceId 同连）只有跨容器才能 honest 测试（独立 host fs / 独立网络栈 / 独立 device-id 文件） |
| **强制覆盖审计** | 任何功能开发 / 更新完成后必须同步评估本套件覆盖矩阵能否扩展。审计约束写在 [`../CLAUDE.md`](../CLAUDE.md) |

#### 1.2 与现有 e2e 测试的边界 / Boundary vs Existing E2E

| 现有测试 | 范围 | 与本套件关系 |
|---|---|---|
| `server/test/e2e-real-claude-bash.test.ts` | 真实 claude CLI + mock anthropic + 测试内手搓 hook bridge | **保留**，守护 hook 协议不变量。本套件不重复，但在断言层借用 mock anthropic 的剧本格式 |
| `server/test/e2e-mcp-shadow-bash.test.ts` | 真实 claude CLI + cerelay-routed MCP 子进程 | **保留**，守护 Plan D `is_error: false` 不变量 |
| `server/test/e2e-pty.test.ts`、`e2e-cross-cwd-and-mutations.test.ts`、`e2e-file-agent.test.ts`、`e2e-daemon-no-perforation.test.ts`、`e2e-runtime-negative-persisted.test.ts` | server-only，import 内部模块 + 注入 fixture | **保留**，作为单模块深测；本套件做"模块装配后整体跑"的互补 |
| **本套件** | 多容器：真 server + N 真 client + mock anthropic + orchestrator | 新增 |

#### 1.3 触发与失败现象 / Triggering and Failure Surface

- 入口：`npm test` 默认包含本套件（host smoke / workspaces 跑完后启动 docker-compose）
- 单跑：`npm run test:e2e`
- 失败时容器**不自动 down**，保留 `mock-anthropic` / `server` / `client-A/B/C` 容器供 `docker logs <name>` 排查；下一次 `npm test` 或 `npm run test:gc` 会清理

---

### 2. 覆盖矩阵 / Coverage Matrix

按 P0 → P1 → P2 三阶段推进；下方表格中的"案例 ID"对应实现里的测试名。

#### 2.1 P0：必须覆盖（首版交付） / P0: Must-Cover (First Release)

| 维度 | 案例 ID | 描述 | 守护的不变量 / Regression |
|---|---|---|---|
| **A. 工具链路** | A1-bash-basic | 单 client 触发 `Bash ls`，server→ws→client 执行→回写 | tool relay 双向链路、stdout 完整回传 |
|  | A2-fs-rwe | `Read` / `Write` / `Edit` 三件套对临时 cwd 内文件 | fs 工具协议、Edit `old_string` 唯一性约束 |
|  | A3-search | `Glob '**/*.md'` + `Grep 'TODO'` 在 fixture 项目内 | search 工具的 path normalize、glob 语义 |
|  | A4-shadow-mcp | 模型调 `mcp__cerelay__bash` 路径 | tool_result.is_error === false（Plan D 不变量） |
| **B. 文件代理** | B1-home-claude-snapshot | server 启动期 `~/.claude/` snapshot 走 cache，命中已上传的 fixture | snapshot ledger 命中、不二次穿透 |
|  | B2-claude-json-read | server 读 `~/.claude.json` 走 FUSE | 文件级 bind mount 正确性 |
|  | B3-project-claude | server 读 `{cwd}/.claude/settings.local.json` | project-claude bind mount + hook injection 注入路径 |
|  | B4-ancestor-claudemd | 在 cwd 与 home 之间放置 `CLAUDE.md`，server 通过 cwd-ancestor-N FUSE root 读到 | **直接守护 IFS bug 类 regression**（bootstrap ancestor 段必须能跑通） |
| **C. Cache 同步** | C1-initial-pipeline | client 首次连，1k+ 文件 initial sync，pipeline 流控生效 | manifest 写入串行锁、batch ack 不丢、最终 revision 正确 |
|  | C2-revision-ack | initial sync 完成后 server 报告 final revision == client 已 push 的最大 revision | revision 单调、ack 配对 |
| **D. Mount namespace** | D1-cwd-aligned | session 内 `pwd` 输出 == client 上报的 cwd | cwd 字符串对齐 |
|  | D2-home-aligned | session 内 `echo $HOME` == client 上报的 home | HOME 重定向 |
|  | D3-ancestor-no-crash | B4 case 同时验 bootstrap 不在 `set -u` 下退出 | **IFS bug 死亡回归** |
| **E. Redaction** | E1-settings-redact | client 上报的 `~/.claude/settings.json` 含 `env.ANTHROPIC_API_KEY`；session 内 `cat ~/.claude/settings.json` 看到的 redacted 版本 | 三处出口（snapshot / cache hit / passthrough）全部 redact |
| **F. 多拓扑** | F1-single-client-concurrent | 同一 client 一次连接，session 内并发 5 次 Bash | tool relay race、ack 序号正确 |
|  | F3-multi-device | 起 client-A / client-B 两容器，并发触发各自的 session；server 端 cache 按 deviceId 隔离 | per-device store 隔离、互不污染 |

#### 2.2 P1：尽量覆盖（第二阶段） / P1: Should-Cover (Phase 2)

| 维度 | 案例 ID | 描述 |
|---|---|---|
| A | A5-fallback-guidance | shadow MCP 启用但模型调 `Bash` builtin → hook deny + 引导文案 |
| B | B5-negative-cache | 第一次 read 不存在文件 miss；第二次同路径不再穿透 |
|  | B6-settings-local-shadow | 项目 `.claude/settings.local.json` 通过 shadow file 注入并被 hook 读到 |
| C | C3-runtime-delta | session 进行中改 `~/.claude/CLAUDE.md`，server 端能读到新内容（watcher delta + ttl 续期） |
| D | D4-credentials-shadow | server 侧 `credentials/default/.credentials.json` 通过 shadow file 暴露给 namespace |
| E | E2-credentials-rw | namespace 内对 `~/.claude/.credentials.json` 写入 → 落到 server 侧持久化文件 |
| F | F2-multi-session | 同一 client 一次连接 → 起两个 PTY session 并发 |
|  | F4-same-device-multi-cwd | 同 client 连两次（不同 cwd）；device-only manifest 共享 |
| G | G1-tool-timeout | tool 执行 timeout → server 返回 error，session 不挂 |
|  | G2-client-disconnect | session 中途 client 断 ws → server cleanup namespace + FUSE，无 EBUSY 残留 |

#### 2.3 P2：可后续补 / P2: Nice-to-Have (Phase 3)

| 维度 | 案例 ID | 描述 |
|---|---|---|
| C | C4-large-skipped | 上传 > 1MB 文件被 `skipped`、scope > 100MB `truncated` |
| G | G3-mock-5xx | mock anthropic 返回 5xx，session 优雅终止、日志含上游错误 |

---

### 3. 架构 / Architecture

#### 3.1 容器拓扑 / Container Topology

```
┌─────────────────────────────────────────────────────────────┐
│ docker network: cerelay-e2e-net                              │
│                                                              │
│  ┌──────────────┐                                           │
│  │ orchestrator │  node:test runner（容器内执行测试 + 断言）  │
│  │ test-runner  │  不挂 docker.sock，纯走 HTTP                │
│  └──────┬───────┘                                           │
│         │                                                    │
│         ├──► mock-anthropic:8080                            │
│         │     POST /v1/messages          ← Anthropic API     │
│         │     POST /admin/scripts        ← 注入剧本          │
│         │     GET  /admin/captured       ← 查请求            │
│         │     POST /admin/reset          ← 测试间隔离        │
│         │                                                    │
│         ├──► server:8765/ws              ← cerelay-server    │
│         │     ANTHROPIC_BASE_URL=http://mock-anthropic:8080  │
│         │     CERELAY_ENABLE_MOUNT_NAMESPACE=true            │
│         │     cap_add: SYS_ADMIN ; devices: /dev/fuse        │
│         │     POST /admin/sessions       ← 查 session 状态   │
│         │     GET  /admin/events?id=...  ← 查结构化事件流    │
│         │                                                    │
│         ├──► client-A:9100               ← thin agent        │
│         │     POST /run {prompt, cwd, deviceLabel}           │
│         │     → spawn `node /app/client/dist/index.js …`     │
│         │     独立 ~/.config/cerelay/device-id (deviceA)      │
│         │     独立 fixture cwd + ~/.claude                   │
│         │                                                    │
│         ├──► client-B:9100               ← 同上 (deviceB)     │
│         └──► client-C:9100               ← 同上 (deviceC)     │
└─────────────────────────────────────────────────────────────┘
```

#### 3.2 mock-anthropic 剧本协议 / Script Protocol

每个 case 测前由 orchestrator POST `/admin/scripts`，剧本格式：

```jsonc
{
  "name": "p0-a1-bash-basic",
  "match": {
    // 三种匹配方式，至少提供一种；多种同时给则需全部命中
    // (a) 按 reset 后的全局请求序号匹配（最常用，case 串行时清晰）
    "turnIndex": 1,
    // (b) 按请求 body 谓词匹配（多 client 并发时区分来源）
    //     谓词在 admin 端用预定义 DSL 描述，避免传 JS 函数：
    //     { path: "messages[0].content", op: "contains", value: "client-A-marker" }
    "predicate": { "path": "messages[0].content", "op": "contains", "value": "<marker>" },
    // (c) 按 cerelay 注入的请求头匹配（需 server 透传，见下文）
    "headerEquals": { "x-cerelay-device-id": "<deviceA-uuid>" }
  },
  "respond": {
    "type": "stream",
    "events": [
      { "type": "message_start", "message": { "id": "msg_x", "type": "message", "role": "assistant", "model": "claude-sonnet-4-20250514", "content": [], "stop_reason": null, "stop_sequence": null, "usage": { "input_tokens": 1, "output_tokens": 1 } } },
      { "type": "content_block_start", "index": 0, "content_block": { "type": "tool_use", "id": "toolu_01", "name": "Bash", "input": {} } },
      { "type": "content_block_delta", "index": 0, "delta": { "type": "input_json_delta", "partial_json": "{\"command\":\"ls\"}" } },
      { "type": "content_block_stop", "index": 0 },
      { "type": "message_delta", "delta": { "stop_reason": "tool_use", "stop_sequence": null }, "usage": { "output_tokens": 1 } },
      { "type": "message_stop" }
    ]
  }
}
```

**匹配策略**：
- 单 client 串行 case（绝大多数 P0/P1）：用 `turnIndex` 即可
- 多 client 并发 case（F3）：用 `predicate` 匹配 prompt 中的 marker（orchestrator 给每个 client 生成唯一 marker 拼到 prompt 里）
- `headerEquals` 是 fallback，要求 cerelay-server 把 deviceId 等字段透传到 upstream Anthropic 请求头——P0 阶段**不依赖**这条，避免引入新 server 改动；如未来确实需要再启用
- **SSE event shape**：剧本 `events[*]` 的形状直接 ≡ Anthropic SSE 协议 data payload。
  - `events[*].type` 同时是 SSE `event:` 头与 data payload 的顶层 `type` 字段，必须用 Anthropic 规范名（`message_start` / `content_block_start` / `content_block_delta` / `content_block_stop` / `message_delta` / `message_stop`）
  - `message_start.message` 内还要嵌套 `type: "message"`
  - `content_block_delta.delta.type` 在 data payload 内才区分 `text_delta` / `input_json_delta`，**不是** SSE event 头本身的值
  - 缺任何一项 CC 会以 "API returned an empty or malformed response" 退出

`/admin/captured` 返回所有进入过 `/v1/messages` 的请求（含 headers / body / reset 后第几次），orchestrator 据此断言。

#### 3.3 client agent 协议 / Client Agent Protocol

每个 client 容器跑一个 `~50 行` 的 thin agent（路径：`test/e2e-comprehensive/agent/index.ts`），监听 `:9100`：

```
POST /run
{
  "prompt": "ls the current dir",
  "cwd": "/workspace/fixtures/case-a1",   // 容器内绝对路径
  "deviceLabel": "client-A",                // 仅日志用
  "extraArgs": ["--max-turns", "3"]         // 透传给 client CLI
}
→ 200 { "exitCode": 0, "stdout": "...", "stderr": "...", "sessionId": "..." }
→ 500 { "error": "..." }
```

agent 内部就是 `child_process.spawn("node", ["/app/client/dist/index.js", "--server", "ws://server:8765", "--cwd", req.cwd, ...req.extraArgs])`，把 stdout/stderr 收齐后回写。

#### 3.4 测试数据 / Test Fixtures

所有 fixture 由 orchestrator **测试内程序化生成**到 client 容器的 `/workspace/fixtures/` 下（每个 case 一个独立子目录，避免污染）：

| Fixture | 内容 | 用于 |
|---|---|---|
| `case-a1/` | `README.md`、`src/main.ts`、`src/util.ts`、`.gitignore` | A1 / A3 search |
| `case-b4/` | 多层目录，每层放 `CLAUDE.md` | B4 / D3 ancestor |
| `case-e1/` | 客户 home 内 `.claude/settings.json` 含 `env.ANTHROPIC_API_KEY=fake-secret` | E1 redaction |
| `case-f3-A/`、`case-f3-B/` | 两个独立 fixture，各自 cwd + home | F3 multi-device 隔离 |

生成由 `test/e2e-comprehensive/fixtures.ts` 统一管理，**禁止把 fixture 文件 check 进 git**——每次 orchestrator 启动时按 case 表生成。

#### 3.5 npm test 入口集成 / Test Entry Integration

```
npm test
  └─> test/run-host-tests.sh
        ├─> npm run test:smoke       (host) ────┐
        ├─> npm run test:workspaces  (host) ────┤  任一失败 → fail-fast，不跑 e2e
        └─> test/run-e2e-comprehensive.sh   ◄───┘  仅前置全绿才进入
              ├─> docker compose -f docker-compose.e2e.yml build
              ├─> docker compose -f docker-compose.e2e.yml up -d
              │     (mock-anthropic + server + client-A/B/C 全部就绪)
              └─> docker compose -f docker-compose.e2e.yml run --rm orchestrator
                    └─> 容器内 `node --test test/e2e-comprehensive/orchestrator/phase-p0.test.ts`
```

**失败行为**：
- host smoke / workspaces 任一失败：直接退出，**不进入 e2e**（节省时间，先修廉价问题）
- e2e 失败：`run-e2e-comprehensive.sh` **不调 `compose down`**，容器残留供排查；`test/gc-test-resources.sh` 兜底回收

**仅跑 e2e**：`npm run test:e2e`（跳过前置 host 套件，直接进入 docker-compose）

---

### 4. 实现细节 / Implementation Details

#### 4.1 关键文件位置 / Key File Locations

| 路径 | 职责 |
|---|---|
| `docker-compose.e2e.yml` | 多容器拓扑（server / mock-anthropic / client-A/B/C / orchestrator） |
| `Dockerfile.e2e-orchestrator` | orchestrator 镜像（node + 测试代码 + 必要 fixtures） |
| `Dockerfile.e2e-client-agent` | client 容器镜像（基础 cerelay-client + agent 包装） |
| `test/run-e2e-comprehensive.sh` | 入口 shell，被 `run-host-tests.sh` 调起 |
| `test/e2e-comprehensive/orchestrator/index.ts` | orchestrator 主入口 + 测试装配 |
| `test/e2e-comprehensive/orchestrator/clients.ts` | 调 client agent 的薄 client（HTTP） |
| `test/e2e-comprehensive/orchestrator/mock-admin.ts` | 调 mock-anthropic admin 的薄 client |
| `test/e2e-comprehensive/orchestrator/server-events.ts` | 调 server admin events 的薄 client |
| `test/e2e-comprehensive/orchestrator/fixtures.ts` | 测试数据生成 |
| `test/e2e-comprehensive/orchestrator/phase-p0.test.ts` | P0 阶段所有 case（**P0 PR 必须创建并跑通**） |
| `test/e2e-comprehensive/orchestrator/phase-p1.test.ts` | **P1 阶段开工时创建**；P0 阶段不需要预占位空文件 |
| `test/e2e-comprehensive/orchestrator/phase-p2.test.ts` | **P2 阶段开工时创建**；同上 |
| `test/e2e-comprehensive/agent/index.ts` | client 容器内的 thin HTTP agent（spawn client CLI） |
| `test/e2e-comprehensive/mock-anthropic/index.ts` | 扩展自 `server/test/fixtures/mock-anthropic-api.ts` 的可编程 mock + admin |
| `server/src/admin-events.ts` | server 端结构化事件流 endpoint（**新增**，仅在 `CERELAY_ADMIN_EVENTS=true` 启用，生产默认关） |

#### 4.2 server admin endpoints（仅测试用） / Server Admin Endpoints (Test-Only)

新增 admin HTTP 路由（`server/src/admin-events.ts`），仅当 `CERELAY_ADMIN_EVENTS=true` 时挂载：

| 路由 | 用途 |
|---|---|
| `GET /admin/events?sessionId=...&since=...` | 拉该 session 的结构化事件流（PTY 启动 / tool relay / FUSE op / cache hit/miss / namespace bootstrap）。**仅 in-memory 环形 buffer**，不持久化 |
| `GET /admin/sessions` | 当前活跃 session 列表 + deviceId / cwd |
| `POST /admin/sessions/:id/terminate` | 强制结束 session（G2 类 case 用） |

**安全约束**：
- 该路由组**仅在 `CERELAY_ADMIN_EVENTS=true` 时挂载**，生产 `docker-compose.yml` 不设此 env
- 路由**不挂主端口**，挂在独立的 `8766`（admin port），compose 只在 `cerelay-e2e-net` 网络内暴露
- buffer 容量上限（默认 10k 事件）防 OOM

#### 4.3 多 device 隔离实现 / Multi-Device Isolation

每个 client 容器：

- 容器启动时 entrypoint 生成一次 `~/.config/cerelay/device-id`（UUIDv4，写入文件）
- `HOME` 指向容器内 `/home/clientA`（不与其他容器共享 host fs，必然不同）
- fixture cwd 在 `/workspace/case-XXX/`，由 orchestrator 通过 client agent 的 `cwd` 参数指定
- agent 不重启 → 同一容器内多次 `/run` 共享同 deviceId（用于 F4）
- F3 case = orchestrator 同时调 `client-A:9100/run` 和 `client-B:9100/run`，断言 server 端 cache 目录 `${CERELAY_DATA_DIR}/client-cache/<deviceA>/` 与 `<deviceB>/` 各自存在且不互相污染（通过 server admin endpoint 反查）

#### 4.4 测试间隔离 / Per-Case Isolation

- 每个 case 测前调 mock `/admin/reset` 清 captured + scripts
- 每个 case 测前调 server `/admin/sessions` 拿活跃 session 列表，调 `terminate` 清空
- fixture 目录用 `case-${caseId}/` 命名空间，case 间不冲突；orchestrator 在 `afterEach` 删除当前 case 的 fixture 子目录
- compose 启动时 server 用空 `CERELAY_DATA_DIR`（tmpfs 挂载），整体 e2e 跑完后自动丢

#### 4.5 关键代码示例（伪码）/ Key Code Sketches

orchestrator 的典型 case：

```ts
// test/e2e-comprehensive/orchestrator/phase-p0.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { mockAdmin } from "./mock-admin.js";
import { clients } from "./clients.js";
import { serverEvents } from "./server-events.js";
import { writeFixture } from "./fixtures.js";

test("A1-bash-basic: model triggers Bash → server relays to client → tool_result echoed back", async () => {
  await mockAdmin.reset();
  await writeFixture("case-a1", { "marker.txt": "hello" });

  await mockAdmin.loadScript({
    name: "p0-a1",
    match: { turnIndex: 1 },
    respond: scriptToolUse("Bash", { command: "ls" }),
  });
  await mockAdmin.loadScript({
    name: "p0-a1-final",
    match: { turnIndex: 2 },
    respond: scriptText("done"),
  });

  const result = await clients.run("client-A", {
    prompt: "list current dir",
    cwd: "/workspace/case-a1",
  });

  assert.equal(result.exitCode, 0);

  const captured = await mockAdmin.captured();
  assert.equal(captured.length, 2);
  const toolResult = captured[1].toolResults[0];
  assert.match(toolResult.content, /marker\.txt/);
  assert.equal(toolResult.is_error, false);

  const events = await serverEvents.fetch(result.sessionId);
  assert.ok(events.some((e) => e.kind === "namespace.bootstrap.ready"));
  assert.ok(events.some((e) => e.kind === "tool.relay.completed" && e.tool === "Bash"));
});
```

---

### 5. 三阶段路线 / Phasing

| 阶段 | 交付物 | 验收标准 |
|---|---|---|
| **P0** | 上方 §2.1 全部 case + 容器拓扑 + orchestrator 框架 + admin endpoints + fixtures + npm test 接入 | 本地 `npm test` 全绿；故意把 §1.1 IFS bug 重新引入应被 D3 / B4 case 拦住 |
| **P1** | §2.2 全部 case + G 类 fault injection 工具集 | 全绿；G2 case 验证 namespace runtime 在 client 中途断时无 EBUSY |
| **P2** | §2.3 全部 case + 任何前两阶段冒出的盲点 | 全绿 |

每阶段独立 PR；P0 PR 必须包含本文档的更新（实现走偏需同步修文档）。

---

### 6. 强制约束 / Mandatory Audit

> 详见 [`../CLAUDE.md`](../CLAUDE.md) 的 "E2E 综合测试覆盖审计" 节。

简述：任何功能开发 / 更新 / 修复完成后（commit 前），必须打开本文档 §2 覆盖矩阵，回答以下三问：

1. 本次变更是否引入了**新的协议字段、新的工具、新的拓扑、新的隔离边界、新的 cache 维度**之一？
2. 如果是，§2.1 / §2.2 / §2.3 是否已有 case 覆盖？
3. 如果未覆盖，**本次 PR 必须同步**：
   - 在矩阵中加一行（按当前阶段归类 P0/P1/P2）
   - 在对应 `phase-pX.test.ts` 加 case（或加占位 `test.todo` + issue link）

不允许"功能合入但矩阵未审计"。Review 阶段把这条作为硬卡点。

---

### 7. 故障诊断 / Failure Diagnosis

#### 7.1 失败时容器残留 / Containers Left Behind on Failure

`run-e2e-comprehensive.sh` 在 orchestrator 退码非 0 时**不调 `compose down`**。开发者可：

```bash
docker compose -f docker-compose.e2e.yml ps
docker logs <e2e-server-container>
docker logs <e2e-client-A-container>
docker exec -it <e2e-server-container> sh   # 容器内交互式排查
```

#### 7.2 关键日志位置 / Key Log Locations

| 数据 | 位置 |
|---|---|
| server stderr（结构化 JSON 行） | `docker logs <server>` |
| server admin events 历史 | `curl http://server:8766/admin/events?sessionId=...`（仅在容器网内可达） |
| mock-anthropic captured | `curl http://mock-anthropic:8080/admin/captured` |
| client agent stderr | `docker logs <client-A>` |
| FUSE daemon 诊断 | server stderr `[file-proxy]` 前缀 |

#### 7.3 清理 / Cleanup

- 主动清理：`npm run test:gc`（沿用现有 GC 工具，新增 e2e 命名空间识别）
- 全清：`npm run test:gc:all`

---

### 8. 测试验证 / Testing the Test Infrastructure

P0 阶段交付时必须有以下"meta-test"，证明本套件本身能拦住已知 regression：

| Meta-test | 操作 | 期望 |
|---|---|---|
| `meta-ifs-bug` | 临时 revert `claude-session-runtime.ts` 让 ancestor 段重引入 `_old_ifs="$IFS"` | D3 / B4 case 失败，错误消息含 `IFS: parameter not set` |
| `meta-redact-leak` | 临时 stub `claude-settings-redaction.ts` 让 `ANTHROPIC_API_KEY` 不脱敏 | E1 case 失败，断言 redacted 但实际 leaked |
| `meta-deviceid-collision` | 临时让两个 client 容器共用同一 `device-id` 文件 | F3 case 失败，cache 互相污染 |

meta-test 不在常规 `npm test` 跑（会污染主套件），只在 `npm run test:e2e:meta` 入口手动触发，用于验证套件自身有效性。

---

### 9. 相关 Commit / Related Commits

- 设计文档落地：（待提交）
- IFS bug 修复（驱动本次 e2e 设计）：`34b870a 🩹 修复 / Fix: bootstrap.sh ancestor 段在 set -u 下访问已 unset 的 IFS`

---

### 10. 变更历史 / Change Log

| 日期 | 变更 |
|---|---|
| 2026-05-02 | 初版：定义 P0/P1/P2 三阶段覆盖矩阵、多容器拓扑、orchestrator/agent/mock 协议、强制审计约束 |
