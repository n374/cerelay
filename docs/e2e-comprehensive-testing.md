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
|  | A3-search | `Glob '*.md'` (basename 匹配，client search.ts 不支持 `**` 跨目录) + `Grep 'TODO'` 在 fixture 项目内 | search 工具的 path normalize、basename glob 语义 |
|  | A4-shadow-mcp | 模型调 `mcp__cerelay__bash` 路径 | tool_result.is_error === false（Plan D 不变量） |
| **B. 文件代理** | B1-home-claude-snapshot | server 启动期 `~/.claude/` snapshot 走 cache；主断言验 `file-proxy.read.served` admin event 出现 root=`home-claude` + relPath=root 内相对路径（如 `case-b1-marker.md`，不含 `.claude/` 前缀，因为 home-claude root 已经指向 `~/.claude/`） | snapshot ledger 命中、走 server FUSE 链路 |
|  | B2-claude-json-read | server 读 `~/.claude.json` 走 FUSE；主断言验 admin event root=`home-claude-json` 出现 | 文件级 bind mount + 走 server FUSE 链路 |
|  | B3-project-claude | server 读 `{cwd}/.claude/<file>` 走 project-claude bind mount；主断言验 admin event root=`project-claude` 出现 | project-claude bind mount 链路真发生 |
|  | B4-ancestor-claudemd | 在 cwd 与 home 之间放置 `CLAUDE.md`，server 通过 cwd-ancestor-N FUSE root 读到 | **直接守护 IFS bug 类 regression**（bootstrap ancestor 段必须能跑通） |
| **C. Cache 同步** | C1-initial-pipeline | client 首次连，1k+ 文件 initial sync，pipeline 流控生效 | manifest 写入串行锁、batch ack 不丢、最终 revision 正确 |
|  | C2-revision-ack | initial sync 完成后 server revision **>=** client 已 ack 的 revision，drift ≤ 50（runtime FUSE 访问/TTL 续期会持续 bump）| revision 单调、ack 配对、bound drift |
| **D. Mount namespace** | D1-cwd-aligned | server 端 `pty.spawn.ready` admin event 的 detail.cwd === client 上报 cwd（POSIX spawn 契约：child 启动 pwd === parent 配置 cwd）；次断言保留 mcp__cerelay__bash 跑 pwd 验 client 端也对齐 | namespace 内 cwd 字符串严格对齐 |
|  | D2-home-aligned | server 端 `pty.spawn.ready` admin event 的 detail.homeDir === client 上报 home；次断言保留 echo $HOME 验 client 端 | HOME 环境变量真实重定向 |
|  | D3-ancestor-no-crash | B4 case 同时验 bootstrap 不在 `set -u` 下退出 | **IFS bug 死亡回归** |
| **E. Redaction** | E1-settings-redact | client 上报 `~/.claude/settings.json` 含 `env.ANTHROPIC_API_KEY`，三个独立子 case 分别强制走 snapshot / cache-hit / passthrough 三条路径，分别断言 `file-proxy.settings.redacted` admin event 出现且 detail.site 命中对应 site；e2e 不可稳定触发的出口降级为 server 单测（`server/test/file-proxy-redact.test.ts`） | 三处出口（snapshot / cache-hit / passthrough）全部 redact，无 site 漏 emit |
| **F. 多拓扑** | F1-single-client-concurrent | 同一 client 一次连接，session 内并发 5 次 Bash | tool relay race、ack 序号正确 |
|  | F3-multi-device | 起 client-A / client-B 两容器，并发触发各自的 session，**两侧写入相同 cache relPath 但不同 marker 内容**（cache scope=claude-home 下 relPath=`CLAUDE.md`，不含 `.claude/` 前缀）；通过 `/admin/cache?deviceId=&scope=&relPath=` 单项查询断言 A/B sha256 不同，且各自 hash 匹配本端写入；assertF3Isolation helper 同时被 meta-deviceid-collision 反向期望 throw | per-device store 内容隔离（不仅是目录隔离，hash 真不串） |

#### 2.2 P1：尽量覆盖（第二阶段） / P1: Should-Cover (Phase 2)

> **P1 切分（2026-05-02 落地）**：原 P1 10 个 case + 原 P2 2 个 case 经 Claude × Codex 方案对齐后被切分为 **P1-A**（无基础设施改动、纯测试代码即可 honest 落地）与 **P1-B**（必须先做基础设施改动才能不绕过守护意图）。详情见 §12。
>
> Phase 1 split (landed 2026-05-02): the original P1 10 + P2 2 cases were partitioned into **P1-A** (pure test code, no infra change) and **P1-B** (requires infra change to avoid bypassing the guarded invariant). See §12.

**P1-A（已落地 / Landed）**：

