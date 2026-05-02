# F4 Cross-CWD FileProxy Isolation 设计

**日期**:2026-05-02
**作者**:Claude(Opus 4.7)× Codex(gpt-5.4-codex)方案共创
**状态**:待用户批准

## 1. 背景与目标

Cerelay e2e 综合测试套件 P1-B 阶段落地的 `F4-same-device-multi-cwd` case(`test/e2e-comprehensive/orchestrator/phase-p1.test.ts:1098`)只守了 3 条**浅层不变量**:sessionId 唯一、`pty.spawn.ready detail.cwd` 字段对齐、同 client 共享 deviceId。case 注释明确写道 fileProxy / FileAgent / cwd-ancestor walk / project-claude bind mount 这 4 条 **cross-cwd 隔离深度不变量**"需要独立的 fileProxy admin event probe……本 PR 范围不展开,留作 P2 加固"(`phase-p1.test.ts:1085-1094`)。

本 spec 设计 P2 case `F4-cross-cwd-fileproxy-isolation`,把 4 条深度不变量补全。这是已实现功能的覆盖加固,**不依赖产品侧任何新功能**,不属于 §2.3 P2 backlog 的 H1/H2(等产品功能)那一类。

### 目标

1. 守 4 条 cross-cwd 隔离不变量((a) fileProxy 三 root 内容不串 / (b) per-device 共享 cache 命中污染 / (c) cwd-ancestor walk 不串 / (d) project-claude bind mount 严格按 session cwd)
2. 测试 honest:不绕被守护路径(P0-B Codex 终审教训:案例名对得上 matrix,断言走 client 本地直读,根本没经过被守护路径)
3. 不改 FileAgent / FileProxyManager / bind mount 核心逻辑,只加 emit / probe / 测试编排
4. P0/P1-A/P1-B 已落地 26 个 case 必须保持绿

## 2. 客观需求规格(三处事实纠偏后)

> Codex 独立审查发现初版规格里有 3 处与代码现状不符的事实错误,这里按代码现状重新表达。

### 4 条不变量(精确表达)

| 不变量 | 表达 |
|---|---|
| **(a) fileProxy 三 root 内容不串** | 同 deviceId 下两并发 session、不同 cwd,各自访问 `home-claude` / `home-claude-json` / `project-claude` 时,server 不能把 session A 的 cwd 子树内容回给 session B 的 read 请求。**注意**:同 client 两并发 session 共享 `$HOME` 和 deviceId,home root **不是** per-cwd 内容空间——守的是"home root 不被 project cwd 子树污染" + "per-device cache 命中不因另一 cwd 访问返回错内容",**不是** "home 内容按 cwd 隔离" |
| **(b) FileAgent / 共享 cache 命中污染** | FileAgent 与 FileProxyManager 共享 per-device `ClientCacheStore`(`server/src/file-proxy-manager.ts:101-106`),manifest + blob 池跨 cwd 共享。session A 的访问预热的 cache,session B 命中时不能把 A 的 cwd-bound 内容当成 B 的内容返回 |
| **(c) cwd-ancestor walk 不串(受限)** | `computeAncestorChain(cwd, homeDir)` 从 cwd 逐级向上(`path-utils.ts:17-27`),`ConfigPreloader.buildPrefetchItems`(`config-preloader.ts:116-131`)按链拼 PrefetchItem,bootstrap env `CERELAY_ANCESTOR_DIRS` 同源(`claude-session-runtime.ts:250-252`)。**当前代码守不住"真实 ancestor FUSE read 不串"**——`FileProxyManager.roots` 没注册 `cwd-ancestor-N`(详见 §8 INF-12)。本 case 只守"计算计划不串台":session A 的 ancestorDirs 不含 session B cwd 子树 |
| **(d) project-claude bind mount 严格按 session cwd** | `FileProxyManager.roots["project-claude"]` 构造时固化 `path.join(this.clientCwd, ".claude")`(`file-proxy-manager.ts:258/261`),bootstrap `mount --bind "$CERELAY_FUSE_ROOT/project-claude" "$CERELAY_WORK_DIR/.claude"`(`claude-session-runtime.ts:327-329`)。每个 session 独立 namespace + 独立 runtimeRoot UUID 目录。守的是 race / state 串台不发生 |

### 三处规格事实纠偏

