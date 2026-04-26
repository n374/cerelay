# Client 启动扫描优化设计

**日期**：2026-04-26
**作者**：Claude × Codex 共创
**状态**：已完成方案对齐，待实施

## 1. 背景与问题

cerelay Client 启动时会扫描 `~/.claude/` 并把内容同步到 Server 端缓存（`client-cache-store`），用作 FUSE 读穿透的本地副本。`runInitialSync` 包含两个阶段：

1. **scan**：递归 walk + 对每个变化文件 `readFile + sha256`
2. **upload**：通过 `cache_task_delta` pipeline 把内容推到 Server

实测在用户 `~/.claude/` = **1.0 GB / 22000 文件** 的环境下，scan 阶段约 **5 秒**。CPU 与 I/O 都被 sha256 + readFile 串行打满。

定位瓶颈后，根因有两个：

- **Sync 范围过宽**：`~/.claude/` 中混杂了大量"非 CC 启动需要"的内容（用户自建仓库、CC 内部按需读目录等），却被一并 hash 上传。
- **重复哈希**：每次启动若 Server 侧 manifest 缺失（首次 / cache 重建），所有文件都要重新 read + sha256，即使本地内容并未变化。

## 2. 目标

- 把启动 scan 时间从 ~5s 降到 **<1s**（默认配置下）
- 通过用户可读、可改的配置文件，让用户能进一步缩小同步范围
- 通过本地 manifest 缓存，避免重启时重复 hash 已知内容
- 在 scan 阶段提供两段式进度反馈，让用户清楚进度

## 3. 非目标

- 不改 server 协议（`CacheTaskDelta` / `CacheManifest` 格式不变）
- 不引入白名单（include-only）模式，YAGNI
- 不引入并发 read+hash —— scope 缩小后边际收益小，留待后续按需做
- 不动 `~/.claude.json` scope 处理（单文件，本来就快）

## 4. 范围与文件清单

### 新增

| 文件 | 职责 |
|---|---|
| `client/src/config.ts` | 加载 / 首次创建 `~/.config/cerelay/config.toml`，提供排除规则 matcher |
| `client/src/scan-cache.ts` | 本地 manifest 缓存（per `(deviceId, cwd)`），(size, mtime) → sha256 |
| `client/test/config.test.ts` | 单测：默认模板生成、解析失败降级、TOML 边界 |
| `client/test/scan-cache.test.ts` | 单测：hit/miss、损坏降级、原子写入、版本兼容 |

### 修改

| 文件 | 修改要点 |
|---|---|
| `client/src/cache-sync.ts` | `scanLocalFiles` 接收 `exclude` matcher；`buildScopePlan` 接收 `scanCache`；hash 命中复用 sha256；新增 `walk_done` / `hash_progress` 事件 |
| `client/src/cache-watcher.ts` | 同样接收 `exclude` matcher；与 initial scan 共享同一份规则 |
| `client/src/cache-task-state-machine.ts` | 装配 config + scanCache，向 watcher / buildScopePlan 透传 |
| `client/src/client.ts` | `connect()` 在 WebSocket open 后 await `loadConfig()`，传给 state machine |
| `client/src/ui.ts` | `CacheSyncProgressView` 扩展两段式渲染：walk-spinner → hash-progress |
| `client/test/cache-sync.test.ts` | 适配新参数；`tasks/.lock` 用例改成不依赖默认排除项的命名 |
| `client/test/cache-task-state-machine.test.ts` | 适配 config / scanCache 注入 |
| `client/package.json` | 新增依赖 `smol-toml` |

### 不动

- `server/` 任何文件（协议不变）
- `client/src/file-proxy.ts`、`client/src/protocol.ts`（协议不变）
- `MAX_FILE_BYTES` / `MAX_SCOPE_BYTES` / `MAX_INFLIGHT_BYTES` 常量

## 5. 配置文件

### 5.1 路径

- **位置**：`~/.config/cerelay/config.toml`
- **生成时机**：cerelay client 启动时如果文件不存在 → 写入下方 5.2 模板
- **后续修改**：cerelay 永远不动用户的 config 文件，即使升级也只在 changelog 里建议

### 5.2 默认模板

cerelay 首次启动时写入完整字面值（含注释）：

