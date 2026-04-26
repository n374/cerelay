# ACP 编辑器集成指南 / ACP Editor Integration Guide

## 概述 / Overview

Cerelay Hand 支持以 ACP（Agent Communication Protocol）stdio 模式启动，让编辑器（Zed、VS Code 等）可以将 Cerelay 作为 Claude Code 使用。

ACP 使用 JSON-RPC 2.0 协议，通过标准输入/输出与编辑器通信。

Cerelay Hand supports running in ACP stdio mode, allowing editors (Zed, VS Code, etc.) to use Cerelay as Claude Code via the ACP protocol. ACP uses JSON-RPC 2.0 over stdin/stdout.

## 启动 ACP Server / Starting ACP Server

```bash
# 连接本地 Brain
cerelay-hand acp --server localhost:8765 --cwd /your/project

# 连接远程 Brain
cerelay-hand acp --server brain.example.com:8765 --cwd /your/project
```

## 协议说明 / Protocol Reference

### 消息格式

每条 JSON-RPC 消息占一行（以 `\n` 分隔）。服务器发出的通知和响应同样是单行 JSON。

### 初始化 / Initialize

**请求：**
```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"my-editor","version":"1.0.0"}}}
```

**响应：**
```json
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","serverInfo":{"name":"cerelay-hand","version":"0.1.0"},"capabilities":{"streaming":true,"multiSession":true,"tools":["Read","Write","Edit","MultiEdit","Bash","Grep","Glob"]}}}
```

### 创建会话 / Create Session

**请求：**
```json
{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/path/to/project","model":"claude-sonnet-4-20250514"}}
```

**响应：**
```json
{"jsonrpc":"2.0","id":2,"result":{"sessionId":"sess-1234567890-uuid"}}
```

### 发送 Prompt / Send Prompt

发送后，服务器会通过通知推送流式内容，最终返回 `result`。

**请求：**
```json
{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"sess-1234567890-uuid","prompt":"帮我分析这个项目的结构"}}
```

**流式通知（text）：**
```json
{"jsonrpc":"2.0","method":"$/textChunk","params":{"sessionId":"sess-1234567890-uuid","text":"这个项目使用..."}}
```

**流式通知（工具调用）：**
```json
{"jsonrpc":"2.0","method":"$/toolCall","params":{"sessionId":"sess-1234567890-uuid","toolName":"Read","requestId":"hook-xxx","input":{"file_path":"/path/to/file"}}}
```

**最终响应：**
```json
{"jsonrpc":"2.0","id":3,"result":{"sessionId":"sess-1234567890-uuid","result":"分析完成..."}}
```

### 取消任务 / Cancel

```json
{"jsonrpc":"2.0","id":4,"method":"session/update","params":{"sessionId":"sess-1234567890-uuid","action":"cancel"}}
```

### 关闭会话 / Close Session

```json
{"jsonrpc":"2.0","id":5,"method":"session/close","params":{"sessionId":"sess-1234567890-uuid"}}
```

## 通知列表 / Notification List

| 方法 | 触发时机 | 参数 |
|------|---------|------|
| `$/textChunk` | Claude 输出文本 | `{sessionId, text}` |
| `$/thoughtChunk` | Claude 内部思考 | `{sessionId, text}` |
| `$/toolCall` | 工具调用开始 | `{sessionId, toolName, requestId, input}` |
| `$/toolCallComplete` | 工具调用完成 | `{sessionId, toolName, requestId}` |

## 错误码 / Error Codes

| 错误码 | 含义 |
|--------|------|
| `-32700` | JSON 解析失败 |
| `-32600` | 无效请求 |
| `-32601` | 方法不存在 |
| `-32602` | 参数无效 |
| `-32603` | 内部错误 |
| `-32001` | Session 不存在 |
| `-32002` | Session 正忙（上一个 prompt 未完成） |
| `-32003` | 工具执行失败 |

## Zed 配置示例 / Zed Configuration Example

在 Zed 的 `settings.json` 中：

```json
{
  "assistant": {
    "provider": {
      "type": "claude",
      "model": "claude-sonnet-4-20250514"
    },
    "acp_server": {
      "command": "cerelay-hand",
      "args": ["acp", "--server", "localhost:8765", "--cwd", "/your/project"]
    }
  }
}
```

## VS Code 配置示例 / VS Code Configuration Example

在 `.vscode/settings.json` 中：

```json
{
  "claude.acp.command": "cerelay-hand",
  "claude.acp.args": ["acp", "--server", "localhost:8765"],
  "claude.acp.cwd": "${workspaceFolder}"
}
```

## 调试 / Debugging

ACP Server 将调试日志写入 `stderr`，不影响 `stdout` 的 JSON-RPC 流：

```bash
# 查看调试输出
cerelay-hand acp --server localhost:8765 2>acp.log
```

## 文件说明 / File Locations

| 文件 | 说明 |
|------|------|
| `hand/src/acp/protocol.ts` | ACP JSON-RPC 协议类型定义 |
| `hand/src/acp/server.ts` | ACP stdio 服务器实现 |
| `hand/src/acp/index.ts` | ACP 命令入口 |

## 变更历史 / Change History

| 日期 | 变更 |
|------|------|
| 2026-04-05 | Phase 4 初始版本 |