| 维度 | 案例 ID | 状态 | 描述 |
|---|---|---|---|
| A | A5-fallback-guidance | ✅ `phase-p1.test.ts` | shadow MCP 启用 + 内置 Bash 被 disallowedTools/hook deny → 模型下一轮自动改用 `mcp__cerelay__bash`（Plan D §4.5 fallback 闭环可执行） |
| C | C4-large-skipped (skipped 半段) | ✅ `phase-p1.test.ts` | > 1MB 文件被 manifest 标记 `skipped`，server 仅同步元数据；用 `cacheAdmin.lookupEntry` 验 `skipped=true` + summary `skippedCount >= 1`。**truncated 半段（scope > 100MB）需 P1-B 增加 `MAX_SCOPE_BYTES` env override**，因 100MB 在 e2e 启动期同步太慢 |

**P1-B（待做 / Pending — 见 §12 基础设施清单）**：

| 维度 | 案例 ID | 必需基础设施 | 描述 |
|---|---|---|---|
| B | B5-negative-cache | server 加 `file-proxy.client.requested` / `.miss` admin event | 第一次 read 不存在文件 miss 后被记住；第二次同路径不再穿透 client。server 端 negative cache 已实现，但**无可观测计数**，无法 honest 断言"第二次未穿透" |
|  | B6-settings-local-shadow | server 加 `file-proxy.shadow.served` admin event 或扩展 `read.served` 覆盖 shadow file 出口 | 项目 `.claude/settings.local.json` 由 server hook injection 自动写到 runtimeRoot，FUSE shadow 注入到 namespace；当前 4 个 `read.served` 出口（snapshot-cache / snapshot-client / cache / passthrough-settings）都不覆盖 shadow file 读路径，无法 honest 断言 |
| C | C3-runtime-delta | agent 加 `/run-async` + `/admin/mutate-home-fixture` endpoint | session 进行中改 `~/.claude/CLAUDE.md`，server 能读到新内容（watcher delta + ttl 续期）。当前 agent `/run` 阻塞同步，无法 session 内修改 fixture |
|  | C4-large-truncated 半段 | server/client 加 `MAX_SCOPE_BYTES` env override | scope > 100MB → 截断 + manifest `truncated=true`。协议链路已通（client/cache-sync.ts:551 → server/server.ts:541），但 100MB 在 e2e 启动期同步太慢需可调阈值 |
| D | D4-credentials-shadow | 同 B6（shadow file read.served event）+ agent 加 server data dir credentials 写入能力 | server 侧 `${CERELAY_DATA_DIR}/credentials/default/.credentials.json` 通过 shadow file 暴露给 namespace，**always 注入即使源不存在**。需要观测 namespace 内读 credentials shadow 真触发 server FUSE |
| E | E2-credentials-rw | server 加 `file-proxy.write.served` admin event + agent 暴露 server data dir 读取能力 | namespace 内对 `~/.claude/.credentials.json` 写入 → 落到 server 侧持久化文件。需要写路径可观测 + 写后能验真持久化 |
| F | F2-multi-session | agent 加 `/run-async` + 多 session 状态 API | 同 client 一次连接 → 起两个 PTY session 并发。`/run` 阻塞模式无法并发起多 session |
|  | F4-same-device-multi-cwd | 同 F2 | 同 client 连两次（不同 cwd），device-only manifest 共享 |
| G | G1-tool-timeout | server 加 `injectToolTimeout` toggle 或 mock 加 SSE 延迟 builder | tool 执行 timeout → server 返回 error，session 不挂 |
|  | G2-client-disconnect | agent 加 `/run-async` + `/admin/kill-session` endpoint + server 加 `session.disconnected` event | session 中途 client 断 ws → server cleanup namespace + FUSE，无 EBUSY 残留 |
|  | G3-mock-5xx | mock-anthropic 加 `scriptError(status, body)` builder | mock anthropic 返回 5xx，session 优雅终止、日志含上游错误 |

#### 2.3 P2：可后续补 / P2: Nice-to-Have (Phase 3)

> P2 在 P1 切分时清空：原 P2 的 C4-large-skipped / C4-large-truncated 升入 P1（P1-A 与 P1-B 各承担一半），G3-mock-5xx 升入 P1-B。新增的 P2 case 由后续阶段冒出的盲点驱动。
>
> P2 was emptied during P1 split: original C4 was promoted to P1, G3 to P1-B. New P2 items will emerge from gaps surfaced in later phases.

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

#### 4.2 server admin endpoints（运维 / 测试） / Server Admin Endpoints (Ops & Test)

实际架构（**与早期设想不同**：admin 路由挂主端口，不独立 8766；生产路由保留壳但 e2e-only endpoint 受 `CERELAY_ADMIN_EVENTS=true` gate）：

