# project.md — Cerelay 项目 Worldview

> 本文件定义项目的"世界观"：技术栈版本、架构铁律、模块划分、已知技术债。所有 change 在 plan 阶段必须对照本文件做约束检查。
>
> 与 `constitution.md`（治理原则）的区别：本文件描述**事实现状**（系统是什么样），constitution 描述**主观要求**（系统必须遵守什么）。

## 1. 技术栈版本

| 组件 | 语言 / 框架 | 版本 | 说明 |
|---|---|---|---|
| 运行时 | Node.js | ≥ 20（实测开发环境 v25.x） | ESM-only（`"type": "module"`） |
| 主语言 | TypeScript | latest | 三个 workspace 统一 `tsc --noEmit` typecheck |
| Server 通信 | `ws` | ^8.0.0 | WebSocket 双向流 |
| MCP | `@modelcontextprotocol/sdk` | ^1.29.0 | shadow MCP routed dispatcher 与 MCP proxy 都基于此 |
| Client CLI | `commander` | ^12.0.0 | 命令行参数 |
| Client 文件监听 | `chokidar` | ^4.0.3 | cache delta watcher |
| Client TOML 解析 | `smol-toml` | ^1.6.1 | 解析 settings.toml 等配置 |
| 测试运行器 | Node 原生 `node --test` | — | `--test-concurrency=1` 防资源竞争 |
| 容器编排 | Docker Compose | — | `npm run server:up` 启动 |
| Claude CLI | `claude`（外部 binary） | 由用户本地安装 / 容器内安装 | Server 通过 spawn 子进程调用，间接经由 `@anthropic-ai/claude-agent-sdk` |

## 2. 架构铁律

### 2.1 三层切分不可破

```
Client（client/）         Server（server/）             Claude Code CLI
  ├─ Executor             ├─ Session Manager            ├─ Reasoning
  ├─ Tools                ├─ WebSocket Router           ├─ Tool Interception
  └─ Terminal UI          ├─ MCP Proxy                  └─ Output Stream
                          └─ Mount Namespace Runtime
```

- **Client 拥有完整工具执行权**；Server 不执行工具，只转发。
- **Server 通过 SDK Hook + Shadow MCP 拦截工具调用**，转发到 Client；Client 本机执行后回传结果。
- **claude CLI 作为外部进程**由 Server spawn，受 mount namespace 约束。

### 2.2 通信协议铁律

- 唯一双向流通道是 WebSocket（`ws://...`）。
- 消息类型集中定义在 `client/src/protocol.ts` 与 `server/src/protocol.ts`，**两端必须同步**。
- 不允许 Client 与 Server 通过任何旁路（共享文件、HTTP polling、shell）交换业务状态。

### 2.3 文件系统访问铁律（Filesystem access invariants）

参照项目 CLAUDE.md「Mount Namespace 隔离」章节，**这部分是 Plan F4 P2 cross-cwd-fileproxy-isolation 收尾后的稳定不变量**：

- CC 启动后的 `cwd` 字符串等于 Client 启动目录；CC 与 Client 两侧看到的当前目录路径一致。
- 用户文件访问必须走被 hook 拦截的工具调用（`Bash` / `Read` / `Write` / `Edit` / `MultiEdit` / `Grep` / `Glob`），并在 Client 本机执行。
- FUSE file proxy 只允许 Claude 配置范围：`~/.claude/`、`~/.claude.json`、`{cwd}/.claude/`。项目源码不通过 FUSE 暴露。
- `settings.local.json` 必须作为项目级 hook 配置注入到 `{cwd}/.claude/settings.local.json`。
- Server 凭证作为 `home-claude/.credentials.json` shadow file 暴露给 runtime；真实位置 `${CERELAY_DATA_DIR:-/var/lib/cerelay}/credentials/default/.credentials.json`。
- `~/.claude/settings.json` 中的登录态字段（`env.ANTHROPIC_BASE_URL` / `env.ANTHROPIC_API_KEY` / `env.ANTHROPIC_AUTH_TOKEN` / 顶层 `apiKeyHelper`）**必须经 server → CC 出口三处全部 redact**（启动期 snapshot 预热 / 运行时 cache 命中 / 运行时 Client 穿透），不得依赖 Client 侧清洁。

