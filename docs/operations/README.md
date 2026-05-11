<!-- doc-init template version: v1.0 -->
# Operations

> **Owner**: SRE / 运维组

## 1. SOP 索引

> 当前所有 SOP 都集中本目录；未启用就近留存（C 选项）。如未来某个代码包的 SOP 涉及代码内部不变式，按 doc-init AGENTS.md §10 判据决定是否就近，并在本表加索引。

| SOP | 文件 | 适用场景 |
|---|---|---|
| Brain 容器部署 | [`brain-docker.md`](./brain-docker.md) | Server（Brain）通过 Docker / Compose 部署；含 `cerelay-data` volume、SOCKS5 代理细节、多账号并列部署 |
| 项目路线图 | [`roadmap.md`](./roadmap.md) | 功能路线与阶段计划（历史与未来） |

## 2. 通用恢复指南

暂无独立 recovery.md；常见问题排查见 [`../../CLAUDE.md`](../../CLAUDE.md)「常见问题排查」段。

## 3. 监控与告警

> 当前 constitution 未触发 `docs/observability/` 制品。本地调试请用 `LOG_LEVEL=debug` + `LOG_JSON=true` 启动，详见 [`brain-docker.md`](./brain-docker.md) 调试段。

## 4. 发布流程

> 当前 constitution 未触发 `docs/release/` 制品。CI / 容器构建相关见 `Dockerfile` 与 `docker-compose.yml`。

## 5. 关联资源

- [架构总览](../architecture/README.md)
- [容器级 SOCKS5 代理模块](../architecture/modules/socks5-proxy.md)
- [项目宪法](../overview/constitution.md)
- [文档规约](../AGENTS.md)