| # | 初版规格描述 | 实际代码状态 | 影响 |
|---|---|---|---|
| 1 | "daemon sideband emit 的 shadow.served / write.served 顶层 sessionId === null" | `FileProxyManager.handleFuseLine` 转录 sideband event 用 `this.sessionId`(`file-proxy-manager.ts:1561/1571/1577`),sessionId **已正确绑定** | 不需要修 daemon sideband sessionId,只补 detail 里的 `clientCwd / clientPath` 即可 |
| 2 | "(c) 应靠真实 FUSE read 守 cwd-ancestor walk" | `FileProxyManager.roots` 只注册 3 个 root,**没有 `cwd-ancestor-N`**(`file-proxy-manager.ts:258/261`),但 daemon(`fuse-host-script.ts:451/568/634`)和 bootstrap(`claude-session-runtime.ts:331-348`)都引用了该 root 形态 | (c) 只能守"计算计划不串台",不能守"真实 ancestor FUSE read"——后者需要先注册 root,挂 INF-12 跟踪 |
| 3 | "(a) home-claude 在两个 cwd 间内容不串" | 同 client 两并发 session 共享 $HOME 和 deviceId(`agent/index.ts:180/183/298`),home root 不是 per-cwd 内容空间 | (a) 措辞重新表达(见上表) |

### 约束 / 红线

- 测试栈必须容器化 e2e(`test/e2e-comprehensive/`),不能降级单测 mock
- 不改 FileAgent / FileProxyManager 核心读写 / cache 命中策略 / bind mount 实现,只加 emit / probe
- 不改 P0/P1-A/P1-B 已落地 26 case 行为
- emit 必须 fire-and-forget + `CERELAY_ADMIN_EVENTS=true` gate(参考 P1-B PR1 INF-1 daemon `emit_event` sideband 处理)
- 不需要考虑历史兼容:可自由改 admin event detail schema、orchestrator helper 接口、daemon sideband detail 字段

## 3. 现状关键代码位置

| 维度 | 文件 / 位置 | 说明 |
|---|---|---|
| 现有 F4 case | `test/e2e-comprehensive/orchestrator/phase-p1.test.ts:1098` | 只 3 条浅层断言,P2 加固注释 :1085-1094 |
| Admin event base type | `server/src/admin-events.ts:8-32` | 顶层 sessionId 已是 `string \| null`,`AdminEventBuffer.record` 接受任意 detail |
| FileProxy read.served emit 出口 | `server/src/file-proxy-manager.ts:968` (snapshot-client) / `:1181` (snapshot-cache) / `:1255` (runtime cache) / `:1911` (settings passthrough) | 4 处统一 emit,detail 缺 cwd |
| FileProxy client.requested emit | `:1699` / `:1703` | 穿透 client 前 emit,detail 缺 cwd |
| FileProxy sideband 转录 | `:1561-1577` | 用 `this.sessionId` 绑定,sessionId 已正确,detail 缺 cwd |
| FileProxy 三 root 注册 | `:258-261` | 只有 home-claude / home-claude-json / project-claude |
| FileProxy 共享 ClientCacheStore 注释 | `:101-106` | 与 FileAgent 共享 manifest / blob |
| FileProxyManager runtime cache lookup | `:1205-1255` | `tryServeReadFromCache` 命中后 emit `servedFrom:"cache"` |
| FileAgent per-device 单例池 | `server/src/server.ts:108` / `:859-901` | `Map<deviceId, FileAgent>`,跨 cwd 共享 |
| FileAgent.read 命中查找 | `server/src/file-agent/index.ts:105-107` | 只查 `(deviceId, scope, relPath)`,无 cwd 维度 |
| ClientCacheStore 注释 | `server/src/file-agent/store.ts:1-11` | manifest+blob per-device,不按 cwd 分区 |
| computeAncestorChain | `server/src/path-utils.ts:17-27` | 从 cwd 逐级向上至 homeDir,不含 homeDir 和 fs root |
| ConfigPreloader.buildPrefetchItems | `server/src/config-preloader.ts:101/116/131` | 按 ancestor 链拼 CLAUDE.md / CLAUDE.local.md PrefetchItem |
| Runtime env 注入 ancestor | `server/src/claude-session-runtime.ts:247/250/252/256` | `CERELAY_WORK_DIR / CERELAY_VIEW_ROOTS / CERELAY_ANCESTOR_DIRS / CERELAY_FUSE_ROOT` |
| project-claude bind mount | `claude-session-runtime.ts:327-329` | bootstrap `mount --bind` |
| ⚠ cwd-ancestor-N daemon 引用 | `server/src/fuse-host-script.ts:451/568/634` | 已识别该 root 形态 |
| ⚠ cwd-ancestor-N bootstrap 引用 | `claude-session-runtime.ts:331/348` | 尝试 bind mount ancestor CLAUDE.md |
| ⚠ cwd-ancestor-N 缺 server 注册 | `file-proxy-manager.ts:258/261` | 半成品(挂 INF-12) |
| INF-11 namespace exec | `server/src/server.ts:554/571` + orchestrator `server-events.ts:447/451/469/476` | `serverExec.run(sessionId, {command, args})` honest 触发 namespace 内 FUSE op |
| Orchestrator fileProxyEvents | `test/e2e-comprehensive/orchestrator/server-events.ts:96/111/124/139/151` | 现有 helper 缺 cwd 过滤 / 缺 negative-assert |
| Multi-session 并发拓扑 | `phase-p1.test.ts:1119/1125/1165/1170` | F4 P1 已用 `Promise.all` 并发起两个 `runAsync` |
| Fixture 写入 | `test/e2e-comprehensive/orchestrator/fixtures.ts:8/15/27` | `writeFixture` / `cleanupFixture` |
| Home fixture | `test/e2e-comprehensive/agent/index.ts:211/218` | `homeFixture` 写到 client `$HOME` |

