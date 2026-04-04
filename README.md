# Axon

Claude Code 的分体式架构：用户在 Hand 端交互，Hand 将思考委托给 Brain，Brain 推理完成后由 Hand 执行。

```
┌─────────┐  ┌─────────┐  ┌─────────┐
│  Hand 1 │  │  Hand 2 │  │ Hand N  │
│  用户交互│  │  用户交互│  │ 用户交互│
│  工具执行│  │  工具执行│  │ 工具执行│
└────┬─────┘  └────┬────┘  └────┬────┘
     │             │            │
     │    axon     │    axon    │      ← 传入：问题/工具结果
     │    relay    │    relay   │      ← 传出：思考/工具调用
     │             │            │
     └─────────┐   │   ┌───────┘
               ▼   ▼   ▼
         ┌─────────────────┐
         │      Brain      │
         │                 │
         │  Claude Code    │
         │  LLM 推理       │
         └─────────────────┘

（Hand 之间不互联，各自独立连接 Brain）
```

## 概念

**Axon**（轴突）— 神经纤维，在大脑与肢体之间双向传导信号。

- **Hand 端**：用户的交互入口，也是工具的执行环境。Hand 将问题发送给 Brain，收到指令后在本地执行
- **Brain 端**：纯思考服务，运行在容器中。接收 Hand 的输入，通过 Claude Code 完成 LLM 推理，返回工具调用指令
- **Relay**：Axon HTTP Server，Hand 与 Brain 之间的传导通道

Hand 可以随时加入或离开，动态连接到 Brain。Hand 之间互相隔离、不互联。

## 工作原理

```
Hand CLI/Web                Axon HTTP Server              Claude Code (容器内)
  │                              │                              │
  │ ── 用户输入 ───────────────→ │ ── ACP session/prompt ────→ │
  │                              │                              │
  │ ← 流式输出 (思考过程) ────── │ ← ACP session/update ────── │
  │                              │                              │
  │                              │     Claude Code 决定调用工具  │
  │                              │     PreToolUse Hook 拦截      │
  │                              │     Proxy → Unix Socket       │
  │                              │                              │
  │ ← 工具调用请求 ──────────── │ ← 工具请求 ──────────────── │
  │                              │                              │
  │  [本地执行]                  │                              │
  │                              │                              │
  │ ── 执行结果 ───────────────→ │ ── 结果返回 ──────────────→ │
  │                              │                              │
  │ ← 流式输出 (继续推理) ───── │ ← ACP session/update ────── │
```

**双通道设计**：聊天通道（ACP）传递用户输入和 LLM 输出；工具通道（Hook/Proxy）传递工具调用和执行结果。两条通道共享同一条 HTTP 长连接。

**Fallback**：Brain 容器内 Proxy 文件存在 → 拦截转发；用户本地直接启动 Claude Code → Proxy 不存在 → 本地执行。零配置降级。

**ACP Server**：Hand CLI 同时对外暴露 ACP 接口，编辑器（Zed、VS Code 等）可将其当作 Claude Code 使用，推理透明委托给远端 Brain。

## 当前状态

`proxy/` — 本地工具代理层（PreToolUse Hook 系统），可独立运行：

- `dispatch.sh` — Hook 入口，路由到各工具的代理脚本
- `lib.sh` — 共享工具函数（JSON 解析、Mock 数据、审计日志）
- `*.sh.example` — 代理脚本示例（重命名为 `*.sh` 即可激活）
- `settings.local.json.example` — Hook 注册配置

## 快速开始

```bash
# 1. 将 proxy 安装到目标项目
cp -r proxy/ /path/to/project/.claude/proxy/
cp proxy/settings.local.json.example /path/to/project/.claude/settings.local.json

# 2. 激活需要的代理脚本
cd /path/to/project/.claude/proxy/
cp Read.sh.example Read.sh
cp Bash.sh.example Bash.sh

# 3. 初始化 Mock 数据
bash init-proxy.sh

# 4. 重启 Claude Code
```

## Roadmap

| 阶段 | 内容 | 状态 |
|------|------|------|
| **Phase 0** | Proxy Hook 系统（工具拦截框架） | ✅ 已完成 |
| **Phase 1** | Proxy v2 — 远程执行中继（Unix Socket + Fallback） | 待开始 |
| **Phase 2** | Axon HTTP Server — Brain 核心（ACP + HTTP 长连接 + Session 管理） | 待开始 |
| **Phase 3** | Hand CLI 基础版（终端交互 + 本地工具执行） | 待开始 |
| **Phase 4** | Brain 容器化（Docker + Plugin 自动注入） | 待开始 |
| **Phase 5** | Hand CLI ACP Server（编辑器集成） | 待开始 |
| **Phase 6** | Hand Web（浏览器端） | 待开始 |
| **Phase 7** | 生产化（安全通道 / 认证 / Multi-Hand 调度） | 待开始 |

详细执行规划见 [.claude/ROADMAP.md](.claude/ROADMAP.md)

## License

MIT