| 路由 | 生产可用 | E2E gate | 用途 |
|---|---|---|---|
| `GET /admin/stats` | ✅ | — | 运维统计 |
| `GET /admin/clients` | ✅ | — | 在线 client 列表 |
| `GET /admin/sessions` | ✅ | — | 当前活跃 PTY session 列表 |
| `GET /admin/tokens` / `POST /admin/tokens` / `DELETE /admin/tokens/:id` | ✅ | — | Token 管理 |
| `GET /admin/tool-routing` / `PUT /admin/tool-routing` | ✅ | — | 工具路由配置 |
| `GET /admin/events?sessionId=&since=` | 壳保留，禁用时返回 `{enabled:false, events:[]}` | `CERELAY_ADMIN_EVENTS=true` 才有数据 | 结构化事件 ring buffer（pty.spawn.ready / file-proxy.read.served / file-proxy.settings.redacted 等） |
| `POST /admin/test-toggles` | ❌ 403 | `CERELAY_ADMIN_EVENTS=true` 才接受 | meta-test 用：disableRedact / injectIfsBug |
| `GET /admin/cache?deviceId=` (summary) | ❌ 404 | `CERELAY_ADMIN_EVENTS=true` 才挂载 | manifest scope summary（C1/C2 用） |
| `GET /admin/cache?deviceId=&scope=&relPath=` (single entry) | ❌ 404 | `CERELAY_ADMIN_EVENTS=true` 才挂载 | 单项摘要 `{size, sha256}`，缺失 404（C3/F3/C4 用） |

**安全约束**：
- 所有 admin 路由都需通过 Bearer Token 认证（`/admin/tokens` 管理）
- e2e-only endpoints（`/admin/events` 数据、`/admin/test-toggles`、`/admin/cache`）由 `CERELAY_ADMIN_EVENTS=true` 二次 gate；生产 `docker-compose.yml` 不设此 env
- `events` ring buffer 容量上限（默认 10k 事件）防 OOM
- 单项 cache 查询不返回文件内容，只返回 `{size, sha256}`，避免暴露真实路径内容
- 早期 spec 提到的"独立 8766 admin port"未落地——e2e compose 通过 token + env gate 在主端口隔离 e2e endpoints

**file-proxy / namespace 结构化 event 列表**（`CERELAY_ADMIN_EVENTS=true` 启用时记录）：

| event kind | 触发点 | detail 字段 |
|---|---|---|
| `pty.spawn.ready` | PTY child spawn 成功（namespace runtime ready） | `{ cwd, homeDir, pid }` |
| `pty.spawn.failed` | PTY child spawn 失败 | `{ error, ... }` |
| `file-proxy.read.served` | server 端实际 served 一次 read 内容（启动期 snapshot 灌入 daemon 或运行时命中） | `{ root, relPath, servedFrom, hasData?/sliceBytes?/size? }`<br>root ∈ `home-claude` / `home-claude-json` / `project-claude` / `cwd-ancestor-N`<br>servedFrom ∈ `snapshot-cache`（buildSnapshotFromManifest）/ `snapshot-client`（client snapshot round-trip）/ `cache`（运行时 tryServeReadFromCache）/ `passthrough-settings`（settings.json 专用 redact 分支）<br>relPath：root 内的相对路径（`home-claude` 不含 `.claude/` 前缀；`home-claude-json` 始终为空串；`project-claude` 不含 `.claude/` 前缀） |
| `file-proxy.settings.redacted` | settings.json 出口实际改写（移除登录态字段） | `{ site, relPath, beforeBytes, afterBytes }` （site ∈ snapshot / cache-hit / passthrough） |
| `file-proxy.settings.redact.bypassed` | meta-redact-leak 把 redact 关掉时的 honest 标记 | `{ site, relPath, bytes }` |

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
| **P0** | §2.1 全部 case + 容器拓扑 + orchestrator 框架 + admin endpoints + fixtures + npm test 接入 | 本地 `npm test` 全绿；故意把 §1.1 IFS bug 重新引入应被 D3 / B4 case 拦住 |
| **P1-A** | §2.2 P1-A 段全部 case（A5 / C4-skipped）；纯测试代码，无基础设施改动 | 本地 `npm test` 18/18 全绿（P0 16 + P1-A 2） |
| **P1-B** | §12 全部基础设施改动 + §2.2 P1-B 段全部 case（B5 / B6 / C3 / C4-truncated / D4 / E2 / F2 / F4 / G1 / G2 / G3）+ 必要的 meta-test | 全绿；G2 case 验证 namespace runtime 在 client 中途断时无 EBUSY |
| **P2** | §2.3（当前为空）+ 任何前述阶段冒出的盲点 | 全绿 |

每阶段独立 PR；P0 / P1-A 已完成（实现走偏需同步修文档），P1-B 必须先以"基础设施 PR"落 §12 改动再开测试 PR。

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

