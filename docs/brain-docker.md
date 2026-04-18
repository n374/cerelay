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
│         └─ claude CLI (spawn)       │
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
| `CLAUDE_CONFIG_DIR` | `${HOME}/.claude` | 宿主机 Claude 配置目录挂载源 |
| `CLAUDE_JSON_PATH` | `${HOME}/.claude.json` | 宿主机 Claude 登录态文件挂载源 |

## 手动 Docker 命令 / Manual Docker Commands

```bash
# 构建镜像
docker build -t axon-brain:latest .

# 运行容器
docker run -d \
  --name axon-brain \
  -p 8765:8765 \
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

docker-compose 配置了 `claude_config` 卷挂载到容器内的 `/home/node/.claude`，用于持久化 claude CLI 的登录状态和配置，避免每次重启容器后重新认证。

此外还会把宿主机的 `~/.claude.json` 挂载到容器内 `/home/node/.claude.json`，因为部分 Claude Code 登录态存放在该文件中。

The docker-compose config mounts the host `~/.claude` directory to `/home/node/.claude` inside the container, and also mounts `~/.claude.json` to `/home/node/.claude.json`, because part of the Claude Code login state is stored in that file.

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