## 4. 双方独立方案摘要(阶段 1)

按 `~/.claude/rules/review-workflow.md` 流程,Claude × Codex 在阶段 1 并行独立产方案。

**Claude 方案要点**(主 context):
- 4 条不变量都做(用户拍板范围 = A)
- admin event detail 加 cwd 维度
- FileAgent 加 emit
- 1 个综合 case + INF-11 `serverExec.run` probe
- 5 处补强:emit gate + contentHash 强信号 + negative-assert timeout 锚点 + session B 主动触发对方 cwd 访问 + meta failure 回归

**Codex 方案要点**(`/Users/n374/Documents/Code/cerelay/.claude/codex-f4-design.md`):
- 三处事实纠偏(daemon sessionId / cwd-ancestor 半成品 / 共享 home)
- 不变量 (c) 降级:只守计算计划,标记 cwd-ancestor-N root 注册产品缺口
- 1 个综合 case + 父目录下兄弟 cwd fixture 拓扑
- 4 类断言:stdout 正负 marker / event sessionId+cwd 对齐 / negative-assert "since baseline 后无 sessionId=B 且 clientPath 跨 cwdA 的事件" / config-preloader plan probe

**收敛**:Codex 三处事实纠偏被完整接受,Claude 5 处补强被完整接受。无重大方案分歧。

## 5. 共识方案(阶段 2)

### 5.1 基础设施改动清单

#### server/src/admin-events.ts

顶层结构不变。`AdminEventBuffer.record` 已支持任意 detail。

#### server/src/file-proxy-manager.ts

4 处 read.served emit 出口统一加 detail 字段:
- `clientCwd: string`(本 session 的 cwd)
- `clientPath: string`(client 端实际物理路径,= `path.join(rootPath, relPath)`)
- `contentSha256?: string`(可选,但本 spec 定义的 F4 探针 case 走的 read 路径必须填——见 §5.4 contentSha256 细则)

涉及 emit 出口:
- `:968` (snapshot-client)
- `:1181` (snapshot-cache)
- `:1255` (runtime cache)
- `:1911` (settings passthrough)

`client.requested` emit(`:1699/1703`)同样加 `clientCwd / clientPath`,否则无法证明 session B 没有请求 session A 的 cwd 子树。

`shadow.served` / `write.served` 由 sideband 转录(`:1561-1577`),server 端补 `clientCwd / clientPath`(daemon 不需要改 sessionId 处理)。

**emit 实现约束**:
- fire-and-forget(同步路径不阻塞)
- gate 到 `CERELAY_ADMIN_EVENTS=true`(生产路径零开销)
- 字段缺失时 emit 退化为可选记录(参考 P1-B PR1 INF-1 处理)