- 设计文档落地：`ef5b61a 📝 文档 / Docs: e2e 综合测试设计稿 + CLAUDE.md 收敛文档治理章节`
- IFS bug 修复（驱动本次 e2e 设计）：`34b870a 🩹 修复 / Fix: bootstrap.sh ancestor 段在 set -u 下访问已 unset 的 IFS`
- P0-A Foundation + canary：`bb8ab63 / f5ae97b / 2440f1a / f66522e / 5db5f7a / 13d8d11 / 694e5e1 / 34240d3 / fbae38d / a63fc2b / eb06489 / 1f782d2 / 13390e7 / c49d6ef`（mock-anthropic / agent / admin-events / orchestrator HTTP / Dockerfiles / compose / run script / canary cases）
- P0-B 实施（**Codex 终审标 4 Critical 待修，详见 §11**）：
  - `69c2c98 🌱 e2e / P0-B-1: 6 个 P0 case + agent homeFixture 协议`
  - `0fc28c1 🌱 e2e / P0-B-2: C1/C2 cache pipeline 验证 + admin/cache endpoint`
  - `f96675a 🌱 e2e / P0-B-3: D1/D2/D3 + E1 + F1/F3 namespace+redact+多拓扑`
  - `a1a1499 🌱 e2e / P0-B-4: 3 个 meta-test 验证 P0 套件能拦住已知 regression`

---

### 10. 变更历史 / Change Log

| 日期 | 变更 |
|---|---|
| 2026-05-02 | 初版：定义 P0/P1/P2 三阶段覆盖矩阵、多容器拓扑、orchestrator/agent/mock 协议、强制审计约束 |
| 2026-05-02 | P0-A Foundation 落地（容器拓扑 / orchestrator / agent / mock-anthropic / admin-events / canary cases A1+B4） |
| 2026-05-02 | P0-B 4 commits 落地，主套件 16/16 + meta 3/3 在容器内跑通；Codex 终审认定 4 Critical 阻断、5 Important、2 Nit，详见 §11，**P0-B 未闭环** |
| 2026-05-02 | P0-B 闭环：11 项缺陷（4 Critical + 5 Important + 2 Nit）全部修复；新增 `file-proxy.read.served` admin event、`assertF3Isolation()` 公共断言、`/admin/cache` 单项查询 + gate、`pty.spawn.ready` 主断言；E1 拆 site=snapshot e2e + cache-hit/passthrough server 单测；mock 拆 `toolResultsAll`/`toolResultsCurrentTurn`；test-toggles 加 runtime assert。e2e 主 16/16 + meta 3/3 + server unit 425/425 全过；Codex 终审通过 |
| 2026-05-02 | P1 阶段切分（Claude × Codex 方案对齐）：原 P1 10 case + 原 P2 2 case 重新切成 **P1-A**（A5 / C4-skipped，无基础设施改动）+ **P1-B**（其余 10 case + 8 项基础设施改动）。**P1-A 落地**：`phase-p1.test.ts` 加 2 case；npm test 入口扩到 `phase-p0.test.ts phase-p1.test.ts`，本地 `bash test/run-e2e-comprehensive.sh` 18/18 全绿；P1-B 范围登记在 §12 |

---

### 11. Codex 终审遗留事项（已闭环 / Closed） / Codex Review Outstanding Items (Closed)

> 状态（2026-05-02 闭环）：下方 11 项（4 Critical / 5 Important / 2 Nit）全部落地。Codex 独立终审通过：主套件 16/16 + meta 3/3 + server unit 425/425 全过；新增 `file-proxy.read.served` admin event + `assertF3Isolation()` 公共断言 + E1 三 site server 单测覆盖。本节作为 P0-B 实施过程的 honest 留痕保留，不再作为开工 todo。
>
> Status (closed 2026-05-02): All 11 items landed; Codex final review passed. Main suite 16/16 + meta 3/3 + server unit 425/425 all green. Section preserved as honest process record; no longer an open todo.

#### 11.0 闭环登记 / Closure Log

| 日期 | 事件 | 验证 |
|---|---|---|
| 2026-05-02 | P0-B Critical/Important/Nit 全部落地，Codex 终审通过 | `bash test/run-e2e-comprehensive.sh` 16/16 ＋ `bash test/run-e2e-comprehensive-meta.sh` 3/3 ＋ `cd server && npm test` 425/425 |

#### 11.1 Critical（必须修，未修不可 merge / Must-fix blockers）

