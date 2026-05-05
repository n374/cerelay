# Plan: shadow-mcp-permission-integration

> 位置：`docs/changes/shadow-mcp-permission-integration/plan.md`
> 角色：本 change 的技术方案 + 关键决策记录。配套 [`proposal.md`](./proposal.md)（why + what）与 spec delta（[shadow-mcp-permission](./specs/shadow-mcp-permission/spec.md) / [shadow-mcp-tools](./specs/shadow-mcp-tools/spec.md) / [client-config-sync](./specs/client-config-sync/spec.md)）。
>
> ⚠️ **Codex 评审待补**：本 plan 当前为 Claude 独立方案版（review-workflow 阶段 1 Claude 线产出）。按规范应进入"双人对齐循环"（≤3 轮），但本会话内 Codex 评审尚未触发。Tasks / Implement 阶段开启前必须补完该评审，或显式标注 `[Codex 不可用，跳过评审]` 走豁免路径。

## 目标与约束

继承自 [`proposal.md`](./proposal.md) 的 Why / Success Metrics / Out of Scope，不复述。下面只列**对方案设计有约束力**的额外要求：

- **C-1 server 闭环**：所有改动在 `server/src/` 内闭环；`client/src/` 零改动；`protocol.ts` 零新增字段。
- **C-2 Plan D 不变量保留**：`mcp__cerelay__*` 成功 dispatch `is_error === false` 的不变量保留；新增的 `is_error === true` 路径（permission deny / unmatched / fail-closed）由 cerelay 显式控制。
- **C-3 跨场景配置兼容**：写回 `settings.local.json` 的格式必须是 CC 原生格式，不允许写 `mcp__cerelay__*`。
- **C-4 fail-closed**：mini engine 内部异常 → 拒绝；不静默放过。
- **C-5 redaction 不变量**：写回路径走现有 client-routed Write tool；server 侧 redaction 三处出口（启动期 snapshot 预热 / 运行时 cache 命中 / 运行时 client 穿透）继续生效，不依赖写回路径"提前清洁"。

## 架构总览

### 模块切分

```
server/src/
├── permission/                          ← 新增模块
│   ├── engine.ts                        ← Mini permission engine（核心）
│   ├── rules-loader.ts                  ← 从 cache manifest 加载 settings.json + settings.local.json，解析 permissions.allow/deny
│   ├── rules-matcher.ts                 ← prefix/exact/tool-level 三种匹配器
│   ├── elicitation.ts                   ← MCP elicitation/create 客户端 + 兜底文案
│   ├── writeback.ts                     ← Always 写回 settings.local.json（通过 client-routed Write tool）
│   └── index.ts                         ← 对外导出
├── mcp-ipc-host.ts                      ← 修改：dispatcher 内插入 permission check 步骤
└── pty-session.ts                       ← 修改：启动时 elicitation 能力探测；规则集首次加载
```

### 数据流

```
CC mcp__cerelay__bash 调用
   │
   ▼
cerelay-routed (子进程)
   │ stdio JSON-RPC
   ▼
MCPIpcHost.dispatcher (主进程)
   │
   ├─[1] permission.engine.evaluate(toolCall)
   │     ├─ allow → 继续 ↓
   │     ├─ deny → 直接 isError + 拒绝文案，不派发
   │     └─ unmatched →
   │         ├─ elicitation 可用 → permission.elicitation.askUser()
   │         │   ├─ 一次允许 → 派发
   │         │   ├─ Always 允许 → permission.writeback.appendToSettingsLocal() + 派发
   │         │   └─ 拒绝 → isError + 拒绝文案
   │         └─ elicitation 不可用 → isError + 引导文案（C-4）
   │
   ▼
[allow / 一次允许 / Always 允许 三种放行情况]
ToolRelay.dispatch → ws → client tool 本机执行 → 回程渲染 (is_error: false)
```

### 启动期流程（PTY session 启动时）

```
1. 现有：MCPIpcHost 启动、追加 CLI flags、注入 mcp-config 等
2. 新增：permission.engine 加载规则集（从 cache manifest 读 ~/.claude/settings.json + {cwd}/.claude/settings.local.json）
3. 新增：探测 CC 是否支持 elicitation/create（发送 capabilities 探针 / 解析 initialize response）→ 缓存到 session 状态
4. 现有：spawn claude CLI 子进程
```