```toml
# Cerelay Client 配置文件
# 此文件由 cerelay 首次启动时自动生成；后续修改不会被覆盖。
# 修改后，下次启动 cerelay 生效。
#
# ============================================================
# 不熟悉 TOML 的话，先看这段语法说明
# ============================================================
# 1. 以 "#" 开头的行是注释，cerelay 不会读取它
# 2. 字符串必须用双引号包起来，例如：  "my-folder"
# 3. 数组里的元素用英文逗号 "," 分隔；最后一个元素后面也可以带逗号
# 4. 修改时请保留双引号和逗号，否则启动时会解析失败
#    （如果解析失败，cerelay 会忽略本配置并在日志里打印 warn）
# ============================================================


[scan]
# 启动时 cerelay 会扫描 ~/.claude/ 并把内容同步到 Server 端缓存。
# 列在 exclude_dirs 里的目录会被跳过；这些目录在 Server 缓存里
# 没有副本，但 Claude Code 第一次访问它们时 cerelay 会自动从你的
# 本机读取文件 —— 只是少了一次缓存加速，功能完全不受影响。
#
# ------ 怎么添加你想跳过的目录 ------
# 假如你想跳过 ~/.claude/my-folder/：
#
#   1. 在下面的 exclude_dirs = [ ... ] 数组里新增一行
#   2. 这一行写成        "my-folder",
#      （双引号包起来，结尾的逗号别忘）
#   3. 保存文件
#   4. 下次启动 cerelay 时生效
#
# ------ 怎么取消跳过某个目录 ------
# 找到对应那一行，要么直接删掉整行，要么在行首加上 "#" 把它注释掉。
#
# ------ 启用下方被注释掉的条目 ------
# 找到带 "# " 前缀的那一行（例如  # "cache",）
# 把行首的 "# " 删掉就是启用；保留就是不启用。

exclude_dirs = [
  # —— CC 启动时不读取（运行时按需访问，跳过完全安全）——
  "projects",        # 历史会话 JSONL，仅 /resume 时按需读
  "file-history",    # Edit 工具的文件备份
  "backups",         # .claude.json 的自动备份
  "paste-cache",     # paste 命令的中间文件
  "shell-snapshots", # 启动会写新文件，旧的不再读
  "telemetry",       # 遥测，写为主
  "todos",           # TodoWrite 工具状态
  "tasks",           # 任务锁文件

  # —— 用途不确定，CC 启动时可能读取（默认未启用，按需取舍）——
  # 启用方式：把行首的 "# " 删掉。如果启用后 CC 表现异常，
  #          把 "# " 加回去即可恢复。
  # "cache",         # CC 内部缓存（含更新检查 changelog）
  # "plans",         # 计划/笔记（多设备同步场景建议保留）
  # "session-env",   # 含 sessionstart-hook，启动时会执行
  # "sessions",      # 会话索引
  # "statsig",       # feature flags 缓存

  # —— 在下面添加你自己想跳过的目录 ——
  # 例如：
  # "my-folder",
]
```

模板字符串作为常量定义在 `config.ts`，既是首次写入内容，也是异常路径的 fallback 来源。

### 5.3 加载语义

| 场景 | 行为 |
|---|---|
| 文件不存在 | 写入模板字符串 → 解析模板 → 加载 |
| 写入文件失败（权限/磁盘） | log warn + 内存里临时加载模板里的 8 项默认；不持久化 |
| 文件存在但 TOML 解析失败 | log warn + 兜底使用模板里的 8 项默认 |
| 文件存在、解析成功、缺 `[scan]` 段 | 视为空配置（`exclude_dirs = []`），不补默认 |
| 文件存在、解析成功、`exclude_dirs = []` | 用户的明确意图，0 项排除，不补默认 |
| 文件存在、解析成功、`exclude_dirs` 含合法字符串数组 | 用文件值 |
| 字段类型错误（例如 `exclude_dirs = "string"`） | log warn + 兜底用模板里的 8 项默认 |

**关键设计**：唯一会"自动补默认"的两条路径是"文件不存在"（首次创建）和"用户改坏了"（损坏 fallback）；用户主动写的合法配置一律以文件为准。这样升级时不会"幽灵追加"新的默认条目。

### 5.4 排除规则匹配语义

