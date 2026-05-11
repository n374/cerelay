<!-- doc-init template version: v1.0 -->
# Mount Namespace 隔离 / Session Runtime

> **Owner**: 架构组
> **Reviewers**: server 维护者

**文件**：`server/src/claude-session-runtime.ts`、`server/src/pty-session.ts`

- 默认启用（`CERELAY_ENABLE_MOUNT_NAMESPACE=true`）
- 为每个 Session 创建隔离的文件系统视图
- Claude 看到的 `HOME` 和 `cwd` 对齐 Client 上报的路径
- 使用 `unshare` / `nsenter` 实现

## Filesystem access invariants

详见 [`../../../CLAUDE.md`](../../../CLAUDE.md) 「Filesystem access invariants」段，本节是简要复述（**以 CLAUDE.md 为权威源**）：

- CC 启动后的 `cwd` 字符串必须等于 Client 启动目录；从 CC 与 Client 两侧看，当前目录路径应一致
- 用户文件访问必须走被 hook 拦截的工具调用（`Bash`、`Read`、`Write`、`Edit`、`MultiEdit`、`Grep`、`Glob`），并在 Client 本机执行；不要通过 FUSE 把项目目录或 Client 根目录映射给 CC
- FUSE file proxy 只允许 Claude 配置范围（`~/.claude/`、`~/.claude.json`、`{cwd}/.claude/`）；项目源码、cwd 上级目录、系统其他路径的访问能力来自 Client-routed tools
- `settings.local.json` 必须继续作为项目级 hook 配置注入到 `{cwd}/.claude/settings.local.json`
- Server 侧凭证必须作为 `home-claude/.credentials.json` shadow file 暴露给 runtime，且读写、truncate 都应作用在 Server 侧本地凭证文件

## 凭证存放位置

凭证的真实存放位置为 `${CERELAY_DATA_DIR:-/var/lib/cerelay}/credentials/default/.credentials.json`（由 docker-compose 的 `cerelay-data` named volume 持久化）。首次启动文件不存在是允许的——CC `login` 会通过 FUSE create 创建该文件；shadow file 映射必须**总是注入**，不得因为文件不存在就跳过，否则写入会穿透到 Client 侧，违反隔离约束。

## Data 目录

Data 目录（`${CERELAY_DATA_DIR:-/var/lib/cerelay}`）还用于存放 Client 文件同步缓存（`client-cache/<deviceId>/`），禁止把业务数据写到容器根文件系统其他位置。

## Login-state 字段 redaction

`~/.claude/settings.json` 中的"登录态字段"——`env.ANTHROPIC_BASE_URL` / `env.ANTHROPIC_API_KEY` / `env.ANTHROPIC_AUTH_TOKEN` / 顶层 `apiKeyHelper`——必须经 `server/src/claude-settings-redaction.ts` 在 server → CC 出口处过滤后才能进入 namespace。三处出口（启动期 snapshot 预热 / 运行时 cache 命中 / 运行时 Client 穿透）**必须全部 redact**，不得依赖 Client 侧清洁。

Client 端 settings.json 原文不变、cache blob 也保留 Client 原文不过滤，过滤只发生在 server → namespace 最后一公里；这样 Client 改动经 cache delta 同步后再次读取仍然是过滤版。

详见 [`../../archive/2026-04-30-shadow-claude-settings-redaction/design.md`](../../archive/2026-04-30-shadow-claude-settings-redaction/design.md)。

> **`~/.claude.json` 中的同类字段（`apiKeyHelper` / `oauthAccount` 等）暂不过滤** / not yet handled，后续若发现实际泄漏再扩展，参考 spec §9.1。

## 典型调用

```typescript
// 关键调用位置：session.ts 中的 createSessionRuntime()
const runtime = new ClaudeSessionRuntime({
  cwd: request.cwd,
  home: request.home,
});
```

## 关联资源

- [架构总览](../README.md)
- [Shadow MCP & Hook 拦截](./shadow-mcp.md)
- [FileAgent & FUSE cache](./file-agent-cache.md)
- [项目宪法](../../overview/constitution.md)
