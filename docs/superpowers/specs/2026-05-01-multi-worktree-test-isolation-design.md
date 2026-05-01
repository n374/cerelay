# Multi-Worktree 测试隔离设计

**日期**：2026-05-01
**作者**：Claude（Opus 4.7）× Codex（gpt-5-codex high）方案共创
**状态**：用户已批准，进入执行阶段

## 1. 背景与目标

Cerelay 有两条独立的并发使用路径：

- **常规调试**：用户在主仓库目录长开 `npm run server:up`（生产 compose，project name = `cerelay`，host port 8765）
- **测试**：用户用 git worktree 同时开发多个需求，每个 worktree 都可能跑 `npm test`（host 单测）和 `npm run test:container`（容器化套件）

当前实现存在多处硬编码导致并发会冲突，也没有自动 GC 残留资源。

### 目标

1. **server:up 零变动**：常规调试路径行为完全不变
2. **多 worktree 测试并发零冲突**：任意数量 worktree 同时跑 host 测试 + 容器测试都互不影响
3. **资源不堆积**：同分支重跑覆盖；分支删除后留下的孤儿资源在下次任意测试启动时被自动 GC

## 2. 客观约束

- 不动 `docker-compose.yml`、`docker-entrypoint.sh` 中影响生产 server 行为的部分
- 不引入新依赖（Node 内置 + shell 标准工具即可）
- 修改不得越过红线（破坏现有功能、改签名不改调用、幻觉修改、制造重复）
- 命名策略需兼容 detached HEAD（fallback 到 short SHA）

## 3. 冲突盘点（来源：双方独立 audit + 验证）

### 3.1 docker compose 层

| 位置 | 问题 |
|---|---|
| `docker-compose.test.yml: networks.cerelay-testnet.ipam.config.subnet=172.28.0.0/24` | 固定 bridge subnet，并发起冲突 |
| `docker-compose.test.yml` 5 处 `ipv4_address: 172.28.0.x` | 固定 IP |
| `docker-compose.test.yml: image: cerelay-test:latest` / `image: cerelay-socks-test:latest` | 显式 image tag，并发 build 互相覆盖 |
| `docker-compose.test.yml` env vars `CERELAY_SOCKS_TEST_BASE_URL=http://172.28.0.10:8765` 等 | 硬编码测试网络 IP |
| `docker-compose.test.yml: MOCK_SOCKS_CONNECT_MAP=203.0.113.10:8080=172.28.0.5:8080` | 依赖固定容器 IP |
| `docker-compose.test.yml: CERELAY_SOCKS_PROXY=socks5://172.28.0.2:1080`、`CERELAY_SOCKS_DNS_SERVER=172.28.0.4` | 同上 |
| `test/run-container-tests.sh: compose_cmd="docker compose -f docker-compose.test.yml"` | 未指定 `-p`，在主目录跑会与 server:up 共用 project name `cerelay`；多 worktree 并发也会撞 |
| `test/run-container-tests.sh: trap cleanup` 用 `down -v --remove-orphans` | orphan 概念在共享 project 下会误清 server:up 的容器 |

### 3.2 Host 测试侧

| 位置 | 问题 |
|---|---|
| `client/src/logger.ts: tmpdir() + "/cerelay-client.log"` | 默认日志路径在多个测试并发时被多写入者共享。`tmpdir()` 读 `TMPDIR` env，可通过 wrapper 隔离。 |
| `server/test/credentials-mount.test.ts` 等 4 处 `${tmpdir()}/prefix-${Date.now()}` | 同毫秒并发可能命名碰撞 |
| `client/test/client-connect-assembly.test.ts` 5 处 `homedir: "/tmp/cerelay-home"` | 当前未真实写盘（mock 拦了），预防性改 |

### 3.3 容器 fixtures 内 / 测试代码内

| 位置 | 问题 |
|---|---|
| `test/container-socks-integration.test.mjs` 默认值 `CERELAY_SOCKS_TEST_BASE_URL=http://172.28.0.10:8765` 等 | 与 compose 同步改为 service DNS |

