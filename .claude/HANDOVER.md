# Axon 交接文档 / Handover Document

> 最后更新：2026-04-05
> 上一次 Session 的完整提交历史见 `git log --oneline`

## 一、项目概述

Axon 是 Claude Code 的分体式架构：Hand（Go，用户交互+工具执行）↔ Axon Server（TypeScript，基于 Claude Agent SDK 的 Brain）↔ claude CLI（LLM 推理）。`internal/server/` 中的 Go Server 作为 fallback 保留。

## 二、已完成的工作（6 次提交）

| Commit | 内容 |
|--------|------|
| `f3d7f22` | Phase 0 Bash Hook 安全过滤系统 + 安全评审修复 11 项 |
| `81bfbd8` | ACP 可行性 POC（TypeScript，验证 SDK query/hooks/远程执行） |
| `00b8eae` | Go 基础层：ACP 协议（JSON-RPC 2.0）+ WebSocket 协议定义 |
| `1a97a28` | Axon Server + Hand CLI 完整 Go 实现 + 交叉验证修复 |
| `bf3b273` | 12 个集成测试 + README 重写 |
| `8b3dee8` | 选项 C：TypeScript Server + Claude Agent SDK 直接集成 |

## 三、核心架构决策：选项 C（SDK 直接集成）

### 背景

ACP 协议的 client-side methods（如 `fs/read_text_file`、`terminal/create`）并不是 claude CLI 的原生行为；它们本质上是 `claude-agent-acp` 在客户端侧对 Claude Agent SDK hooks 的包装。继续沿着 ACP bridge 或 Hook HTTP relay 往下做，只是在重复实现 SDK 已经原生提供的能力。

因此从方案 B 切换到选项 C：**Server 直接使用 `@anthropic-ai/claude-agent-sdk` 的 `query()` + `hooks.PreToolUse`**，消除以下四层间接：

1. `claude-agent-acp` 对 SDK hooks 的再封装
2. `dispatch.sh` 对 Hook JSON 的脚本转发
3. HTTP hookbridge 的阻塞式中继
4. `settings.json` / `settings.local.json` 的动态注入

### 选项 C 架构图

```
Hand CLI (Go)
  │
  │ WebSocket
  ▼
Axon Server (TypeScript)
  │
  │ query() + hooks.PreToolUse
  ▼
Claude Agent SDK
  │
  │ spawn / stream
  ▼
claude CLI

工具调用路径：
query() → hooks.PreToolUse → WS 发给 Hand → Hand 执行本地工具 → WS 返回结果 → hook return
```

### 关键要点

1. **主实现切换到 TypeScript Server**：核心目录是 `server/src/`，而不是 `internal/server/`
2. **工具拦截走 SDK hooks**：`hooks.PreToolUse` 在同进程内把 Claude 原生工具调用转成 WS `tool_call`
3. **Hand 执行 Claude 原生工具**：当前支持 `Read`、`Write`、`Edit`、`MultiEdit`、`Bash`、`Grep`、`Glob`
4. **Go Server 保留为 fallback**：`internal/server/` 仍可作为历史实现和备用路径
5. **Phase 0 Proxy 保留但降级为非主路径**：`proxy/` 的 relay 能力存在，但选项 C 不依赖它

## 四、选项 C 的代码结构

### 4.1 主路径代码

| 路径 | 作用 |
|------|------|
| `server/src/index.ts` | TypeScript Server 入口，解析 `--port` / `--model` |
| `server/src/server.ts` | HTTP + WebSocket Server，管理连接与 Session 生命周期 |
| `server/src/session.ts` | `query()` 驱动、多轮串行化、`hooks.PreToolUse` 工具拦截 |
| `server/src/relay.ts` | Promise-based ToolRelay，等待 Hand 返回工具结果 |
| `server/src/protocol.ts` | TypeScript 侧消息协议定义 |

### 4.2 Hand 端代码

| 路径 | 作用 |
|------|------|
| `cmd/hand/main.go` | Hand CLI 入口 |
| `internal/hand/client.go` | WebSocket 客户端、消息循环、UI 输出 |
| `internal/hand/executor.go` | 工具分发 |
| `internal/hand/tools_fs.go` | `Read` / `Write` / `Edit` / `MultiEdit` |
| `internal/hand/tools_bash.go` | `Bash` |
| `internal/hand/tools_search.go` | `Grep` / `Glob` |
| `internal/protocol/` | Go 侧协议与工具结果类型 |

### 4.3 保留组件

| 路径 | 当前状态 |
|------|----------|
| `internal/server/` | Go Server fallback，保留作为备用实现 |
| `internal/claude/` | 历史 stream-json 支撑代码，非当前主路径 |
| `proxy/` | Phase 0 Hook/审计系统保留，Axon relay 已实现但非主路径 |
| `internal/acp/` | 已删除 |

## 五、当前状态与维护边界

### 已完成

- 选项 C 主路径已落地：TypeScript Server + Claude Agent SDK + WebSocket Hand
- Go Hand 已适配 Claude 原生工具：`Read`、`Write`、`Edit`、`MultiEdit`、`Bash`、`Grep`、`Glob`
- 文本流、思考流、工具调用与结果回传已打通
- Go Server 保留为 fallback

### 已明确删除或不再需要

- HTTP hookbridge 不是选项 C 主路径
- `dispatch.sh` relay 不是选项 C 主路径
- `settings.json` / `settings.local.json` 生成不是选项 C 主路径
- ACP client-side methods 不再作为当前实现前提

## 六、测试 & 验证

- 已有 12 个集成测试和 Hand 工具测试覆盖 Go 侧主逻辑
- TypeScript Server 的主验证点是：`query()` 流式输出、`hooks.PreToolUse` 转发、WS 往返闭环
- 端到端验证仍需要实际可用的 `claude` CLI 与认证环境

## 七、用量监控

5h 用量 API：
```
curl -s 'https://viewer.crs.nerd.moe/api/accounts/1/usage?key=3779cb69-8fbd-4f14-a299-1badccfd46c0'
```
返回 JSON `data.five_hour.utilization`（百分比），超过 90% 应 sleep 到 `remaining_seconds` 后重置。

## 八、工作规范

详见 `~/.claude/CLAUDE.md` 和 `~/.claude/rules/` 下的规则文件。关键：
- 中文思考/回复
- 使用 Codex 交叉评审（决策类场景）
- Git commit 格式：`<gitmoji> [中英双语简述]`
- Go 版本：使用 `/opt/homebrew/bin/go`（1.26.1）