- 排除项是相对 `~/.claude/` 的路径前缀（POSIX 形式，统一用 `/`）
- 必须按**目录边界**匹配：`exclude = "repos"` 命中 `repos/foo`、`repos`，但**不**命中 `reposx/`
- 实现：`(relPath: string) => boolean`，对每个 walk 出来的相对路径调用
- Watcher 也使用同一个 matcher 实例（防止 live 阶段把已排除目录的变更推回）

## 6. 扫描缓存

### 6.1 路径

- **目录**：`~/.config/cerelay/scan-cache/`
- **文件名**：`<deviceId>-<sha1(cwd)[:16]>.json`
- 与 server 端 `(deviceId, cwd)` 隔离键对称

### 6.2 文件格式

```json
{
  "version": 1,
  "scopes": {
    "claude-home": {
      "settings.json": { "size": 1234, "mtime": 1730000000000, "sha256": "abc..." },
      "commands/foo.md": { "size": 567, "mtime": 1730000000001, "sha256": "def..." }
    },
    "claude-json": {
      "": { "size": 36864, "mtime": 1730000000002, "sha256": "ghi..." }
    }
  }
}
```

`version` 用于将来格式迁移。读取时 `version !== 1` → log warn + 视为空缓存。

### 6.3 行为

**读取**：
- 启动时一次性同步读 + 解析，构建 in-memory `Map<scope, Map<relPath, entry>>`
- 文件不存在 → 空缓存
- 文件损坏（JSON 错、version 错、字段类型错）→ log warn + 空缓存

**hit 判定**：
```
hit(scope, relPath, localSize, localMtime)
  = cached?.size === localSize && cached?.mtime === localMtime ? cached.sha256 : null
```

**应用位置**：`buildUpsertChange` 中——
- 命中 → 复用 `sha256`，**仍需 `readFile`** 拿 `contentBase64`（plan 阶段无法判断 server 是否已有 blob）
- 未命中 → `readFile + createHash`，把结果写回 in-memory cache

主要节省：sha256 CPU（约 500MB/s，1GB 节省 ~2s）。`readFile` 在系统 page cache 命中时极快，不是瓶颈。

**写入**：
- 全部 `buildScopePlan` 完成后，**单次原子写**（写 `.tmp` + `rename`）
- 写入失败（权限/磁盘）→ log warn，不阻塞 sync 流程
- 不在 hash 过程中频繁 flush（避免 fsync 抖动）

**条目清理**：在写入前对每个 scope 的 cache 做一次清理——只保留本次 walk 出现过的 relPath，删除已不存在的条目（避免无限增长）

### 6.4 并发安全

- 单 client 进程内：state machine 串行，无 race
- 多进程同时跑（同 deviceId, 同 cwd，少见）：last-writer-wins，可接受。仅是性能加速缓存，丢失也只是下次重新 hash

## 7. 进度事件

### 7.1 现状

`CacheSyncEvent` 现有：`skipped` / `scan_start` / `scan_done` / `upload_start` / `file_pushed` / `file_acked` / `upload_done`

`scan_start` → `scan_done` 之间无任何粒度事件，UI 只能 spinner 显示"扫描中"。

### 7.2 扩展

新增两个事件（**追加，不破坏现有事件**）：

```ts
| { kind: "walk_done"; totalFiles: number }
| { kind: "hash_progress"; completedFiles: number; totalFiles: number }
```

发射时机与责任方：
- `scan_start`（不变）：`runInitialSync` 进入 scan 阶段时发
- `walk_done`：由 `runInitialSync` 协调发——拆开原本 `buildScopePlan` 的 walk + hash 两步：先对所有 scope 串行调用 `walkScope`（仅 readdir + stat），全部完成后聚合 `totalFiles` 并发 `walk_done`；然后再串行调用 `hashScope`（读 + hash）。这样 `walk_done.totalFiles` 是所有 scope 本地文件总和。
- `hash_progress`：由 `hashScope` 内部每完成一个文件发一次（包含 cache hit 跳过 hash 的情况，对 UI 而言"处理过的文件"才是用户视角的进度）。`completedFiles` / `totalFiles` 是跨 scope 累计值，由 `runInitialSync` 通过闭包注入计数器。
- `scan_done`（不变）：所有 scope hash 完成后发

API 调整：拆 `buildScopePlan` 为 `walkScope` + `hashScope` 两步导出，`buildScopePlan` 保留为薄 wrapper（先 walk 再 hash，给现有测试用）。