### 3.4 验证后**不需要修复**的

- `server/test/mcp-cc-injection.test.ts` 里 `/tmp/test.sock`、`/tmp/x.sock`：纯字符串配置值，未真实 bind。
- `server/test/pty-tool-hook.test.ts` 里 `/tmp/cerelay-claude-pty-hook-test{,-root}`：纯字符串配置，未真实写。
- `server/test/pty-tool-relay-bug.test.ts` 里 `/tmp/mock-runtime-{cwd,root}` 等：mock 数据。
- 其他 `mkdtemp(os.tmpdir(), ...)` / `listen(0)` 已天然隔离。

## 4. 设计

### 4.1 命名策略：按分支 slug 稳定命名

```sh
# 所有测试入口共用的派生逻辑
branch=$(git symbolic-ref --short HEAD 2>/dev/null || echo "sha-$(git rev-parse --short HEAD)")
slug=$(echo "$branch" | tr -c 'a-zA-Z0-9' '_' | cut -c1-40)

COMPOSE_PROJECT_NAME="cerelay_test_${slug}"
HOST_TMP_ROOT="${TMPDIR:-/tmp}/cerelay-test-${slug}"
```

- **同分支重跑**：project name 稳定 → docker compose `--force-recreate` 自然覆盖容器/网络；image tag 也是 `<project>_<service>:latest` 稳定 → 重 build 覆盖同名 tag。**零堆积。**
- **不同 worktree**：分支不同 → slug 不同 → 资源天然隔离。
- **detached HEAD fallback**：`sha-<short>` 前缀，GC 不自动清理（避免误杀），需手动 `npm run test:gc:all`。

### 4.2 启动前 GC：清理已删分支的孤儿资源

每次 `run-container-tests.sh` / `run-host-tests.sh` 启动时**先跑 GC**，对比当前 git 仓库的活跃分支列表，清理任何"分支已不存在"的 cerelay_test_* 资源。

**清理范围**：

1. Docker compose project：所有 `cerelay_test_<slug>`，slug 不在 `git for-each-ref refs/heads/` 派生集合中 → `docker compose -p <project> -f docker-compose.test.yml down -v --rmi local --remove-orphans`
2. **Docker 孤儿 image**（关键补充）：测试 cleanup 只 `down` 容器/网络（保留 image cache 加速下次 build），项目一旦 down 之后 `docker compose ls` 看不到，对应的 `cerelay_test_<slug>-<service>:tag` image 会成为孤儿。GC 因此还要按 image repo 前缀扫描 + slug 比对清理（`docker rmi -f`）
3. Host tmp 目录：`${TMPDIR:-/tmp}/cerelay-test-<slug>` 同样比对清理
4. `sha-` / `sha_` 前缀的 detached HEAD 资源：**不自动清**，需手动 `--all`

**并发安全**：worktree A 启动时若 worktree B 的分支仍存在于 git，A 不会清理 B 的资源。git 的分支列表由 `.git/refs/heads/`（worktree 间共享）保证一致视图。

**实现位置**：单独的 `test/gc-test-resources.sh`，被 `run-container-tests.sh` 和 `run-host-tests.sh` source/调用，也可独立通过 `npm run test:gc` 手动执行。

### 4.3 跑完后温和释放

```sh
cleanup() {
  $compose_cmd down --remove-orphans >/dev/null 2>&1 || true
  # 注意：不带 -v --rmi。容器/网络收掉，image 留着供下次 build 复用 layer cache
}
trap cleanup EXIT INT TERM
```

- 容器、网络：跑完即收，零运行态占用
- image：留着，下次 build 命中 layer cache 飞快；同 tag 重 build 覆盖，不会增长
- volume：`docker-compose.test.yml` 不声明 named volume，只有 tmpfs（容器内存）+ read-only bind mount，**无累积**

