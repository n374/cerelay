<!-- doc-init template version: v1.0 -->
# 启动期进度 UI / Startup Progress UI（Phase 抽象）

> **Owner**: client 架构组
> **Reviewers**: 全员（项目级强制约束，新增 phase 必须遵守不变量）

**文件**：`client/src/ui.ts`（`CacheSyncProgressView` + `Phase` 抽象），`client/src/client.ts`（`beginStartupSpinner` / `endStartupSpinner` / `printAboveSyncProgress`）

## 背景

客户端启动期至少有 3 个进度展示场景——cache sync 扫描期（计算文件指纹）、cache sync 上传期（同步中）、PTY 启动期（"正在启动 Claude Code..."）。这 3 个场景历史上各自独立实现 spinner，每个都被同样的 bug 模式（不到 100% 就跳完成、外部 stdout 写入污染 cursor 行追踪）轮流打中过；修复需要在每处分别落地，"修一个漏一个"。

## 强制约束

> **任何启动期 / 多阶段进度 UI 必须经由 `CacheSyncProgressView` 的 `Phase` 抽象渲染。禁止再在客户端任何地方写独立的 `setInterval` + `\r\x1b[K` 单行覆写 spinner。**

## 新增 Phase 的步骤

1. 在 `client/src/ui.ts` 内继承 `Phase` 实现一个新子类：
   - `id: PhaseId` 给一个新的字符串字面量（同时扩展 `PhaseId` 类型）
   - `render(ctx)` 返回若干行（不含尾部 `\n`）
   - 有数字进度的 phase：实现 `forceComplete()` 把状态推到 100%；`successMessage()` 返回完成消息
   - 无数字进度（如 spinner-only）的 phase：覆写 `showsFinalFrame = false`，`successMessage()` 默认返回 null
2. 在 view 的事件入口（`handle()` 或新加 `beginXxx`/`endXxx` 方法）触发 `beginPhase` / `completePhase` / `abortPhase`
3. 外部调用方走 `client.beginXxx() / client.endXxx()` 这种带 TTY-gate + lazy view 创建的薄封装

## 通用不变量（view 一次性实现，所有 phase 自动继承，禁止在 phase 内重复处理）

- **100% 帧**：`completePhase` 在 `clearLines` 之前先调 `phase.forceComplete()` + `render()` 重渲一帧。即便最后一次 100ms tick 没赶上、或外部 stdout 写入污染了行追踪，这一帧也会替换掉残留的旧进度行
- **trailing `\n` + linesRendered**：`render()` 写每一行都以 `\n` 收尾，cursor 落在内容下方一行的列 0；`clearLines()` 用 `\x1b[1A` × `linesRendered` 上移再 `\x1b[J` 擦除
- **持久行外挂入口**：外部"持久输出"（`[PTY 已连接]`、日志路径等）必须经 `client.printAboveSyncProgress(...)` → `view.printPersistent(...)`，走"先擦 spinner、写持久行、再立即重渲 spinner"三步。**禁止直接 `process.stdout.write`**——会污染 `linesRendered` 行追踪
- **同时只一个 phase 在写 stdout**：view 持有 `currentPhase + pendingPhase`。并发 begin（如 cache sync 还在跑时 PTY 已连接）走 pending 队列，等当前 phase `complete` / `abort` 后由 `startNextPhase()` 自动激活。两个 phase 同时写 stdout 必然脏屏
- **TTY 隔离**：所有 spinner 入口（`handleCacheSyncProgress` / `beginStartupSpinner`）都 gate 在 `process.stdout.isTTY`；非 TTY/CI 直接跳过，避免 ANSI 控制序列污染管道
- **isIdle 守门**：view 只在所有 phase 都已结束（`isIdle()` 为 true）时才能 dispose；cache sync 与 pty-startup 交叠时不能粗暴 dispose

## 事件 / Phase 映射现状

| Phase | 进入事件 / API | 完成事件 / API | 成功行 |
|---|---|---|---|
| `scan` | `scan_start` | `scan_done` | `✓ 扫描 Claude 配置 (...)` |
| `upload` | `upload_start`（totalFiles > 0） | `upload_done`（非 aborted） | `✓ 同步完成 (...)` |
| `pty-startup` | `view.beginPtyStartup()` | `view.endPtyStartup()` | 无 |

## 测试约束

每加一个 phase，至少补三类回归：
1. 单 phase 跑通 + 100% 帧出现在成功行之前
2. 与现有 phase 并发时正确进 pending / 被激活 / 被丢弃
3. `printPersistent` 在该 phase 活跃期能正确"擦 → 写持久行 → 重渲"

参考实现：`client/test/ui-cache-progress.test.ts` 内 `pty-startup phase` 系列测试。

## 关联资源

- [架构总览](../README.md)
- [FileAgent & FUSE cache](./file-agent-cache.md)