约束：
- `walk_done` 必须严格在所有 `hash_progress` 之前
- `hash_progress.totalFiles` 必须等于此前 `walk_done.totalFiles`
- 测试覆盖事件顺序

### 7.3 UI 渲染

`CacheSyncProgressView` 扩展状态机：

```
idle → scanning(walk) → scanning(hash) → done
       └─ scan_start    └─ walk_done     └─ scan_done
```

- `scanning(walk)`：单行 spinner + "扫描目录…" + 计时
- `scanning(hash)`：单行 spinner + 进度条 + "已 hash X/Y 文件" + 百分比
- `scan_done`：清行 + 一次性汇总输出（保持现有格式）

仅 TTY 启用，与现有逻辑一致。

## 8. 关键 API 草图

```ts
// config.ts
export interface ScanConfig {
  excludeDirs: string[];
}
export interface CerelayConfig {
  scan: ScanConfig;
}
export const DEFAULT_EXCLUDE_DIRS: string[];          // 模板里默认开启的 8 项
export const CONFIG_TEMPLATE: string;                 // 完整 TOML 模板字符串
export async function loadConfig(opts?: {
  configPath?: string;
}): Promise<CerelayConfig>;
export function createExcludeMatcher(
  excludeDirs: string[],
): (relPath: string) => boolean;

// scan-cache.ts
export interface ScanCacheEntry {
  size: number;
  mtime: number;
  sha256: string;
}
export interface ScanCacheStore {
  lookup(
    scope: CacheScope,
    relPath: string,
    size: number,
    mtime: number,
  ): string | null;
  upsert(scope: CacheScope, relPath: string, entry: ScanCacheEntry): void;
  pruneToPresent(scope: CacheScope, presentPaths: Set<string>): void;
  flush(): Promise<void>;
}
export async function openScanCache(args: {
  deviceId: string;
  cwd: string;
  configDir?: string;  // 默认 ~/.config/cerelay
}): Promise<ScanCacheStore>;

// cache-sync.ts —— 扩展点
export interface ScanOptions {
  exclude?: (relPath: string) => boolean;
  scanCache?: ScanCacheStore;
  onHashProgress?: () => void;  // hashScope 每完成一个文件调用一次
}
// 拆分两步导出
export async function walkScope(args: {
  scope: CacheScope;
  homedir: string;
  exclude?: (relPath: string) => boolean;
}): Promise<LocalEntry[]>;
export async function hashScope(args: {
  scope: CacheScope;
  locals: LocalEntry[];
  remote?: CacheManifestData;
  scanCache?: ScanCacheStore;
  onHashProgress?: () => void;
}): Promise<ScopePlan>;
// 现有 buildScopePlan 保留为薄 wrapper（walk + hash），向后兼容
```

## 9. 装配链路

```
client.ts:
  connect()
    → ws "open"
      → await loadConfig()                       // [新]
      → await openScanCache({deviceId, cwd})     // [新]
      → new CacheTaskStateMachine({
          config, scanCache, ...                 // [新参数]
        })
      → cacheTaskStateMachine.onConnected(send)

cache-task-state-machine.ts:
  handleActiveAssignment()
    → watcher = watcherFactory({exclude, ...})   // [新参数]
    → runInitialSync()
      → for scope: locals = walkScope({...})     // [新]
      → emit walk_done {totalFiles}              // [新]
      → for scope: plan = hashScope({locals, scanCache,
                                     onHashProgress}) // [新]
      → ... pipeline ...
      → scanCache.flush()                        // [新]
```

## 10. 失败降级矩阵

| 失败点 | 降级 |
|---|---|
| `loadConfig` 抛出（IO/解析） | log warn + 用模板 8 项默认；不阻塞 |
| 写入 config 文件失败 | log warn + 内存使用模板默认 |
| `openScanCache` IO 失败 | log warn + 返回 no-op store（lookup 永远 null、upsert/flush 静默） |
| Scan cache flush 失败 | log warn；下次启动重新 hash |
| `buildUpsertChange` 单文件失败 | 现有逻辑：throw → 状态机降级为 passive（不变） |

任何一项失败都不能阻塞 PTY 启动；FUSE 仍可回穿透读 Client。

## 11. 测试计划

### 11.1 单测