| # | 案例 / 文件 | 问题 | 修正方向 |
|---|---|---|---|
| C1 | B1/B2/B3/D1/D2 in `phase-p0.test.ts` | 用 `mcp__cerelay__read/bash` 走的是 client-routed（[pty-session.ts](../server/src/pty-session.ts) `executeToolViaClient` rewrite 到 client home/cwd 后转发 client 执行），**根本没碰 server FUSE / namespace 链路**。case 名字对得上 matrix，断言走在 client 端原文。 | 不能用 shadow MCP 工具作为主断言。新增 file-proxy 结构化 admin event（按 root + relPath），断言访问真的经过 `home-claude` / `home-claude-json` / `project-claude` FUSE root，而不是 client 本地直读。 |
| C2 | E1 in `phase-p0.test.ts` | 只断言"至少一次 `file-proxy.settings.redacted` event"，没覆盖 matrix 要求的 snapshot / cache-hit / passthrough **三处出口都 redact**。当前 admin event 已经标 `site`，但断言没强制三类 site 都出现。 | 拆 E1 为可稳定触发三个 site 的子断言：分别强制走 snapshot / cache-hit / passthrough 路径，断言对应 site event 出现且没有 `redact.bypassed`。e2e 不可稳定触发的出口必须降级 matrix + 补 server 单测。 |
| C3 | F3 in `phase-p0.test.ts` | 只验 deviceId 不同 + 两边 manifest 非空 + revision > 0，**没真验证内容隔离**。如果 server 错误地用全局 manifest 或串写，本断言仍能过。 | 给 `/admin/cache` 增加按 `deviceId + scope + relPath` 查单项摘要（size / sha256）。F3 双边写同 relPath（`.claude/CLAUDE.md`）但内容不同，断言 A/B 查到不同 hash 且互查不到对方。 |
| C4 | meta-deviceid-collision in `phase-p0-meta.test.ts` | 只验"两侧指向同一 manifest"，没有镜像 F3 失败条件。即使 F3 把核心隔离断言删了，本 meta 仍能过。反向断言失效。 | 抽出 `assertF3Isolation()` 公共断言，主套件 F3 期望 pass，meta collision 下期望 throw。 |

#### 11.2 Important（实现路径，需修但可对齐 / Should-fix）

| # | 文件 | 问题 | 修正方向 |
|---|---|---|---|
| I1 | [`server/src/server.ts`](../server/src/server.ts) `/admin/cache` | 没 `CERELAY_ADMIN_EVENTS=true` gate；只要 admin token 在生产端口暴露即可枚举任意 deviceId 的 revision / scope 统计。**这是 P0-B 引入的真实 production safety bug**。 | 跟 `/admin/test-toggles` 一致 gate 到 `CERELAY_ADMIN_EVENTS=true`，或引入独立 `CERELAY_E2E_ADMIN=true`；生产默认 404/403。 |
| I2 | 本文档 §4.2 | 文档声称 admin 路由仅在 `CERELAY_ADMIN_EVENTS=true` 挂载、独立 8766 端口；实际 `server/src/server.ts` 主端口直接挂 `/admin/*`，`/admin/events` 只是 disabled 时回空。 | 同步 §4.2 安全模型：哪些路由生产存在、哪些 disabled 回空、哪些 e2e-only endpoint 有 gate。 |
| I3 | [`server/src/test-toggles.ts`](../server/src/test-toggles.ts) | 故意放水 toggle 被生产代码 import 到 `file-proxy-manager.ts` / `claude-session-runtime.ts`。当前远程开启路径被 gate 挡住，但生产代码路径**永久读取测试状态**。 | 改 DI：toggle 作为构造参数注入到 e2e server；或改名 `E2eFaultInjection` + 单测断言 `CERELAY_ADMIN_EVENTS !== "true"` 时 POST 无法改变行为。 |
| I4 | [`test/e2e-comprehensive/mock-anthropic/index.ts`](../test/e2e-comprehensive/mock-anthropic/index.ts) `flattenToolResults` | 字段名表示"当前请求 toolResults"，实际累计所有历史 user 消息，导致测试靠 `.at(-1)` 绕语义。 | 拆两个字段：`toolResultsAll` + `toolResultsCurrentTurn`。测试用 current turn；保留旧字段需改名或文档化。 |
| I5 | §2.1 A3 matrix | matrix 写 `Glob '**/*.md'`，实现 `phase-p0.test.ts` 改成 `*.md` 走 basename 匹配。 | 要么修 client glob 支持 `**/*.md` 并按 matrix 测，要么 matrix 显式写"basename glob 语义"。 |

#### 11.3 Nit（细节 / Minor）

| # | 文件 | 问题 |
|---|---|---|
| N1 | C2 测试名 + 注释 + §2.1 矩阵 | 仍写 `==`，实际是 `>= && drift <= 50`。同步描述。 |
| N2 | `phase-p0.test.ts` F1 case | `expectMarker` 变量未使用，删除该行。 |

#### 11.4 Codex 对 9 条自审妥协的逐条判定 / Codex Verdict on Self-Identified Compromises