#### server/src/config-preloader.ts

新增 admin event:`config-preloader.plan`

emit 位置:`buildPrefetchItems` 完成后(`:116/131` 附近)

detail:
```typescript
{
  sessionId: string;
  clientCwd: string;
  homeDir: string;
  ancestorDirs: string[];
  prefetchAbsPaths: string[];
}
```

#### server/src/server.ts

新增 admin event:`session.bootstrap.plan`

emit 位置:session 创建期间(`:1145/1204` 附近,`createClaudeSessionRuntime` 调用前后)

detail:
```typescript
{
  sessionId: string;
  deviceId: string;
  clientCwd: string;
  runtimeRoot: string;
  fileProxyMountPoint: string;
  projectClaudeBindTarget: string;
}
```

#### server/src/fuse-host-script.ts

sideband shadow read/write detail 加 `fusePath`(原始 FUSE 路径,server 转录时反查 cwd 用)。**不**改 sessionId 处理(server 端已正确)。

普通 read **不**新增 emit(走 server 端 client.requested / read.served 即可)。

#### test/e2e-comprehensive/orchestrator/server-events.ts

- 扩 TS detail interface(`FileProxyReadServedDetail` / `FileProxyClientRequestedDetail` 加 `clientCwd? / clientPath? / contentSha256?`;`FileProxyShadowServedDetail` / `FileProxyWriteServedDetail` 加 `clientCwd? / fusePath?`,**不**加 `clientPath` 与 `contentSha256`——shadow/write 由 daemon sideband 转录,原始路径只有 FUSE 物理路径,以 `fusePath` 替代 `clientPath`;且断言矩阵(§5.3 阶段三)只用 `read.served` 的 contentSha256 做 negative-assert 强信号,shadow/write 的 sha256 无消费方,YAGNI 不加)
- 现有 `findReadServed` / `waitForReadServed` 等 helper 增加 `clientCwd?` 过滤参数
- 新增 `assertNoReadServedForCwd({ since, sessionId, foreignCwd, timeoutMs? })`:**poll-and-collect 模式**——在 timeoutMs 内收集所有匹配 event(`sessionId === sessionId && isUnderDir(clientPath, foreignCwd)`，严格按目录分隔符判断：path === foreignCwd 或 path 以 foreignCwd + "/" 开头),断言 count === 0。timeoutMs 锚点见 §5.4
- 新增 `configPreloaderEvents.findPlan({ sessionId, since })` / `waitForPlan(...)`
- 新增 `sessionBootstrapEvents.findPlan({ sessionId, since })`
- 新增 `assertF4CrossCwdIsolation({ sessionA, sessionB, cwdA, cwdB, since })` 公共断言,失败时 dump 完整 fileProxy + config-preloader + session.bootstrap probe 摘要

### 5.2 Fixture 与拓扑

```
test/e2e-comprehensive/fixtures/case-f4-cross/
├── CLAUDE.md                                ← 共同祖先 marker "ANCESTOR_SHARED"
├── a/                                       ← session A cwd
│   ├── .claude/
│   │   ├── project-marker.txt               ← "PROJECT_A_ONLY"
│   │   └── settings.local.json              ← {"f4":"SETTINGS_A_ONLY"}
│   └── CLAUDE.md                            ← "ANCESTOR_A_ONLY"(cwd-local)
└── b/                                       ← session B cwd
    ├── .claude/
    │   ├── project-marker.txt               ← "PROJECT_B_ONLY"
    │   └── settings.local.json              ← {"f4":"SETTINGS_B_ONLY"}
    └── CLAUDE.md                            ← "ANCESTOR_B_ONLY"
```

Home fixture(共享 $HOME):
```
$HOME/.claude/f4-home-marker.txt              ← "HOME_SHARED_EXPECTED"
$HOME/.claude.json                            ← {"f4":"HOME_JSON_SHARED_EXPECTED"}
```

容器拓扑:**复用 client-a**,通过 `clients.runAsync("client-a", {prompt, cwd: cwdA})` + `clients.runAsync("client-a", {prompt, cwd: cwdB})` 真并发起两 session(F4 P1 已验证可行)。

### 5.3 Case 编排骨架

文件:`test/e2e-comprehensive/orchestrator/phase-p2.test.ts`(新建)

