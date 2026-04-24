# Brain 容器化部署指南 / Brain Docker Deployment Guide

## 概述 / Overview

Axon Brain（即 Axon Server）可通过 Docker 打包为独立的可分发运行环境。Hand CLI 通过 WebSocket 连接到容器化的 Brain，无需在本地安装 Node.js、claude CLI 或任何服务端依赖。

Axon Brain (the Axon Server) can be packaged as a standalone distributable runtime via Docker. The Hand CLI connects to the containerized Brain via WebSocket, requiring no local Node.js, claude CLI, or server-side dependencies.

## 架构说明 / Architecture

```
Hand CLI (本地 / local)
  │
  │ WebSocket ws://host:8765/ws
  ▼
┌─────────────────────────────────────┐
│         Docker 容器                  │
│                                     │
│  docker-entrypoint.sh               │
│    └─ axon-server (Node.js)         │
│         └─ claude CLI (per-session) │
│              └─ mount namespace     │
│                                     │
│  EXPOSE 8765                        │
└─────────────────────────────────────┘
```

## 快速启动 / Quick Start

### 1. 准备环境变量

```bash
cp .env.example .env
# 编辑 .env，填入 ANTHROPIC_API_KEY
# 或者使用 ANTHROPIC_AUTH_TOKEN（如有需要可同时配置 ANTHROPIC_BASE_URL）
```

### 2. 启动 Brain 容器

```bash
# 构建并后台启动
docker compose up -d --build

# 查看日志
docker compose logs -f axon-brain

# 检查健康状态
curl http://localhost:8765/health
```

### 3. 连接 Hand CLI

```bash
# Hand CLI 默认连接 localhost:8765
cd hand
npm start

# 指定远程 Brain 地址
npm start -- --server 192.168.1.100:8765
```

## 配置项 / Configuration

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `ANTHROPIC_API_KEY` | 可选 | Anthropic API Key |
| `ANTHROPIC_AUTH_TOKEN` | 可选 | Claude / Anthropic 鉴权 Token |
| `ANTHROPIC_BASE_URL` | 可选 | 自定义 Anthropic 兼容 API Base URL |
| `PORT` | `8765` | 容器内监听端口 |
| `MODEL` | `claude-sonnet-4-20250514` | 使用的 Claude 模型 |
| `BRAIN_HOST_PORT` | `8765` | 宿主机映射端口（仅 docker-compose） |
| `CLAUDE_CONFIG` | 空 | claude CLI 额外配置（JSON 字符串） |
| `CLAUDE_CREDENTIALS` | 空 | 可选：首次 seed 的登录凭证 JSON 字符串（会写入 Data 目录） |
| `CERELAY_DATA_DIR` | `/var/lib/cerelay` | 容器内持久化数据目录（挂载自 `cerelay-data` volume） |
| `AXON_ENABLE_MOUNT_NAMESPACE` | `true` | 是否启用 per-session mount namespace runtime |
| `AXON_NAMESPACE_RUNTIME_ROOT` | `/opt/axon-runtime` | 容器内 session runtime 根目录 |

## 手动 Docker 命令 / Manual Docker Commands

```bash
# 构建镜像
docker build -t axon-brain:latest .

# 运行容器
docker run -d \
  --name axon-brain \
  -p 8765:8765 \
  --cap-add SYS_ADMIN \
  -e ANTHROPIC_API_KEY=your-key \
  # 或者 / Or:
  # -e ANTHROPIC_AUTH_TOKEN=your-auth-token \
  # -e ANTHROPIC_BASE_URL=https://your-anthropic-compatible-endpoint \
  axon-brain:latest

# 查看日志
docker logs -f axon-brain

# 停止
docker stop axon-brain
docker rm axon-brain
```

## 数据持久化 / Persistence

docker-compose 通过 named volume `cerelay-data` 把 `/var/lib/cerelay` 持久化。该目录结构如下：

- `/var/lib/cerelay/credentials/default/.credentials.json` —— 默认用户的 Claude Code 登录凭证；首次启动为空，用户通过 Client 发起 `claude login` 之后由 FUSE shadow file 写入并保留。
- `/var/lib/cerelay/client-cache/<deviceId>/<cwdHash>/` —— 预留给 Client 文件同步缓存（按设备 ID + 工作目录路径隔离）。