### Cache delta 与规则集刷新

- 利用现有 watcher：client 编辑 `~/.claude/settings.json` → cache delta 推到 server → server cache manifest 更新
- **每次 evaluate 前**：从 cache manifest 读取最新规则（轻量，复用现有读路径），不走 daemon 维护事件订阅
- 优化空间（待评估）：用 cache revision 做 short-circuit（revision 不变则复用上次解析结果）。**第一版不做**，先朴素实现。

## 技术栈

- TypeScript + Node.js 20+（继承项目）
- `@modelcontextprotocol/sdk@^1.29.0` 的 elicitation API（待 spike 确认）
- 无新增依赖；规则解析手写（不引入 cron 表达式 / glob 库等重型依赖）

## 关键决策

### D-1: permission check 放在 dispatcher 主进程，不放在 routed 子进程

**选项**：
- A：在 `cerelay-routed/index.ts` 子进程内做 permission check（CC 直接对接的进程）
- B：在主进程 `MCPIpcHost.dispatcher` 内做 permission check（IPC 派发链路上）

**选 B**。理由：

- **A 要求 routed 子进程持有完整 settings 内容**（含敏感字段），违反 "routed 子进程是最小信任体"原则
- B 让规则集只在主进程内存活，子进程仍是无状态转发者
- B 与现有架构对齐——主进程已经持有 cache manifest，无额外数据搬运
- **代价**：dispatcher 增加一次同步 evaluate 调用，但规则集 < 100 条时不会成为瓶颈

### D-2: 规则解析复杂度——只支持 prefix / exact / tool-level

**选项**：
- A：手写 mini engine（仅 prefix / exact / tool-level，与 proposal Q1 共识一致）
- B：实现完整 CC permission DSL（含 regex、env-var 替换等）
- C：嵌入 CC binary 的 permission engine（如有可独立调用的 API）

**选 A**。理由：

- B 工作量大且 CC 未来语法扩展时会一直追赶
- C 不存在公开 API，反向工程不在 100% userland 范畴
- A 覆盖 95% 实战需求（用户 settings 里 prefix:* 是绝对主流）
- 不识别的规则（如 regex）降级为 unmatched 而非抛错——保守路径
- **登记债务**：CC 升级新语法时本 engine 需扩展（已记入 `docs/project.md` §4 TD-4）

### D-3: 写回 prefix 粒度——取首两 token

**选项**：
- A：取首 1 token 作为 prefix（`Bash(git:*)` 太宽）
- B：取首 2 token（`Bash(git push:*)` 平衡精度与覆盖）
- C：交互让用户选（multi-choice：精确 / 一级 / 两级）
- D：固定 exact match（`Bash(git push origin main)` 太严）

**选 B 默认 + C 可调**。理由：

- B 是 CC 用户实际配置的主流粒度
- C 可调让重度用户细化；但**第一版**只实现 B（默认）；C 留给后续 change
- D / A 极端化，体验差

### D-4: elicitation 探测时机——启动时一次

**选项**：
- A：每次 unmatched 时都探测（hot path 浪费）
- B：PTY session 启动时一次探测，结果缓存（直到 session 结束）
- C：完全不探测，固定假设支持 / 不支持

**选 B**。理由：

- A 浪费且可能在权限审批 hot path 引入抖动
- C 不灵活，CC 升级前后行为不一致
- B 兼顾性能与准确——session 寿命内 CC 版本不会变
- **探测方式**：发送 MCP `initialize` 时观察 `capabilities.elicitation` 字段；如 SDK 暴露能力字段则直接读

**Spike 任务**：实现前先用一段 30 行 prototype 验证 SDK 在 routed 链路上是否能拿到 elicitation capability。如果 SDK 不直接暴露，需要看 routed 子进程是否能转发 capability 信息回主进程。

### D-5: 写回原子性——临时文件 rename