```typescript
test("F4-cross-cwd-fileproxy-isolation", async () => {
  await mockAdmin.reset();
  // mock 一个简单 final response,避免 CC 跑工具
  await mockAdmin.loadScript({ ... });

  const baseline = await adminEvents.lastEventId();
  const cwdA = "/fixtures/case-f4-cross/a";
  const cwdB = "/fixtures/case-f4-cross/b";

  // 并发启动两 session
  const [runA, runB] = await Promise.all([
    clients.runAsync("client-a", { prompt: PROMPT, cwd: cwdA }),
    clients.runAsync("client-a", { prompt: PROMPT, cwd: cwdB }),
  ]);

  const spawnA = await ptyEvents.findSpawnReady({ expectedCwd: cwdA, since: baseline });
  const spawnB = await ptyEvents.findSpawnReady({ expectedCwd: cwdB, since: baseline });

  // === 阶段一:正向 probe 触发各 root read(serverExec.run 在 namespace 内) ===
  // session A 读各 root
  const aProject = await serverExec.run(spawnA.sessionId, {
    command: "cat", args: [`${cwdA}/.claude/project-marker.txt`],
  });
  const aHome = await serverExec.run(spawnA.sessionId, {
    command: "cat", args: ["/root/.claude/f4-home-marker.txt"],
  });
  const aHomeJson = await serverExec.run(spawnA.sessionId, {
    command: "cat", args: ["/root/.claude.json"],
  });
  const aSettings = await serverExec.run(spawnA.sessionId, {
    command: "cat", args: [`${cwdA}/.claude/settings.local.json`],
  });
  // session B 同理

  // === 阶段二:负向 probe(B 主动尝试访问 A 子树,验跨 namespace 不可见) ===
  const bAttemptA = await serverExec.run(spawnB.sessionId, {
    command: "cat", args: [`${cwdA}/.claude/project-marker.txt`],
    expectFailure: true,
  });
  // 期望:cat 失败 + stdout 不含 PROJECT_A_ONLY

  // === 阶段三:断言 ===
  // (1) stdout 正/负 marker
  assert(aProject.stdout.includes("PROJECT_A_ONLY"));
  assert(!aProject.stdout.includes("PROJECT_B_ONLY"));
  // ... B 同理

  // (2) read.served event sessionId+cwd 对齐
  const readEvA = await fileProxyEvents.waitForReadServed({
    root: "project-claude", sessionId: spawnA.sessionId, since: baseline,
  });
  assert.strictEqual(readEvA.detail.clientCwd, cwdA);

  // (3) negative-assert:since baseline 后没有 sessionId=B 且 isUnderDir(clientPath, cwdA) 的 event
  //      isUnderDir 严格按目录分隔符：path === cwdA 或 path 以 cwdA + "/" 开头，避免 /proj/a 误匹配 /proj/ab
  await assertNoReadServedForCwd({
    sessionId: spawnB.sessionId, foreignCwd: cwdA, since: baseline, timeoutMs: 500,
  });

  // (4) ConfigPreloader plan 不串台
  const planA = await configPreloaderEvents.findPlan({ sessionId: spawnA.sessionId, since: baseline });
  assert(!planA.detail.ancestorDirs.some(p => isUnderDir(p, cwdB)));
  assert(!planA.detail.prefetchAbsPaths.some(p => isUnderDir(p, cwdB)));

  // (5) session.bootstrap plan project-claude bind 严格按 cwd
  const bootA = await sessionBootstrapEvents.findPlan({ sessionId: spawnA.sessionId, since: baseline });
  assert.strictEqual(bootA.detail.projectClaudeBindTarget, `${cwdA}/.claude`);

  // (6) 公共断言(综合 dump)
  await assertF4CrossCwdIsolation({ sessionA: spawnA, sessionB: spawnB, cwdA, cwdB, since: baseline });

  // 收尾(参考 phase-p1.test.ts:247/258/1075 killAndVerifyExited)
  await killAndVerifyExited(runA);
  await killAndVerifyExited(runB);
});
```

### 5.4 关键细则

#### contentSha256 字段