**`config.test.ts`**：
- 文件不存在 → 创建 + 加载，内容含 8 项默认
- 文件存在合法 TOML → 按文件值
- 文件存在但 TOML 语法错 → log warn，fallback 默认
- 文件存在，缺 `[scan]` 段 → 空 excludeDirs（**不**补默认）
- 文件存在，`exclude_dirs = []` → 空 excludeDirs（**不**补默认）
- 文件存在，`exclude_dirs = "string"` → log warn，fallback 默认
- 字符串数组含非字符串元素 → log warn，fallback 默认
- 创建文件时 fs.writeFile 抛出 → log warn，内存默认

**`scan-cache.test.ts`**：
- 文件不存在 → 空 store；lookup 返回 null
- 文件损坏（非 JSON / version 错 / 字段错） → log warn，空 store
- hit/miss 判定（size 变 / mtime 变 / 都不变）
- pruneToPresent：删除已不存在的 relPath
- flush 写入：tmp + rename 原子；并校验内容
- flush 失败：抛错被吞，不影响后续操作

**`createExcludeMatcher`**：
- 精确匹配：`"repos"` 命中 `"repos/foo"`、`"repos"`
- 边界正确：`"repos"` 不命中 `"reposx/y"`
- 多级路径：`"a/b"` 命中 `"a/b/c"`，不命中 `"a/bx"`
- 空数组 → 永远 false

### 11.2 cache-sync 测试更新

- `buildScopePlan` 接受 `exclude` matcher：被排除的路径不出现在 plan
- `buildScopePlan` 接受 `scanCache`：命中时复用 sha256，验证 cache 被正确 upsert
- 进度事件序列：`scan_start` → `walk_done` → `hash_progress`（多次）→ `scan_done`
- 现有 `tasks/.lock` 用例改成 mock excludeDirs 为空数组（不依赖默认排除）

### 11.3 cache-task-state-machine 测试更新

- 装配 config + scanCache 时不破坏现有状态转移
- watcher factory 接收到 exclude matcher
- runInitialSync 完成后 scanCache.flush 被调用一次

### 11.4 集成（手测 OK）

- 真实跑一次本机 client → 观测 scan 时间从 5s 降到 <1s
- 验证 `~/.config/cerelay/config.toml` 被正确创建
- 验证 `~/.config/cerelay/scan-cache/<deviceId>-<hash>.json` 被正确写入

## 12. 风险与已知限制

- **mtime 精度**：跨文件系统 mtime 精度不同（FAT32 2s、ext4 ns）。可能造成 cache miss，仅损失命中率不损正确性。
- **多进程并发**：同 (deviceId, cwd) 多进程同时跑会 last-writer-wins。罕见，可接受。
- **cache 无限增长**：通过 `pruneToPresent` 删除已不存在的 relPath；同一 (deviceId, cwd) 的 scope 范围内不会无限增长。但跨 cwd 会产生多个 cache 文件，目前不主动清理（理论上每个 cwd 一个文件，几 MB 量级，可接受）。
- **路径规范化**：必须统一 POSIX 形式。Windows 暂不在目标平台范围。
- **测试用 `tasks/` 路径名**：现有 `cache-sync.test.ts:390` 测试用了 `tasks/abc/.lock`，新方案下 `tasks` 默认在排除清单。需要把测试用例改成不依赖默认排除的命名（或显式传 `exclude=()=>false`）。

## 13. 性能预期

| 指标 | 当前 | 目标 |
|---|---|---|
| Scan 范围 | 1.0 GB / 22000 文件 | ~80 MB / ~1500 文件（默认排除后）|
| Scan 时间（冷启 + 默认排除） | 5s | <1s |
| Scan 时间（暖启 + 默认排除 + scan-cache 命中） | 5s | <500ms |
| 进度反馈 | 仅 spinner | walk-spinner → hash-progress 两段式 |

## 14. 不破坏的现有不变量

来自 `CLAUDE.md` "Filesystem access invariants"：
- FUSE 范围仍是 `~/.claude/`、`~/.claude.json`、`{cwd}/.claude/`
- Server 凭证仍在 `${CERELAY_DATA_DIR}/credentials/default/.credentials.json`
- `cerelay-data` named volume 持久化不变
- 排除目录在 server 侧 manifest 里没有副本，但 FUSE 读穿透 fallback 到 Client 仍然工作