**选项**：
- A：直接 Write tool 覆写（client 端就是 fs.writeFile）
- B：让 client 写到临时文件，然后 rename（POSIX 原子）
- C：在 server 端做"读 → 改 → 写"，client 端只是简单覆写

**选 A**。理由：

- A 最简，复用现有 Write tool；CC 用户现有的"裸用 CC"也是这种语义（CC 写回 settings 也不是原子）
- B 需要在 client 加新 Tool（Rename），违反 C-1 server 闭环原则
- 现实风险：写回时被 client 用户同时编辑 → 文件污染。**接受这个风险**，与 CC 原生行为一致；如发生冲突 watcher 会触发新 cache delta 让下次 evaluate 重读最新内容
- **登记债务**：未来如果出现并发污染问题，再考虑加文件锁机制

### D-6: 规则集多文件合并顺序——遵循 CC 原生

**决策**：enterprise → user (`~/.claude/settings.json`) → project (`{cwd}/.claude/settings.json`) → project-local (`{cwd}/.claude/settings.local.json`)，后者覆盖前者中相同条目。`~/.claude.json` 中的等价字段（如有）按 CC 原生顺序合并。

**理由**：proposal Q2 共识——零并行配置，必须与 CC 原生 engine 行为一致，否则 cerelay 启用时与裸用时表现不一致就毁了 success metric #3。

**Spike 任务**：跑一个 CC 实测确认 enterprise → user → project → project-local 的实际语义（特别是 deny 在不同层级时是否仍是"任一层 deny 则 deny"）。

### D-7: 失败传播——Always 写回失败

**决策**：Always 写回失败时，本次 elicitation 仍然按"一次允许"放行（用户已经表达了 allow 意图），但**告知 user 规则未持久化**：通过 elicitation 后续消息或 isError 后缀文案告知。下次同命令仍走 elicitation。

**理由**：保护用户当前任务不被打断（已选 allow），但避免静默丢失"Always"意图。

## 影响面

| 受影响项 | 类型 | 说明 |
|---|---|---|
| `shadow-mcp-permission` capability | 新增（ADDED） | 见 [spec delta](./specs/shadow-mcp-permission/spec.md) |
| `shadow-mcp-tools` capability | 修改（MODIFIED + ADDED） | 见 [spec delta](./specs/shadow-mcp-tools/spec.md) |
| `client-config-sync` capability | 新增（ADDED only） | 见 [spec delta](./specs/client-config-sync/spec.md) |
| `server/src/mcp-ipc-host.ts` | 修改 | dispatcher 增加 permission check 调用 |
| `server/src/pty-session.ts` | 修改 | 启动时初始化 PermissionEngine、探测 elicitation 能力 |
| `server/src/permission/*` | 新增 | engine / rules-loader / rules-matcher / elicitation / writeback |
| `server/test/permission/*` | 新增 | 单元测试与集成测试 |
| `server/test/e2e-mcp-shadow-bash.test.ts` | 修改 | 新增 permission deny / unmatched / Always 写回三个 e2e case |
| `docs/specs/shadow-mcp-tools/spec.md` | 修改（archive 时合并 delta） | 增加 Permission check before dispatch、修订 Tool result 渲染契约、修订双路径 is_error 不变量 |
| `docs/specs/shadow-mcp-permission/spec.md` | 新增（archive 时创建） | 完整新 capability spec |
| `docs/specs/client-config-sync/spec.md` | 修改（archive 时追加） | 追加 settings.local.json 写回路径 Requirement |

## 风险与回滚

| 风险 | 等级 | 缓解 |
|---|---|---|
| **R-1**：elicitation 探测在不同 CC 版本行为不一致，导致部分用户始终走 isError 兜底 | 中 | D-4 探测兜底；isError 文案明确，引导用户配置 settings；记入 spec NFR |
| **R-2**：mini engine 解析 settings.json 时遇到边角语法（注释 / trailing comma）抛错 → fail-closed 全工具不可用 | 高 | 解析失败 → 该 settings 文件视为空 + warn 日志；不让所有调用全 deny |
| **R-3**：Always 写回污染 user 的 `settings.local.json`（覆盖了用户其他字段） | 中 | 必须读 → 改 → 写：仅 mutate `permissions.allow` 数组，其他字段保持；JSON 缩进 / 换行风格保持原样 |
| **R-4**：规则集刷新延迟（watcher 慢）导致 Always 写回后下次仍走 elicitation | 低 | 写完后强制让 server 端的 rules-loader cache invalidate，下次 evaluate 强制重读 |
| **R-5**：性能——每次工具调用前都解析 settings 文件 | 低 | 第一版朴素实现；如出现性能问题再加 cache revision short-circuit |
| **R-6**：与 hook fallback 路径相互污染（feature flag 切换时） | 低 | 已有 e2e 双路径守护；本 change 修改 dispatcher 内逻辑，不动 hook 路径 |