- `read.served` detail 的 `contentSha256` 标记为 **可选**;本 case 走的所有 read 路径必须填(测试期间触发的 read 涉及的文件都小,sha256 计算成本可忽略)
- 实现方式:server 端在 emit `read.served` 时,对返回给 daemon 的 response bytes 同步计算 `crypto.createHash("sha256").update(bytes).digest("hex")` 后塞入 detail。daemon 不参与计算。计算只在 `CERELAY_ADMIN_EVENTS=true` gate 内执行,生产路径零开销
- 用途:negative-assert 强信号——session B 的 read.served 中不出现"contentSha256 = sha256(cwdA fixture content)"。fixture content sha256 在 fixture 写入时由测试编排预先计算并保存,断言时直接对比

#### negative-assert timeout 锚点

- `assertNoReadServedForCwd` 的 timeoutMs **不固定**,锚定到"所有 probe 命令完成后 + 500ms safety margin"
- 实现方式:case 编排里所有 `serverExec.run` 都 `await` 完成,随后进 negative-assert,内部 poll 500ms,期间收集所有匹配 event,超时后断言 count === 0
- 防 CI 抖动假阴(参考 P1-B PR1 G1 200ms→1000ms 的教训)

#### Session B 主动访问对方 cwd 子树

- 见 §5.3 阶段二
- 必要性:如果 session B 没访问任何东西,自然没事件,negative-assert 假阳通过
- 实现:`serverExec.run` `cat ${cwdA}/.claude/project-marker.txt`,期望 cat 失败(跨 namespace 不可见)+ 无任何 read.served event 反映 cwdA 子树

#### Meta failure 回归 case

- 文件:`test/e2e-comprehensive/orchestrator/phase-p2-meta.test.ts`(新建,沿用 P0 `phase-p0-meta.test.ts` 的反向断言模式)
- 内容:mock 一个"故意串台"的状态(用 admin test-toggle 让 FileProxyManager 把两个 session 错挂同一 project-claude root),断言 `assertF4CrossCwdIsolation()` **期望 throw**
- 防 helper 自身退化成"什么都过"

## 6. 守护意图自查

| 反模式 | 是否中招 | 防御机制 |
|---|---|---|
| 测试代码绕被守护路径 | ❌ 不中 | 所有内容读取经 `serverExec.run` 在 namespace 内执行(`server-events.ts:447-452` 注释明确为 honest 触发 FUSE 入口) |
| 用 `pty.spawn.ready detail.cwd` 替代 fileProxy 隔离证明 | ❌ 不中 | P1 已覆盖该层,P2 必须用 `serverExec.run` + read.served event detail.clientCwd 双重证据 |
| 用 `/admin/cache lookupEntry` 替代 runtime read | ❌ 不中 | cacheAdmin lookupEntry 只查 manifest 摘要,不能证明 runtime 用了该内容。本 case 用 read.served `servedFrom:"cache"` event |
| Negative-assert 用 absence-of-log | ❌ 不中 | poll-and-collect 模式,在 timeout 内收集所有匹配 event 后断言 count === 0 |
| Session B 没主动访问就 negative-assert | ❌ 不中 | §5.4 强制 session B 阶段二主动 cat A 子树 |
| Helper 自身退化通过 | ❌ 不中 | §5.4 meta failure case 反向期望 throw |
| (c) 守不住真实 ancestor read 但伪装能守 | ⚠ 诚实声明 | 文档明确(c)只守计算计划,真实 FUSE read 守不住,挂 INF-12 跟踪 |

## 7. PR 拆分

### PR 1:基础设施(observability + helper)

scope:
- `server/src/admin-events.ts`(若需要类型扩展)
- `server/src/file-proxy-manager.ts` read.served / client.requested / sideband 转录加 cwd 字段
- `server/src/config-preloader.ts` 新增 plan event
- `server/src/server.ts` 新增 session.bootstrap.plan event
- `server/src/fuse-host-script.ts` sideband detail 加 fusePath
- `test/e2e-comprehensive/orchestrator/server-events.ts` 扩 detail interface + cwd 过滤 + negative-assert + plan helper
- `assertF4CrossCwdIsolation` 公共断言

红线:**不改** FileProxyManager / FileAgent / bind mount 核心逻辑(尤其不改 `tryServeReadFromCache`(`:1205/1227`)、`rootToCacheScope`(`:2038`)、per-device FileAgent 单例策略(`server.ts:859/900`))。