| # | 妥协 | Codex 判定 | 备注 |
|---|---|---|---|
| 1 | C2 drift ≤ 50 | 有条件接受 | `>=` 合理，阈值是经验值，需更新 matrix/test name 并记录实际 drift 分布 |
| 2 | A4 deny 文案宽松 | 有条件接受 | 主不变量 `is_error=true` 保住；但 docs/Plan D §4.5 对 fallback 引导的描述需补注脚说明主流程由 CC `--disallowedTools` 先拒绝，否则文档误导下游 |
| 3 | E1 admin event 替代真黑盒 | **拒绝当前实现** | admin event 可作 honest 观测，但只验"至少一次"既没覆盖三出口也没证明 leak 不可达，达不到 matrix 目标（详见 C2 修正方向） |
| 4 | F3 SEED_WHITELIST 路径限制 | 接受 | fresh device 冷启动约束真实存在，`seed-whitelist.ts` 含 `CLAUDE.md`，选择合理 |
| 5 | B3 `.claude.json` cleanup 改 `{}` | 接受 | CC 启动期依赖合法 JSON，workaround 放 agent 可接受 |
| 6 | 多 tool 断言 `.at(-1)` | 有条件接受 | 临时能跑，但 mock 字段语义错误，应拆 `currentTurn` 和 `all`（详见 I4） |
| 7 | mock predicate JSON.stringify | 接受 | 不应用于严格结构断言 |
| 8 | meta `\|\|` 反向断言宽松 | 有条件接受 | IFS 失败出口多，`\|\|` 本身可接受；但 device collision meta 没镜像 F3 失败条件，需修（C4） |
| 9 | P0-B 跳过 Claude × Codex 双审 | 有条件接受 | 用户授权推进不等于质量豁免；Critical 修完才算闭环 |

#### 11.5 闭环路径 / Closing the Loop

历史路径已走完：

1. ✅ 4 Critical 全修：C1（file-proxy.read.served event + B1/B2/B3 主断言改造）、C2（E1 site=snapshot e2e + cache-hit/passthrough server 单测降级）、C3（/admin/cache 单项查询 + F3 内容隔离）、C4（assertF3Isolation 公共断言 + meta 反向期望 throw）
2. ✅ 5 Important 全修：I1（/admin/cache CERELAY_ADMIN_EVENTS gate）、I2（§4.2 admin 路由文档同步）、I3（test-toggles assertWritable runtime check）、I4（mock 拆 toolResultsAll + toolResultsCurrentTurn）、I5（matrix 改 `*.md` 对齐 basename 实现）
3. ✅ 2 Nit 全修：N1（C2 描述 `>= drift ≤ 50`）、N2（删 F1 expectMarker）
4. ✅ Codex 终审通过 + 文档闭环登记完成
5. ➡️ 进入 §5 P1 阶段

---

### 12. P1 切分与 P1-B 基础设施清单 / P1 Split & P1-B Infrastructure Inventory

> **背景 / Background**：P1 开工前，Claude × Codex 方案对齐发现原 §2.2 列入 P1 的 10 个 case 中只有 1 个（A5）能在 P0 helpers 覆盖范围内 honest 落地，其余 9 个若强行写都会绕过守护意图（"代码路径存在"假装等价于"行为正确"，是 P0-B Codex 终审已经吃过亏的反模式）。同期把 §2.3 P2 的 C4 也评估了一遍，skipped 半段 honest 可做，truncated 半段同样需要基础设施改动。最终切成 **P1-A**（A5 + C4-skipped，2 case，纯测试代码）+ **P1-B**（其余 10 case + 8 项基础设施改动）。
>
> P1 split rationale: pre-flight Claude × Codex review showed only 1 of original P1 10 cases (A5) was honestly testable with current P0 helpers; others would bypass the guarded invariant. P2 C4 was re-evaluated alongside, splitting into skipped (honest now) and truncated (needs infra). Final split: **P1-A** (A5 + C4-skipped, 2 cases) + **P1-B** (remaining 10 cases + 8 infra items).

#### 12.1 P1-A 闭环登记 / P1-A Closure Log