### 2.4 工具拦截路径铁律（Plan D Shadow MCP）

参照 CLAUDE.md「Shadow MCP Tools (Plan D)」章节：

- **`mcp__cerelay__*` 路径**：`tool_result.is_error === false` 是模型可见 ground truth。
- **legacy hook 路径**（fallback）：CC 协议硬约束 `is_error === true`，不试图绕开。
- Tool routing 互斥：`mcp__cerelay__*` 一律不被视为 client-routed，避免双重执行。
- Shadow MCP 默认启用（`CERELAY_ENABLE_SHADOW_MCP=true`），仅显式 `false` / `0` / `no` / `off` 关闭。

### 2.5 缓存维度铁律（device-only since 2026-05-02）

- Client 文件缓存以 `deviceId` 为粒度，**不再有 cwdHash 子目录**。
- 同一 device 跨 cwd 共享 manifest 与 blob 池（内容寻址 dedup）。
- TTL 必须有限正数（`ttlMs ≤ 0 / Infinity / NaN` 触发 RangeError）。
- manifest 写入按 deviceId 串行加锁，跨 device 仍并发。

## 3. 模块划分（顶层目录）

| 目录 | 职责 |
|---|---|
| `client/` | Client CLI：交互入口、本地工具执行、终端 UI、cache sync 上报 |
| `server/` | Brain Server：HTTP/WebSocket、Session 管理、SDK 集成、MCP 代理、PTY 运行时、FileAgent + ConfigPreloader、shadow MCP routed dispatcher |
| `web/` | 可选浏览器 UI |
| `docs/` | Spec-Driven 文档（本目录） |
| `test/` | 跨 workspace 烟测与 e2e 综合测试脚本 |
| `Dockerfile` / `docker-compose.yml` / `docker-entrypoint.sh` | 容器化部署 |

详细内部结构见项目根 CLAUDE.md「项目结构」章节。

## 4. 已知技术债

> 反向生成 baseline 时识别的"代码现状中的债"，不修复，仅登记。后续 change 触达对应模块时一并清理。

| # | 描述 | 触达条件 |
|---|---|---|
| TD-1 | `~/.claude.json` 中的登录态字段（`apiKeyHelper` / `oauthAccount` 等）暂未做 redaction，仅 `~/.claude/settings.json` 做了 | 出现实际泄漏证据 / 用户主动要求覆盖 |
| TD-2 | `docs/` 顶层 6 份既有文档（`architecture.md` 等）未按 Spec-Driven 模型组织 | 独立 change `docs-restructure` 启动时 |
| TD-3 | living spec 仅覆盖 2 个 capability（`shadow-mcp-tools` / `client-config-sync`），其他能力未反向生成 | 后续 change 触达对应能力时通过 baseline change 反向补齐 |
| TD-4 | Mini permission engine 仅支持 `Bash(prefix:*)` / exact / tool-level 三种规则形式，CC 未来若引入 regex / env-var 替换需要扩展 | CC 升级到带新 permission 语法的版本时 |

## 5. 与 CLAUDE.md 的关系

项目根 `CLAUDE.md` 是**给 CC 看的行为约束 + 操作手册**（启动命令、调试方式、常见场景），本文件是**给所有协作者看的事实现状描述**。两者内容有交集（架构铁律），但角色不同：

- CLAUDE.md 改了之后影响 CC 当前会话的行为
- project.md 改了之后影响所有 future change 的 plan 检查

修改架构铁律时**两份文档必须同步**，避免事实漂移。