### 4.4 网络去硬编码 + service DNS

`docker-compose.test.yml` 修改：

- 删除 `networks.cerelay-testnet.ipam` 整段（保留 `driver: bridge`）
- 删除每个 service 的 `ipv4_address`
- env vars 改用 service 名：
  - `CERELAY_SOCKS_TEST_BASE_URL=http://cerelay-socks-test:8765`
  - `CERELAY_SOCKS_TEST_WS_URL=ws://cerelay-socks-test:8765/ws`
  - `MOCK_SOCKS_ADMIN_URL=http://mock-socks:18080`
  - `MOCK_SOCKS_CONNECT_MAP=203.0.113.10:8080=egress-probe:8080`
  - `CERELAY_SOCKS_PROXY=socks5://mock-socks:1080`
  - `MOCK_DNS_IP` / `EGRESS_PROBE_IP` 改为 `MOCK_DNS_HOST=mock-dns` / `EGRESS_PROBE_HOST=egress-probe`（同步改 `test/container-socks-integration.test.mjs` 默认值）

#### 4.4.1 C2：cerelay-socks-test 的 entrypoint 同时解析 mock-dns 与 mock-socks 为 IP

sing-box 的 dns server address 与 outbound proxy server 字段如果用 hostname，会触发 `DNS query loopback in transport[remote-dns]`：sing-box 解析 hostname 需要 DNS，DNS 又走 `detour: proxy`，proxy 自己又得先解析 hostname → 死循环。

**修复**：cerelay-socks-test 服务包一层 entrypoint，在 exec docker-entrypoint.sh 之前把 `CERELAY_SOCKS_DNS_SERVER` 与 `CERELAY_SOCKS_PROXY` 中的 hostname 全部预解析为 IP（POSIX-pure shell parameter expansion，支持 `socks5://[user:pass@]host:port` 格式）。

```sh
# docker/test-entrypoint-socks-test.sh（新增）
# 解析 CERELAY_SOCKS_DNS_SERVER 中的 hostname → IP（含 scheme 兼容）
# 解析 CERELAY_SOCKS_PROXY 中的 hostname → IP（含 user:pass@ 兼容）
# exec /usr/local/bin/docker-entrypoint.sh "$@"
```

**注意**：`mock-socks` 的 `MOCK_SOCKS_CONNECT_MAP` 使用 hostname 已验证可行——`test/container-fixtures/mock-socks.mjs:111` 用 `net.createConnection(target)`，Node net 模块自动 DNS 解析 hostname。**不需要给 mock-socks 加 entrypoint**。

#### 4.4.2 显式 TUN 地址，避开 docker bridge auto-assigned subnet

`CERELAY_SOCKS_TUN_ADDRESS` 默认 `172.19.0.1/30`（在 `docker/socks-proxy-config.mjs:86`）。docker 自动分配的 bridge subnet 常落在 172.19.0.0/16 / 172.20.0.0/16 等同网段，**正好包含 TUN 地址**。

冲突后果：sing-box 启动 TUN（`auto_route: true, strict_route: true`）会把 mock-socks IP（也在 172.19.0.0/16）也吸进 TUN 形成 loopback → cerelay-server 的 monitor 第一次 cycle 探测 SOCKS proxy 即"不可达" → **误触发 fail-close**（实测 fail-close 测试 30s timeout 失败）。

**修复**：在 `docker-compose.test.yml` 的 `cerelay-socks-test` 服务里显式设置 `CERELAY_SOCKS_TUN_ADDRESS=192.168.255.1/30`，使用一个不会与 docker bridge 重叠的私有网段。

baseline（spec 改造前）用固定 subnet `172.28.0.0/24`，与 TUN 默认值 172.19.x 不冲突，所以隐式 work；改造后 docker 自动分配 subnet 才暴露此问题。

### 4.5 Image tag 去硬编码

删除 `docker-compose.test.yml` 中 `image: cerelay-test:latest` 和 `image: cerelay-socks-test:latest`。compose 自动按 `<project>_<service>:latest` 命名 build 产物。