与早期版本不同，**不再** bind-mount 宿主机 `~/.claude/.credentials.json` 或 `~/.claude.json` 到容器。凭证由容器自己管理、由 volume 持久化。

The docker-compose config uses a named volume `cerelay-data` to persist `/var/lib/cerelay`. The `credentials/default/.credentials.json` file is populated by Claude Code login (via FUSE shadow file) and survives container restarts. Unlike earlier versions, the host `~/.claude` is no longer bind-mounted into the container.

此外，默认 compose 配置会启用 per-session mount namespace runtime。每次创建 session 时，Brain 会在容器内创建独立的 Claude runtime，并把 Hand 上报的 `HOME` / `cwd` 视图投影进去，再在该 runtime 中启动 Claude Code。

This setup also enables a per-session mount namespace runtime by default. For each session, Brain creates an isolated Claude runtime, projects the Hand-reported `HOME` / `cwd` view into it, and launches Claude Code inside that runtime.

## 文件访问与 Hook 约束 / Filesystem and Hook Invariants

- CC 启动时的工作目录路径必须等于 Hand/Client 上报的 `cwd`，例如 Client 在 `/repo/app` 启动时，CC 内部 `pwd` 也应显示 `/repo/app`。
- 用户文件系统访问必须通过 `PreToolUse` hook 转发到 Client 执行。`Bash`、`Read`、`Write`、`Edit`、`MultiEdit`、`Grep`、`Glob` 应使用 Client 的真实 cwd 和真实绝对路径语义。
- 不要把 Client 的项目根目录、Client 根目录或宿主机 `/` 通过 FUSE/bind mount 暴露给 CC。项目源码、cwd 上级目录和其他系统路径的读写能力来自 Client-routed tools。
- FUSE file proxy 只投影 Claude 运行配置：`~/.claude/`、`~/.claude.json`、`{cwd}/.claude/`，其中 `{cwd}/.claude/settings.local.json` 必须保留用于注入 Axon 的 `PreToolUse` hook。
- Server 侧凭证必须以 `home-claude/.credentials.json` shadow file 形式出现在 runtime 中；读、写、truncate 都必须落到 `${CERELAY_DATA_DIR}/credentials/default/.credentials.json`，而不是转发给 Client。首次启动凭证文件可为空，CC `login` 时由 FUSE create 创建——因此 shadow file 映射必须**总是注入**，不得因为文件不存在而跳过。

## Namespace 前置条件 / Namespace Prerequisites

- 容器需要 `SYS_ADMIN` capability
- 镜像内需要 `util-linux`，以提供 `unshare` / `nsenter`
- 登录凭证由 `cerelay-data` volume 持久化，不再需要从宿主机挂载 `~/.claude`

如果这些条件不满足，可以把 `AXON_ENABLE_MOUNT_NAMESPACE=false`，Brain 会回退到普通目录 runtime。

If these requirements are not available, set `AXON_ENABLE_MOUNT_NAMESPACE=false` and Brain will fall back to a plain directory runtime.

## 健康检查 / Health Check

Brain 容器在 `/health` 路径暴露 HTTP 健康检查端点：

```bash
curl http://localhost:8765/health
# 返回: {"status":"ok","time":"2026-04-05T00:00:00.000Z"}
```

## 远程部署 / Remote Deployment

若 Brain 部署在远程服务器，Hand CLI 通过以下方式连接：

```bash
# 直接 WebSocket 连接（需要开放端口）
axon-hand --server your-server.com:8765

# 通过 SSH 隧道（推荐，更安全）
ssh -L 8765:localhost:8765 user@your-server.com -N &
axon-hand --server localhost:8765
```

## 文件说明 / File Locations

| 文件 | 说明 |
|------|------|
| `Dockerfile` | 多阶段构建：Node.js + claude CLI + axon-server |
| `docker-compose.yml` | 完整 compose 配置，含健康检查和日志限制 |
| `docker-entrypoint.sh` | 容器入口：环境验证 + 启动 server |
| `.env.example` | 环境变量模板 |

## 变更历史 / Change History

| 日期 | 变更 |
|------|------|
| 2026-04-05 | Phase 3 初始版本 |