**回滚策略**：

- **方案 A（最稳）**：`CERELAY_ENABLE_SHADOW_MCP_PERMISSION` env 默认 true，显式 false 时关闭 permission check（dispatcher 直接派发），回退到当前行为
- **方案 B（更激进）**：完全关闭 shadow MCP（已有 `CERELAY_ENABLE_SHADOW_MCP=false`），回退到 hook fallback
- **代码层回滚**：单 commit 集中改动 `server/src/mcp-ipc-host.ts` 与 `server/src/pty-session.ts`，可 revert

## 细节决策

> 低级分歧的裁决记录（Claude 直接裁决项）。

- **DD-1**：模块名用 `permission` 而非 `permissions`（单数与 CC 字段名 `permissions.allow` 不冲突；目录是模块）
- **DD-2**：`engine.evaluate()` 返回的三态用 string literal `'allow' | 'deny' | 'unmatched'`，不用 enum（项目无 enum 风格）
- **DD-3**：rules-loader 的 cache invalidation key 用 `(deviceId, settingsRevision)` 元组（device 维度 + cache revision）
- **DD-4**：elicitation 文案中的 prefix 建议固定 D-3 选 B（首两 token）
- **DD-5**：测试使用 `node --test`，不引入 jest / vitest（项目惯例）

## 未决问题

> 留给 tasks / implement 阶段澄清的 open questions。

- **OQ-1**：MCP `elicitation/create` 的 schema / SDK 支持情况——**Spike 必做**
- **OQ-2**：CC 实测中 enterprise / user / project / project-local 四层 deny 优先级的精确语义——**Spike 必做**
- **OQ-3**：`settings.json` 是 JSON-with-comments 还是严格 JSON？解析器选 `JSON.parse` 还是 jsonc-parser？
- **OQ-4**：写回时若 `{cwd}/.claude/` 目录不存在（用户从未创建过 .claude 子目录），是否应该自动创建？
- **OQ-5**：rules-loader 在 settings 被 watcher 更新后，是否需要主动通知 dispatcher 端的现有 in-flight 调用重评估？或只影响下一次？

## 跨阶段衔接

- **Tasks 阶段**：把 OQ-1 / OQ-2 列为 spike 任务（先做，结果回填本 plan 与 spec delta），其余功能按本 plan 模块切分拆任务
- **Implement 阶段**：按"先 spike → 改 spec / plan（如需）→ 实现 engine → 集成 dispatcher → e2e 验证"顺序
- **Verify 阶段**：双人对齐评审 + 验收三个 success metric（命中无打扰 / Always 写回生效 / 跨场景一致性）
- **Archive 阶段**：合并三份 spec delta 到 living spec；新建 `docs/specs/shadow-mcp-permission/spec.md`；更新 `docs/project.md` 移除 TD-4（如本 change 真的覆盖了完整范围）

---

**创建于**: 2026-05-06
**当前阶段**: Plan（Claude 独立版完成 → 待 Codex 评审 / 用户确认是否走豁免）
**关联文档**:
- [`proposal.md`](./proposal.md) — Why + What
- [`specs/shadow-mcp-permission/spec.md`](./specs/shadow-mcp-permission/spec.md)
- [`specs/shadow-mcp-tools/spec.md`](./specs/shadow-mcp-tools/spec.md)
- [`specs/client-config-sync/spec.md`](./specs/client-config-sync/spec.md)
- `~/.claude/rules/review-workflow.md` — 双人对齐流程