`Dockerfile.test` 与 `Dockerfile` 不需改动。

### 4.6 Host 测试 wrapper：TMPDIR 隔离

新增 `test/run-host-tests.sh`：

```sh
#!/bin/sh
set -eu

. "$(dirname "$0")/test-env-common.sh"   # 派生 slug、HOST_TMP_ROOT 等

. "$(dirname "$0")/gc-test-resources.sh" # 启动前 GC

mkdir -p "$HOST_TMP_ROOT"
rm -rf "$HOST_TMP_ROOT"/*  # 同分支重跑覆盖
mkdir -p "$HOST_TMP_ROOT/data" "$HOST_TMP_ROOT/sockets" "$HOST_TMP_ROOT/namespace-runtime"

export TMPDIR="$HOST_TMP_ROOT"
export CERELAY_DATA_DIR="$HOST_TMP_ROOT/data"
export CERELAY_SHADOW_MCP_SOCKET_DIR="$HOST_TMP_ROOT/sockets"
export CERELAY_NAMESPACE_RUNTIME_ROOT="$HOST_TMP_ROOT/namespace-runtime"

npm run test:smoke
npm run test:workspaces
```

`package.json` 的 `test` script 改为 `sh ./test/run-host-tests.sh`。

**不加 EXIT trap rm**：保留 tmp 目录便于失败后排查；下次启动会覆盖。

### 4.7 Date.now() 命名升级

以下文件中的 `Date.now()`-only 临时目录命名升级为 `mkdtemp()` 或 `randomUUID()` 后缀：

- `server/test/credentials-mount.test.ts`：所有 `path.join(tmpdir(), \`...-${Date.now()}\`)` 改为 `mkdtemp(path.join(tmpdir(), "..."))`
- `server/test/pty-tool-relay-bug.test.ts`：临时目录 mkdtemp，sessionId 添加 randomUUID
- `server/test/claude-session-runtime.test.ts`：`runtime-preserve-${Date.now()}` → `runtime-preserve-${randomUUID()}`
- `client/test/logger-pty-mode.test.ts`：`cerelay-test-${Date.now()}.log` → `cerelay-test-${randomUUID()}.log`

### 4.8 client-connect-assembly.test.ts 预防性修复

5 处 `homedir: "/tmp/cerelay-home"` 改为 per-test `await mkdtemp(path.join(os.tmpdir(), "cerelay-home-"))`，afterEach `rm -rf`。当前不真实写盘，但消除将来变更的隐患。

## 5. 变更清单（最终）

| 文件 | 操作 | 摘要 |
|---|---|---|
| `package.json` | 修改 `scripts.test` | 改为 `sh ./test/run-host-tests.sh`；新增 `test:gc`、`test:gc:all` |
| `test/test-env-common.sh` | 新增 | 派生 branch/slug/COMPOSE_PROJECT_NAME/HOST_TMP_ROOT 的共享脚本，被其他入口 source |
| `test/gc-test-resources.sh` | 新增 | 启动前 GC 实现，支持 `--all` flag |
| `test/run-host-tests.sh` | 新增 | host 测试 wrapper，TMPDIR 隔离 + GC + 跑 smoke + workspaces |
| `test/run-container-tests.sh` | 修改 | source `test-env-common.sh` + `gc-test-resources.sh`；所有 compose 调用加 `-p $COMPOSE_PROJECT_NAME`；cleanup 改 `down --remove-orphans`（去掉 `-v`） |
| `docker-compose.test.yml` | 修改 | 删除 ipv4_address × 5、subnet 段、`image:` × 2；env vars 全部改 service DNS；cerelay-socks-test 加 `entrypoint` |
| `docker/test-entrypoint-socks-test.sh` | 新增 | 解析 `mock-dns` service 为 IP 后 export 注入 |
| `test/container-socks-integration.test.mjs` | 修改 | 默认 URL/IP 改为 service DNS（`cerelay-socks-test:8765` 等） |
| `server/test/credentials-mount.test.ts` | 修改 | `Date.now()` temp dir 改 `mkdtemp` |
| `server/test/pty-tool-relay-bug.test.ts` | 修改 | 同上 + sessionId 加 randomUUID |
| `server/test/claude-session-runtime.test.ts` | 修改 | `runtime-preserve-${Date.now()}` → randomUUID |
| `client/test/logger-pty-mode.test.ts` | 修改 | log file 命名改 randomUUID |
| `client/test/client-connect-assembly.test.ts` | 修改 | `homedir` 改 mkdtemp，afterEach 清理 |