| 日期 | 事件 | 验证 |
|---|---|---|
| 2026-05-02 | A5-fallback-guidance + C4-large-skipped(skipped 半段) 落地 `phase-p1.test.ts`；npm test 入口扩到 `phase-p0.test.ts phase-p1.test.ts` | `bash test/run-e2e-comprehensive.sh` 18/18 全绿（P0 16 + P1-A 2） |
| 2026-05-02 | **P1-B PR1 (observability bundle) 闭环**：INF-1/2/6/8 4 项 admin event/toggle 全部落地 + Codex 终审通过(0 critical / 2 important / 2 nit 全修)。commits: `9ebae23` (INF-1/2/6 file-proxy events) + `0d4375a` (INF-8 tool relay & session events) + `3e793a2` (orchestrator helpers) | e2e 18/18 + meta 3/3 + server unit 425/425 全过 |
| 2026-05-02 | **P1-B PR2 (agent async runtime) 闭环**：INF-3/4/5 全部落地 + Codex 终审通过(0 critical / 5 important / 3 nit,关键项 #1 runClientAsync timeout cleanup guard 状态语义已修)。commits: `f40761d` (agent INF-3/4 async run + mutate-home-fixture) + `febfd80` (server INF-5 dataDir credentials endpoint) + `0d6bba2` (orchestrator wrappers)。INF-5 设计决策：原方案 agent 跨容器读 server 文件改为 server 加 admin endpoint 更直接 | e2e 18/18 + server unit 425/425 全过(同步 /run schema 完全保留,P0/P1-A 不感知) |
| 2026-05-02 | Codex P1-A 终审通过（0 critical / 1 important / 3 nit）：important 是 A5 注释里"模型自动推理"措辞润色（已改为"脚本化下一轮 fallback 闭环"，并加注脚说明真模型推理由 `e2e-real-claude-bash.test.ts` 守护，不在本套件职责）；nit 中的 A5 meta-test 加固建议登记为 INF-10 进入 P1-B 待办 |
| 2026-05-02 | **P1-B PR1 (observability bundle) 落地**：INF-1/2/6/8 全部完成 — file-proxy.client.requested + .client.miss（perforation 计数，daemon negative cache 入口可观测）+ file-proxy.shadow.served + .write.served（daemon sideband JSON 行通道，shadow file 端到端可达）+ tool.timeout.fired + injectToolTimeout toggle（ToolRelay 构造改造，fault injection 钩子）+ session.disconnected（ws close handler emit）。orchestrator 新增 6 项 typed event helpers + injectToolTimeout API。`bash test/run-e2e-comprehensive.sh` 18/18 + `bash test/run-e2e-comprehensive-meta.sh` 3/3 + `cd server && npm test` 425/425 全过 |
| 2026-05-02 | Codex PR1 终审通过（0 critical / 2 important / 2 nit 全修）：important #1（settings.json passthrough 漏 emit `client.requested`）→ 在 `sendClientRequest` 前补 emit + reason="settings_json_passthrough"；important #5（emit_event 阻塞风险）→ daemon 端加 `ADMIN_EVENTS_ENABLED` env gate，生产路径零开销零阻塞；nit #9（session.disconnected 命名误读）→ 加注释明确"只覆盖 client_close 路径，未来 G2 扩展时下沉到 destroyPtySession 内按 reason 区分"；nit #13（ring buffer 覆盖）暂不动，待 P1-B 测试 PR 时关注 baseline since 切片 |

#### 12.2 P1-B 基础设施清单 / P1-B Infrastructure Items

每项给出"为什么 honest 测必须依赖它"。**P1-B 必须先以"基础设施 PR"落这些改动，再开"测试 PR"实现 §2.2 P1-B 段的 10 case**——按这个顺序才能保证测试代码不再绕过守护意图。

| # | 改动 | 服务对象 case | honest 测的硬约束 |
|---|---|---|---|
| **INF-1** ✅ | server 加 `file-proxy.client.requested` / `file-proxy.client.miss` admin event | B5 | **PR1 已落地** (commit 9ebae23)。server 端 negative cache 已实现（`fuse-host-script.ts` `_cache.put_negative()` + server `putNegative()` + ledger 持久化），但**无任何观测点**判断"第二次同 path 是否真未穿透"。每次穿透 emit `.client.requested`(包含 settings.json passthrough 路径), client 报 ENOENT 时 emit `.client.miss`。helpers `fileProxyEvents.findClientRequested/findClientMiss` 备好 |
| **INF-2** ✅ | server 加 `file-proxy.shadow.served` admin event | B6 / D4 | **PR1 已落地** (commit 9ebae23)。daemon Python 加 `emit_event` sideband 通道(stdout JSON 行,gate 在 `CERELAY_ADMIN_EVENTS=true` 防生产阻塞), `read()` shadow 分支成功后 emit。helper `fileProxyEvents.waitForShadowServed` 备好 |
| **INF-3** ✅ | agent 加 `/run-async` + `/admin/run/{id}/status` + `/kill` + `/wait` endpoint；`/run` 同步保留作兼容 | C3 / F2 / F4 / G2 | **PR2 已落地** (commit f40761d)。runStates Map 治理：TTL 5min + LRU 50 + buffer cap 4MB；startClientRun 抽出为 sync/async 共享底层；同步 `/run` schema 完全保留 (P0/P1-A 18 case 全绿验证)。orchestrator: `clients.runAsync/runStatus/killRun/waitRun` |
| **INF-4** ✅ | agent 加 `/admin/mutate-home-fixture` endpoint | C3 | **PR2 已落地** (commit f40761d)。复用 applyHomeFixture (rel 守门 + mkdir + writeFile)；**不**触发 cleanup,调用方负责后续清理或覆盖。orchestrator: `clients.mutateHomeFixture` |
| **INF-5** ✅ | server 加 `/admin/dataDir/credentials` GET/PUT/DELETE endpoint (原方案 agent 跨容器读 server 文件,Codex review 改为 server admin 更直接) | D4 / E2 | **PR2 已落地** (commit febfd80)。路径硬编码 `${CERELAY_DATA_DIR}/credentials/default/.credentials.json` (防 path traversal)；PUT 原子写 (tmp+rename)；bytes 用 `Buffer.byteLength` UTF-8；gate `CERELAY_ADMIN_EVENTS=true`。orchestrator: `serverDataDir.{get,put,delete}Credentials` |
| **INF-6** ✅ | server 加 `file-proxy.write.served` admin event（含 root + relPath + servedTo） | E2 | **PR1 已落地** (commit 9ebae23)。daemon 端 `write()` shadow 分支成功后通过 sideband emit (shadow:true 标识 daemon 直写 vs 后续 server 写出口); helper `fileProxyEvents.waitForWriteServed` 备好 |
| **INF-7** | server / client cache-sync 加 `MAX_FILE_BYTES` / `MAX_SCOPE_BYTES` env override（仅 e2e 配置） | C4-truncated | scope > 100MB 在 e2e 启动期同步太慢；协议链路（`cache_task_delta.truncated` + server `manifest.scopes[*].truncated`）已通，只缺可调阈值。生产侧守门：env 必须以 `CERELAY_E2E_` 前缀 + 仅在 `CERELAY_ADMIN_EVENTS=true` 下生效 |
| **INF-8** ✅ | server 加 `injectToolTimeout` test-toggle + `tool.timeout.fired` / `session.disconnected` admin event | G1 / G2 | **PR1 已落地** (commit 0d4375a)。`ToolRelay` 构造改造接受 `{sessionId, adminEvents}` + `createPending` 接受 `{timeoutMsOverride?}`; `pty-session` 调 `getTestToggles().injectToolTimeout` 决定是否注入短超时;`session.disconnected` emit 在 ws close handler (注释明确"只覆盖 client_close 路径"语义边界); `injectClientDisconnect` toggle 砍掉 (G2 由 P1-B PR2 INF-3 agent kill ws 实现); helpers `toolTimeoutEvents.waitForFired` / `sessionEvents.waitForDisconnected` 备好 |
| **INF-9** | mock-anthropic 加 `scriptError(status, body)` builder | G3 | mock 当前只支持 stream 响应，无 5xx error builder；扩 `ScriptDef.respond` 加 `{type:"error", status, body}` 分支 |
| **INF-10** | meta-test：故意破坏 A5 deny 文案（移除 `mcp__cerelay__bash instead` 引导段） | A5 加固 | P1-A Codex 验收建议项：A5 主断言依赖 deny 文案命中正则，若未来 deny 文案被改动 / 简化导致正则全失效，A5 仍会假绿。补 meta-test 故意 stub `buildShadowFallbackReason`，断言 A5 应失败。属 P1-B 加固项，不阻断 P1-A 闭环 |

#### 12.3 P1-B case 与基础设施依赖对照 / Case ↔ Infra Mapping

| Case | 依赖 INF | 备注 |
|---|---|---|
| B5-negative-cache | INF-1 | |
| B6-settings-local-shadow | INF-2 | 同时也守 hook injection 端到端可达 |
| C3-runtime-delta | INF-3 + INF-4 | |
| C4-truncated 半段 | INF-7 | skipped 半段已在 P1-A 落地 |
| D4-credentials-shadow | INF-2 + INF-5 | |
| E2-credentials-rw | INF-5 + INF-6 | |
| F2-multi-session | INF-3 | |
| F4-same-device-multi-cwd | INF-3 | |
| G1-tool-timeout | INF-8 | |
| G2-client-disconnect | INF-3 + INF-8 | |
| G3-mock-5xx | INF-9 | |

#### 12.4 P1-B 推荐落地顺序 / P1-B Recommended Implementation Order

1. **基础设施 PR 1**（observability bundle）：INF-1 / INF-2 / INF-6 / INF-8（admin event 增量），都是 server 加 event，单 PR 串起来 + 对应 `server-events.ts` helper
2. **基础设施 PR 2**（agent async runtime）：INF-3 / INF-4 / INF-5（agent endpoint 扩展），单 PR 一次性把 agent /run 升级为异步 + 加配套 admin endpoint
3. **基础设施 PR 3**（cache budget override）：INF-7（client + server env 配置），单 PR
4. **基础设施 PR 4**（mock error builder）：INF-9（mock-anthropic 扩展），单 PR
5. **测试 PR 1**：B5 / B6 / D4 / E2（依赖 PR 1 + PR 2）
6. **测试 PR 2**：C3 / F2 / F4 / C4-truncated（依赖 PR 2 + PR 3）
7. **测试 PR 3**：G1 / G2 / G3（依赖 PR 1 + PR 2 + PR 4）

每个测试 PR 跑一次 Claude × Codex 验收。基础设施 PR 由 Claude 独立完成 + Codex 并行评审。
