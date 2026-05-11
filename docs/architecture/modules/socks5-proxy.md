<!-- doc-init template version: v1.0 -->
# 容器级 SOCKS5 代理 / Container-level SOCKS5 Proxy

> **Owner**: 运维组
> **Reviewers**: server 架构组

**模式**：sing-box TUN + `nftables`，fail-closed。

- 启用：`CERELAY_SOCKS_PROXY=socks5://user:pass@host:port` 或紧凑格式 `host:port[:user:pass]`
- DNS：默认 TCP 上游解析（不依赖代理 UDP）；`CERELAY_SOCKS_UDP=block` 可严格 fail-closed
- 多账号：透明代理是**容器级**而非 session 级，多账号应部署多个并列容器（独立 `COMPOSE_PROJECT_NAME` + 独立 `cerelay-data` volume）
- 依赖 Linux 容器能力：`NET_ADMIN`、`/dev/net/tun`、`nftables`

容器化部署完整指南见 [`../../operations/brain-docker.md`](../../operations/brain-docker.md)。

## 相关环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CERELAY_SOCKS_DNS_SERVER` | `1.1.1.1` | TUN 模式下走代理解析的上游 DNS |
| `CERELAY_SOCKS_UDP` | `forward` | UDP 策略：`forward` 继续放行，`block` 显式拒绝非 DNS UDP |
| `CERELAY_SOCKS_TUN_ADDRESS` | `172.19.0.1/30` | sing-box TUN 地址段 |
| `CERELAY_SOCKS_TUN_MTU` | `9000` | sing-box TUN MTU |

## 关联资源

- [容器部署指南](../../operations/brain-docker.md)
- [架构总览](../README.md)