**不需改动**：`docker-compose.yml`、`docker-entrypoint.sh`、`Dockerfile`、`Dockerfile.test`、`server/src/*`、`client/src/*`（含 logger.ts，因为 `os.tmpdir()` 已读 TMPDIR）

## 6. 验收

### 6.1 自验

```sh
# 主仓库长开 server:up
cd /Users/n374/Documents/Code/cerelay
npm run server:up
curl -fsS http://127.0.0.1:8765/health  # 必须 200

# 创建两个 worktree
git worktree add /tmp/wt-a HEAD -b test-iso-a
git worktree add /tmp/wt-b HEAD -b test-iso-b

# 并发跑全部测试
(cd /tmp/wt-a && npm test) &
(cd /tmp/wt-b && npm test) &
(cd /tmp/wt-a && npm run test:container) &
(cd /tmp/wt-b && npm run test:container) &
wait

# 期望：4 个并发任务全部 exit 0；server:up 健康未受影响
curl -fsS http://127.0.0.1:8765/health
docker network ls | grep cerelay_test  # 看到 2 个独立 network
docker compose ls | grep -c '^cerelay_test_test_iso_'  # 应为 2
```

### 6.2 GC 验收

```sh
# 制造孤儿资源
git checkout -b ghost-branch
npm run test:container
git checkout master
git branch -D ghost-branch
docker compose ls | grep ghost_branch  # 仍存在

# 触发 GC
npm run test:gc
docker compose ls | grep ghost_branch  # 应为空
ls /tmp/cerelay-test-ghost_branch 2>/dev/null  # 应不存在
```

### 6.3 同分支重跑验收

```sh
# 同分支跑 5 次，资源数不应增长
for i in 1 2 3 4 5; do npm run test:container; done
docker compose ls | grep -c "$(echo 'cerelay_test_'$(git symbolic-ref --short HEAD | tr -c a-zA-Z0-9 _))"
# 期望：1（不是 5）
```

## 7. 风险与回退

### 风险

1. **sing-box 对 hostname 不兼容**（已用 C2 entrypoint 解析为 IP 规避）
2. **getent hosts 在 alpine/distroless 行为差异**：项目现用 node:bookworm-slim 基底，`getent` 可用。如未来切基底需重测。
3. **GC 误杀**：仅清理 slug 不在 `git for-each-ref refs/heads/` 的资源；新建分支后立即跑测试不会被清。
4. **同分支并发**（用户在同 worktree 内手动 `npm test &; npm run test:container &`）：compose `--force-recreate` 在两个并发 up 之间会互相打架。**不在本次范围**——用户场景是 worktree 间并发，单 worktree 内串行。

### 回退

每个改动相互独立，回退不需要协调：

1. `package.json: scripts.test` 恢复 → host 测试回到原样
2. 删除 `test/run-host-tests.sh`、`test/gc-test-resources.sh`、`test/test-env-common.sh`
3. `test/run-container-tests.sh` 恢复
4. `docker-compose.test.yml` 恢复 ipv4_address / image tag / 硬编码 env
5. 删除 `docker/test-entrypoint-socks-test.sh`
6. 单测内 mkdtemp/randomUUID 改动逐文件恢复

`docker-compose.yml`、生产代码全程未触碰，server:up 永远不受影响。