验收:P0/P1-A/P1-B 26 case + meta 3 case + server unit 425/425 全过。

### PR 2:测试 case 落地

scope:
- `test/e2e-comprehensive/orchestrator/phase-p2.test.ts`(新建)F4-cross-cwd-fileproxy-isolation case
- `test/e2e-comprehensive/orchestrator/phase-p2-meta.test.ts`(新建)meta failure 回归 case
- `test/e2e-comprehensive/fixtures/case-f4-cross/`(新建)fixture 树
- `test/run-e2e-comprehensive.sh` / `test/run-e2e-comprehensive-meta.sh` npm test 入口扩(若需要新加 phase-p2)
- `docs/e2e-comprehensive-testing.md` §2.3 P2 backlog 升级 F4-cross-cwd-fileproxy-isolation 为 ✅ 落地;§10 change log 补条目;§12 P1-B 章节追加 P2 闭环登记

验收:e2e 26 → 27/27 全过(若 meta 也算入则 28/28),meta 3 → 4/4。

## 8. INF-12 跟踪条目(产品缺口)

`cwd-ancestor-N root 在 server 端缺注册`。

**现状**:
- daemon `fuse-host-script.ts:451/568/634` 已识别该 root 形态
- bootstrap `claude-session-runtime.ts:331/348` 已尝试 bind mount ancestor CLAUDE.md
- server `file-proxy-manager.ts:258/261` `FileProxyManager.roots` 只注册 3 个 root,**未注册** `cwd-ancestor-N`

**含义**:`read /cwd-ancestor-N/CLAUDE.md` 这条 FUSE 路径在当前代码下走不到底(daemon 问 server "这个 root 映射到哪",server 答不出来)。

**影响**:本 P2 case 不变量 (c) 只能守"计算计划不串台",不能守"真实 ancestor FUSE read"。

**修复方向(等独立需求开)**:
1. 先调研产品意图:为什么之前 server 没注册?是漏掉了,还是有意为之(性能 / 安全 / 某个边界 case)? `git log -- server/src/file-proxy-manager.ts` + `git log -- server/src/fuse-host-script.ts` 演化历史
2. 若是漏掉:`FileProxyManager` 构造时用 `computeAncestorChain` 算祖先链,逐级注册成 `cwd-ancestor-${i}` root
3. 修后:本 P2 case 不变量 (c) 升级为"真实 ancestor FUSE read 不串"——fixture 用嵌套子树,断言 walk 不下降到对方 cwd 子树

**跟踪位置**:`docs/e2e-comprehensive-testing.md` §2.3 P2 backlog 同步加跟踪条目;本 spec 作为 anchor。

**优先级**:用户已表态"后面会有单独的需求去修",本 P2 case 落地不阻塞此 INF-12。

## 9. 验收标准

PR 1 验收:
- [ ] e2e 26/26 全绿(P0 16 + P1-A 2 + P1-B 8)
- [ ] meta 3/3 全绿
- [ ] server unit 425/425 全绿
- [ ] client unit 135/135 全绿
- [ ] typecheck 全绿
- [ ] Codex 终审通过(0 critical / important 全修)

PR 2 验收:
- [ ] e2e 27/27 全绿(P0 16 + P1-A 2 + P1-B 8 + P2 1)
- [ ] meta 4/4 全绿(P0 3 + P2 1)
- [ ] 上述 server / client unit / typecheck 同步全绿
- [ ] Codex 终审通过

整体验收:
- [ ] §6 守护意图自查全部 ❌ 不中(除诚实声明的 (c) 受限)
- [ ] `docs/e2e-comprehensive-testing.md` §2.3 P2 backlog 中 `F4-cross-cwd-fileproxy-isolation` 行从 🅿️ 加固待补 升级为 ✅ 落地

## 10. 相关引用

- `~/.claude/rules/review-workflow.md`(Claude × Codex 方案共创流程)
- `docs/e2e-comprehensive-testing.md` §2.3 / §11 / §12(P0/P1/P2 矩阵 + Codex 终审遗留 + P1-B 切分)
- `.claude/codex-f4-design.md`(Codex 独立方案完整版,含 file:line 引用)
- `~/.claude/CLAUDE.md` 红线禁令 1 / 2 / 4 / 5(不破坏现有功能 / 不仅改签名 / 不制造重复 / 不盲目执行)
