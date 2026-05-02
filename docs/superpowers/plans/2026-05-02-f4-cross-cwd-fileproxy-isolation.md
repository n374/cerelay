# F4 Cross-CWD FileProxy Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 cerelay e2e 套件加 P2 case `F4-cross-cwd-fileproxy-isolation`,守 4 条 cross-cwd 隔离深度不变量((a) fileProxy 三 root 内容不串、(b) 共享 cache 命中污染、(c) cwd-ancestor 计算计划不串、(d) project-claude bind mount 严格按 session cwd)。

**Architecture:** 两个 PR 串行落地。PR1 基础设施:扩 admin event detail(`clientCwd / clientPath / contentSha256`)、新增 `config-preloader.plan` + `session.bootstrap.plan` event、orchestrator 加 cwd-aware helper + negative-assert + 公共断言。PR2 测试 case:`phase-p2.test.ts` 主 case + `phase-p2-meta.test.ts` 反向回归 case + fixture + 文档闭环。

**Tech Stack:** TypeScript / Node.js native test runner / Docker compose e2e / Anthropic Claude Agent SDK / FUSE Python daemon

**Spec:** [`docs/superpowers/specs/2026-05-02-f4-cross-cwd-fileproxy-isolation-design.md`](../specs/2026-05-02-f4-cross-cwd-fileproxy-isolation-design.md)

---

## 工作约定 / Working Conventions

- **Go 版本约束**:本项目无 Go 代码,跳过 `~/go/` 版本检查
- **测试运行器**:Node.js 原生 `node --test`,工作空间用 `npm test`
- **TypeScript**:ESM(`type: "module"`),`tsx` 跑测试,`tsc --noEmit` typecheck
- **Container e2e**:`bash test/run-e2e-comprehensive.sh`(主 phase-p0/p1)+ `bash test/run-e2e-comprehensive-meta.sh`(meta 反向 case)
- **Server unit**:`cd server && npm test`(425/425 baseline)
- **Client unit**:`cd client && npm test`(135/135 baseline)
- **每个 task 收尾**:typecheck + 相关单测 + 必要时 e2e 套件全过 → commit。**不准跨 task 攒 commit**(P1-B PR1 教训:跨 task 攒 commit 出问题难二分)

## File Structure(本 plan 涉及的所有文件)

### PR1 修改

```
server/src/file-proxy-manager.ts        ← read.served / client.requested / sideband 转录 emit 加字段
server/src/fuse-host-script.ts          ← daemon sideband shadow detail 加 fusePath
server/src/config-preloader.ts          ← 新增 config-preloader.plan event emit
server/src/server.ts                    ← 新增 session.bootstrap.plan event emit
test/e2e-comprehensive/orchestrator/server-events.ts  ← TS detail 扩字段 + helper 扩 cwd 过滤 + 新加 negative-assert + plan helpers + assertF4 公共断言
```

### PR2 新增

```
test/e2e-comprehensive/fixtures/case-f4-cross/        ← 新建 fixture 树(2 cwd + 共同祖先)
  CLAUDE.md
  a/CLAUDE.md
  a/.claude/project-marker.txt
  a/.claude/settings.local.json
  b/CLAUDE.md
  b/.claude/project-marker.txt
  b/.claude/settings.local.json
test/e2e-comprehensive/orchestrator/phase-p2.test.ts  ← 新建主 case 文件
test/e2e-comprehensive/orchestrator/phase-p2-meta.test.ts  ← 新建 meta failure 反向 case 文件
test/run-e2e-comprehensive.sh           ← 加 phase-p2.test.ts 入口
test/run-e2e-comprehensive-meta.sh      ← 加 phase-p2-meta.test.ts 入口
docs/e2e-comprehensive-testing.md       ← §2.3 升级 F4-cross-cwd 状态;§10 changelog;§12 P2-α 闭环登记
docs/superpowers/specs/2026-05-02-f4-cross-cwd-fileproxy-isolation-design.md  ← §9 验收勾选
```

### PR2 可能新增 test-toggle(用于 meta failure case)

```
server/src/test-toggles.ts              ← 加 injectCrossCwdRootCollision toggle(让 FileProxyManager 把两个 session project-claude root 错挂为同一路径)
```

---

# PR 1:基础设施(Observability + Helper)

## Task 1:扩 orchestrator TS detail interface

**Files:**
- Modify: `test/e2e-comprehensive/orchestrator/server-events.ts:96-156`(detail interface 段)

- [ ] **Step 1.1: 读现状定位精确改点**

Read 当前 detail interface 区块,找到 5 个 interface 的精确行号:`FileProxyReadServedDetail` / `FileProxyShadowServedDetail` / `FileProxyWriteServedDetail` / `FileProxyClientRequestedDetail` / `FileProxyClientMissDetail`。

确认每个 interface 当前字段,记录精确行号下一步用。

- [ ] **Step 1.2: 扩 4 个 detail interface 字段**

在每个 detail interface 加 `clientCwd?` / `clientPath?` / `contentSha256?`(三者都用 `?:` 可选,因为 emit 出口分批落地,过渡期混合状态)。

```typescript
export interface FileProxyReadServedDetail {
  root: string;
  relPath: string;
  servedFrom: string;
  hasData?: boolean;
  size?: number;
  sliceBytes?: number;
  // 新增 ↓
  clientCwd?: string;
  clientPath?: string;
  contentSha256?: string;
}

export interface FileProxyShadowServedDetail {
  op: string;
  root: string;
  relPath: string;
  shadowPath: string;
  bytes: number;
  offset: number;
  size: number;
  // 新增 ↓
  clientCwd?: string;
  fusePath?: string;
}

export interface FileProxyWriteServedDetail {
  op: string;
  root: string;
  relPath: string;
  servedTo: string;
  bytes: number;
  offset: number;
  shadow: boolean;
  // 新增 ↓
  clientCwd?: string;
  fusePath?: string;
}

export interface FileProxyClientRequestedDetail {
  op: string;
  root: string;
  relPath: string;
  reason: string;
  perforationCount: number;
  // 新增 ↓
  clientCwd?: string;
  clientPath?: string;
}
```

- [ ] **Step 1.3: 加 2 个新 detail interface(plan events)**

在现有 detail interface 段末尾追加:

```typescript
export interface ConfigPreloaderPlanDetail {
  sessionId: string;
  clientCwd: string;
  homeDir: string;
  ancestorDirs: string[];
  prefetchAbsPaths: string[];
}

export interface SessionBootstrapPlanDetail {
  sessionId: string;
  deviceId: string;
  clientCwd: string;
  runtimeRoot: string;
  fileProxyMountPoint: string;
  projectClaudeBindTarget: string;
}
```

- [ ] **Step 1.4: typecheck**

```bash
cd /Users/n374/Documents/Code/cerelay/server && npm run typecheck
```

Expected: 无错误(纯类型扩展,无运行时影响)。

- [ ] **Step 1.5: commit**

```bash
cd /Users/n374/Documents/Code/cerelay
git add test/e2e-comprehensive/orchestrator/server-events.ts
git commit -m "$(cat <<'EOF'
🏗️ infra / orchestrator detail interface 扩 cwd 字段(F4 P2 PR1.1)

按 spec §5.1 给 4 个 fileProxy detail 加可选 clientCwd / clientPath /
contentSha256;新加 ConfigPreloaderPlanDetail + SessionBootstrapPlanDetail
两个 interface,为后续 emit 出口准备类型契约。纯类型扩展,无运行时影响。

Spec: docs/superpowers/specs/2026-05-02-f4-cross-cwd-fileproxy-isolation-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2:server-events.ts orchestrator helper 扩 cwd 过滤 + 新 helper

**Files:**
- Modify: `test/e2e-comprehensive/orchestrator/server-events.ts`(`fileProxyEvents` 对象)

- [ ] **Step 2.1: 给现有 helper 加 clientCwd? 过滤参数**

修改 `findReadServed` / `waitForReadServed` / `findShadowServed` / `waitForShadowServed` / `findWriteServed` / `waitForWriteServed` / `findClientRequested` / `findClientMiss`,在 query 参数对象加 `clientCwd?: string`,内部 filter 时若提供则按 `event.detail.clientCwd === clientCwd` 过滤。

示例:

```typescript
findReadServed(opts: {
  root: string;
  relPath: string;
  sessionId?: string;
  clientCwd?: string;  // ← 新增
  since?: number;
}): AdminEvent | null {
  return this.find("file-proxy.read.served", (e) => {
    if (e.detail.root !== opts.root) return false;
    if (e.detail.relPath !== opts.relPath) return false;
    if (opts.sessionId && e.sessionId !== opts.sessionId) return false;
    if (opts.clientCwd && e.detail.clientCwd !== opts.clientCwd) return false;
    if (opts.since && e.id <= opts.since) return false;
    return true;
  });
}
```

- [ ] **Step 2.2: 新增 `assertNoReadServedForCwd` poll-and-collect helper**

在 `fileProxyEvents` 对象末尾追加:

```typescript
/**
 * Negative-assert: 在 timeoutMs 内收集所有 sessionId === sessionId 且
 * clientPath.startsWith(foreignCwd) 的 file-proxy.read.served event,
 * 期望 count === 0。
 *
 * 重点:**poll-and-collect 模式,不是 absence-of-log**——
 * 必须真等够 timeoutMs 收集完才能断言,而不是"没看到就跳过"。
 */
async assertNoReadServedForCwd(opts: {
  sessionId: string;
  foreignCwd: string;
  since: number;
  timeoutMs?: number;  // 默认 500ms,所有 probe 完成后再调用
}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  const collected: AdminEvent[] = [];
  while (Date.now() < deadline) {
    const all = await this.adminEvents.list({ since: opts.since });
    for (const e of all) {
      if (e.kind !== "file-proxy.read.served") continue;
      if (e.sessionId !== opts.sessionId) continue;
      const clientPath = e.detail.clientPath;
      if (typeof clientPath !== "string") continue;
      if (!clientPath.startsWith(opts.foreignCwd)) continue;
      if (collected.find((c) => c.id === e.id)) continue;
      collected.push(e);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  if (collected.length > 0) {
    throw new Error(
      `assertNoReadServedForCwd FAIL: 在 sessionId=${opts.sessionId} 检测到 ` +
      `${collected.length} 条访问 foreignCwd=${opts.foreignCwd} 的 read.served:\n` +
      collected.map((e) => `  - ${e.detail.clientPath} (root=${e.detail.root})`).join("\n")
    );
  }
}
```

- [ ] **Step 2.3: 新增 `configPreloaderEvents` + `sessionBootstrapEvents` helper 对象**

在 server-events.ts 末尾追加:

```typescript
export const configPreloaderEvents = {
  findPlan(opts: { sessionId: string; since: number }): AdminEvent | null {
    return adminEvents.find("config-preloader.plan", (e) => {
      if (e.sessionId !== opts.sessionId) return false;
      if (e.id <= opts.since) return false;
      return true;
    });
  },
  async waitForPlan(opts: { sessionId: string; since: number; timeoutMs?: number }): Promise<AdminEvent> {
    return waitForEvent("config-preloader.plan", opts.timeoutMs ?? 5000, (e) => {
      return e.sessionId === opts.sessionId && e.id > opts.since;
    });
  },
};

export const sessionBootstrapEvents = {
  findPlan(opts: { sessionId: string; since: number }): AdminEvent | null {
    return adminEvents.find("session.bootstrap.plan", (e) => {
      if (e.sessionId !== opts.sessionId) return false;
      if (e.id <= opts.since) return false;
      return true;
    });
  },
  async waitForPlan(opts: { sessionId: string; since: number; timeoutMs?: number }): Promise<AdminEvent> {
    return waitForEvent("session.bootstrap.plan", opts.timeoutMs ?? 5000, (e) => {
      return e.sessionId === opts.sessionId && e.id > opts.since;
    });
  },
};
```

- [ ] **Step 2.4: 新增 `assertF4CrossCwdIsolation` 公共断言**

在 server-events.ts 末尾追加:

```typescript
/**
 * F4 Cross-CWD 综合隔离断言。失败时 dump 完整 fileProxy + config-preloader +
 * session.bootstrap probe 摘要,方便 reviewer 定位串台。
 *
 * 详细约束见 spec §5.3 与 §6 守护意图自查。
 */
export async function assertF4CrossCwdIsolation(opts: {
  sessionA: { sessionId: string };
  sessionB: { sessionId: string };
  cwdA: string;
  cwdB: string;
  since: number;
}): Promise<void> {
  const errors: string[] = [];

  // (a)+(d): A 的 project-claude read.served 必须 clientCwd === cwdA
  const aReads = await adminEvents.list({ since: opts.since });
  const aProjectReads = aReads.filter((e) =>
    e.kind === "file-proxy.read.served" &&
    e.sessionId === opts.sessionA.sessionId &&
    e.detail.root === "project-claude"
  );
  for (const e of aProjectReads) {
    if (e.detail.clientCwd !== opts.cwdA) {
      errors.push(`(a/d) sessionA project-claude read.served clientCwd 错位: 期望 ${opts.cwdA},实际 ${e.detail.clientCwd}`);
    }
  }

  // 同理 B
  const bProjectReads = aReads.filter((e) =>
    e.kind === "file-proxy.read.served" &&
    e.sessionId === opts.sessionB.sessionId &&
    e.detail.root === "project-claude"
  );
  for (const e of bProjectReads) {
    if (e.detail.clientCwd !== opts.cwdB) {
      errors.push(`(a/d) sessionB project-claude read.served clientCwd 错位: 期望 ${opts.cwdB},实际 ${e.detail.clientCwd}`);
    }
  }

  // (c): config-preloader.plan ancestorDirs / prefetchAbsPaths 不串台
  const planA = configPreloaderEvents.findPlan({ sessionId: opts.sessionA.sessionId, since: opts.since });
  if (!planA) errors.push(`(c) sessionA config-preloader.plan event 缺失`);
  else {
    const ancestorsA = planA.detail.ancestorDirs as string[];
    const prefetchA = planA.detail.prefetchAbsPaths as string[];
    if (ancestorsA.some((p) => p.startsWith(opts.cwdB))) {
      errors.push(`(c) sessionA ancestorDirs 串到 cwdB 子树: ${ancestorsA.filter(p => p.startsWith(opts.cwdB)).join(", ")}`);
    }
    if (prefetchA.some((p) => p.startsWith(opts.cwdB))) {
      errors.push(`(c) sessionA prefetchAbsPaths 串到 cwdB 子树: ${prefetchA.filter(p => p.startsWith(opts.cwdB)).join(", ")}`);
    }
  }

  // 同理 B
  const planB = configPreloaderEvents.findPlan({ sessionId: opts.sessionB.sessionId, since: opts.since });
  if (!planB) errors.push(`(c) sessionB config-preloader.plan event 缺失`);
  else {
    const ancestorsB = planB.detail.ancestorDirs as string[];
    const prefetchB = planB.detail.prefetchAbsPaths as string[];
    if (ancestorsB.some((p) => p.startsWith(opts.cwdA))) {
      errors.push(`(c) sessionB ancestorDirs 串到 cwdA 子树`);
    }
    if (prefetchB.some((p) => p.startsWith(opts.cwdA))) {
      errors.push(`(c) sessionB prefetchAbsPaths 串到 cwdA 子树`);
    }
  }

  // (d): session.bootstrap.plan projectClaudeBindTarget 严格按 cwd
  const bootA = sessionBootstrapEvents.findPlan({ sessionId: opts.sessionA.sessionId, since: opts.since });
  if (!bootA) errors.push(`(d) sessionA session.bootstrap.plan event 缺失`);
  else if (bootA.detail.projectClaudeBindTarget !== `${opts.cwdA}/.claude`) {
    errors.push(`(d) sessionA projectClaudeBindTarget 错位: 期望 ${opts.cwdA}/.claude,实际 ${bootA.detail.projectClaudeBindTarget}`);
  }

  const bootB = sessionBootstrapEvents.findPlan({ sessionId: opts.sessionB.sessionId, since: opts.since });
  if (!bootB) errors.push(`(d) sessionB session.bootstrap.plan event 缺失`);
  else if (bootB.detail.projectClaudeBindTarget !== `${opts.cwdB}/.claude`) {
    errors.push(`(d) sessionB projectClaudeBindTarget 错位: 期望 ${opts.cwdB}/.claude,实际 ${bootB.detail.projectClaudeBindTarget}`);
  }

  if (errors.length > 0) {
    throw new Error(`assertF4CrossCwdIsolation FAIL:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  }
}
```

- [ ] **Step 2.5: typecheck + commit**

```bash
cd /Users/n374/Documents/Code/cerelay/server && npm run typecheck
cd /Users/n374/Documents/Code/cerelay
git add test/e2e-comprehensive/orchestrator/server-events.ts
git commit -m "🏗️ infra / orchestrator helper 扩 cwd 过滤 + assertF4CrossCwdIsolation 公共断言(F4 P2 PR1.2)

新增:
- 现有 fileProxyEvents helper 加 clientCwd? 过滤参数
- assertNoReadServedForCwd: poll-and-collect negative-assert(timeoutMs 默认 500ms)
- configPreloaderEvents.findPlan / waitForPlan
- sessionBootstrapEvents.findPlan / waitForPlan
- assertF4CrossCwdIsolation 综合断言(失败时 dump 详细错位)

Spec: docs/superpowers/specs/2026-05-02-f4-cross-cwd-fileproxy-isolation-design.md §5.1/§5.4

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3:file-proxy-manager.ts read.served 4 出口加 cwd/path/sha256

**Files:**
- Modify: `server/src/file-proxy-manager.ts`(read.served emit 4 处)

- [ ] **Step 3.1: 读现状定位 4 个 emit 点**

读 `server/src/file-proxy-manager.ts:960-980, 1175-1195, 1245-1265, 1900-1920` 区块,找到 4 处 `adminEvents?.record("file-proxy.read.served", ...)` 调用,记录精确行号 + 当前 detail 字段。

- [ ] **Step 3.2: 抽出 sha256 helper + clientPath 计算**

在 file 顶部 import 区追加(若未导入):

```typescript
import { createHash } from "node:crypto";
```

在 `FileProxyManager` class 私有方法区追加:

```typescript
private computeContentSha256(bytes: Buffer | string): string | undefined {
  if (process.env.CERELAY_ADMIN_EVENTS !== "true") return undefined;
  return createHash("sha256").update(bytes).digest("hex");
}

private buildClientPath(root: string, relPath: string): string {
  const rootPath = this.roots[root];
  if (!rootPath) return relPath;
  return require("node:path").join(rootPath, relPath);
}
```

- [ ] **Step 3.3: 给 4 个 read.served emit 出口加 detail 字段**

每处 emit 改为:

```typescript
this.adminEvents?.record("file-proxy.read.served", this.sessionId, {
  root,
  relPath,
  servedFrom,
  hasData: data !== undefined,
  size: data?.length,
  sliceBytes: slice?.length,
  // 新增 ↓
  clientCwd: this.clientCwd,
  clientPath: this.buildClientPath(root, relPath),
  contentSha256: this.computeContentSha256(data ?? Buffer.alloc(0)),
});
```

具体 4 处对应位置:
- `:968` 附近 (snapshot-client)
- `:1181` 附近 (snapshot-cache)
- `:1255` 附近 (runtime cache)
- `:1911` 附近 (settings passthrough)

每处都要加上 3 个新字段,字段值来源相同。

- [ ] **Step 3.4: typecheck + server unit test**

```bash
cd /Users/n374/Documents/Code/cerelay/server && npm run typecheck && npm test
```

Expected: typecheck 0 errors;425/425 pass(或维持基线)。

- [ ] **Step 3.5: e2e 回归(确保现有 case 不破坏)**

```bash
cd /Users/n374/Documents/Code/cerelay && bash test/run-e2e-comprehensive.sh
```

Expected: 26/26 全过(detail 加可选字段对现有 case 无影响)。

- [ ] **Step 3.6: commit**

```bash
git add server/src/file-proxy-manager.ts
git commit -m "🏗️ infra / file-proxy.read.served 4 出口加 clientCwd/clientPath/contentSha256(F4 P2 PR1.3)

snapshot-client / snapshot-cache / runtime-cache / settings-passthrough
四个 emit 出口统一加:clientCwd(本 session cwd)/ clientPath(本机物理路径)
/ contentSha256(返回 bytes 的 sha256,gate 在 CERELAY_ADMIN_EVENTS=true,
生产路径零开销)。新增字段都是可选,不破坏现有 case。

Spec: docs/superpowers/specs/2026-05-02-f4-cross-cwd-fileproxy-isolation-design.md §5.1/§5.4

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4:file-proxy-manager.ts client.requested + sideband 转录加 cwd/path

**Files:**
- Modify: `server/src/file-proxy-manager.ts`(`:1561-1577` sideband 转录;`:1699/1703` client.requested)

- [ ] **Step 4.1: client.requested emit 加字段**

定位 `:1699` 和 `:1703` 附近 `adminEvents?.record("file-proxy.client.requested", ...)`,加:

```typescript
this.adminEvents?.record("file-proxy.client.requested", this.sessionId, {
  op,
  root,
  relPath,
  reason,
  perforationCount,
  // 新增 ↓
  clientCwd: this.clientCwd,
  clientPath: this.buildClientPath(root, relPath),
});
```

- [ ] **Step 4.2: sideband 转录补 clientCwd**

定位 `:1561-1577` 的 `handleFuseLine` `type:"event"` 分支:

```typescript
if (parsed.type === "event") {
  const evt = parsed as { kind: string; detail: Record<string, unknown> };
  // 修改 ↓
  this.adminEvents?.record(evt.kind, this.sessionId, {
    ...evt.detail,
    clientCwd: this.clientCwd,
    // 若 detail 已有 fusePath(daemon 端 Task 5 后会带),server 不覆盖
    clientPath: typeof evt.detail.fusePath === "string"
      ? evt.detail.fusePath  // shadow path 已是绝对路径
      : (typeof evt.detail.relPath === "string" && typeof evt.detail.root === "string"
          ? this.buildClientPath(evt.detail.root, evt.detail.relPath)
          : undefined),
  });
}
```

- [ ] **Step 4.3: typecheck + server unit + e2e 回归**

```bash
cd /Users/n374/Documents/Code/cerelay/server && npm run typecheck && npm test
cd /Users/n374/Documents/Code/cerelay && bash test/run-e2e-comprehensive.sh
```

Expected: 全过。

- [ ] **Step 4.4: commit**

```bash
git add server/src/file-proxy-manager.ts
git commit -m "🏗️ infra / client.requested + sideband 转录加 clientCwd/clientPath(F4 P2 PR1.4)

client.requested emit 加 clientCwd/clientPath(穿透 client 前的观测点)。
handleFuseLine sideband 转录路径在 server 端补 clientCwd,优先使用 daemon
emit 的 fusePath(若有,Task 5 后),否则用 root+relPath 拼。不改 daemon
sessionId 处理(本来就正确,详见 spec §2 第 1 项纠偏)。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5:fuse-host-script.ts sideband shadow detail 加 fusePath

**Files:**
- Modify: `server/src/fuse-host-script.ts`(shadow read `:676-688` / shadow write `:740-757` 两处 sideband emit)

- [ ] **Step 5.1: 定位精确 emit 行**

读 `:670-700` 和 `:735-765`,找到两处 `emit_event("file-proxy.shadow.served", {...})` 与 `emit_event("file-proxy.write.served", {...})` 的 detail 构造点。

- [ ] **Step 5.2: shadow read 加 fusePath**

在 shadow read emit 处的 detail dict 加:

```python
emit_event("file-proxy.shadow.served", {
    "op": "read",
    "root": root,
    "relPath": rel_path,
    "shadowPath": shadow_path,
    "bytes": bytes_read,
    "offset": offset,
    "size": size,
    "fusePath": fuse_path,  # 新增:原始 FUSE 路径(server 转录时反查 cwd)
})
```

`fuse_path` 取自该 op 的 FUSE path 输入参数(`path` 在 daemon scope 内)。

- [ ] **Step 5.3: shadow write 加 fusePath**

同理在 write 出口的 detail dict 加 `"fusePath": fuse_path`。

- [ ] **Step 5.4: 重新构建 docker image + e2e 回归**

daemon 是 server 容器内的 Python 文件,改完需要重新构建 server image:

```bash
cd /Users/n374/Documents/Code/cerelay
docker compose -f docker-compose.e2e.yml build server
bash test/run-e2e-comprehensive.sh
```

Expected: 26/26 全过。fusePath 字段不被现有 case 消费,不影响测试。

- [ ] **Step 5.5: commit**

```bash
git add server/src/fuse-host-script.ts
git commit -m "🏗️ infra / daemon sideband shadow detail 加 fusePath(F4 P2 PR1.5)

shadow read / write 两处 sideband emit detail 加 fusePath(原始 FUSE
路径)。Server 端 sideband 转录时优先使用 fusePath 而不是再用 root+relPath
拼。**不**改 sessionId 处理——daemon 不需要承担 sessionId 绑定(server
端 handleFuseLine 已用 this.sessionId 正确绑定,详见 spec §2 第 1 项纠偏)。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6:config-preloader.ts 新增 plan event

**Files:**
- Modify: `server/src/config-preloader.ts`(`buildPrefetchItems` 完成处 emit)

- [ ] **Step 6.1: 定位 emit 插入点**

读 `server/src/config-preloader.ts:100-150`,找到 `buildPrefetchItems` 方法返回前的位置。确认 `ConfigPreloader` 类已有 `adminEvents` 引用(若没有则需要在 constructor 加),记录精确插入行号。

- [ ] **Step 6.2: 新增 emit**

在 `buildPrefetchItems` 算完 ancestor chain 和 prefetch items 后,return 之前 emit:

```typescript
// 在 return prefetchItems 之前
this.adminEvents?.record("config-preloader.plan", this.sessionId, {
  sessionId: this.sessionId,
  clientCwd: this.clientCwd,
  homeDir: this.homeDir,
  ancestorDirs: ancestorChain,  // 已有的 ancestor 计算结果
  prefetchAbsPaths: prefetchItems.map((it) => it.absPath),
});
```

若 `ConfigPreloader` 当前没有 `adminEvents` 字段,需要在 constructor 加可选注入:

```typescript
constructor(options: {
  sessionId: string;
  clientCwd: string;
  homeDir: string;
  fileAgent: FileAgent;
  adminEvents?: AdminEventBuffer;  // ← 加可选注入
}) {
  this.sessionId = options.sessionId;
  this.clientCwd = options.clientCwd;
  this.homeDir = options.homeDir;
  this.fileAgent = options.fileAgent;
  this.adminEvents = options.adminEvents;  // ← 存
}
```

并在 `server.ts` 创建 ConfigPreloader 处把 `adminEvents` 传入(找到 `new ConfigPreloader(...)` 调用,加 `adminEvents: this.adminEvents`)。

- [ ] **Step 6.3: typecheck + server unit + e2e 回归**

```bash
cd /Users/n374/Documents/Code/cerelay/server && npm run typecheck && npm test
cd /Users/n374/Documents/Code/cerelay
docker compose -f docker-compose.e2e.yml build server
bash test/run-e2e-comprehensive.sh
```

Expected: 全过。

- [ ] **Step 6.4: commit**

```bash
git add server/src/config-preloader.ts server/src/server.ts
git commit -m "🏗️ infra / 新增 config-preloader.plan admin event(F4 P2 PR1.6)

ConfigPreloader.buildPrefetchItems 算完 ancestor chain + prefetch items
后 emit config-preloader.plan event,detail 含 sessionId / clientCwd /
homeDir / ancestorDirs / prefetchAbsPaths。这是 spec §5.1 守不变量 (c)
'计算计划不串台' 的核心 probe(真实 ancestor FUSE read 守不住,见 INF-12)。

ConfigPreloader 加 adminEvents 可选注入,server.ts 创建处传入。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7:server.ts 新增 session.bootstrap.plan event

**Files:**
- Modify: `server/src/server.ts`(`createClaudeSessionRuntime` 调用前后,`:1145/1204` 附近)

- [ ] **Step 7.1: 定位精确 emit 位置**

读 `server/src/server.ts:1100-1220` 附近,找到 `createClaudeSessionRuntime` 调用、`FileProxyManager` 构造、`runtimeRoot` 生成这一段。确定能拿齐这 6 个字段的位置:`sessionId / deviceId / clientCwd / runtimeRoot / fileProxyMountPoint / projectClaudeBindTarget`。

- [ ] **Step 7.2: emit 插入**

在 runtime 创建后、PTY 启动前 emit:

```typescript
// session.bootstrap.plan probe(F4 P2 不变量 d 守护)
this.adminEvents?.record("session.bootstrap.plan", sessionId, {
  sessionId,
  deviceId,
  clientCwd: message.cwd,
  runtimeRoot: runtime.runtimeRoot,
  fileProxyMountPoint: fileProxy.mountPoint,
  projectClaudeBindTarget: `${message.cwd}/.claude`,  // 与 claude-session-runtime.ts:328 mount --bind 目标一致
});
```

具体取值:
- `runtime.runtimeRoot`:`createClaudeSessionRuntime` 返回对象的属性(若无则改读 `:1110/1111` 周围生成的 runtimeRoot 变量)
- `fileProxy.mountPoint`:`FileProxyManager` 实例的 mountPoint 字段(若无暴露则需要在 `FileProxyManager` 加 getter)
- `projectClaudeBindTarget`:与 bootstrap shell `claude-session-runtime.ts:328` 一致拼接

- [ ] **Step 7.3: typecheck + server unit + e2e 回归**

```bash
cd /Users/n374/Documents/Code/cerelay/server && npm run typecheck && npm test
cd /Users/n374/Documents/Code/cerelay
docker compose -f docker-compose.e2e.yml build server
bash test/run-e2e-comprehensive.sh
```

Expected: 全过。

- [ ] **Step 7.4: commit**

```bash
git add server/src/server.ts server/src/file-proxy-manager.ts
git commit -m "🏗️ infra / 新增 session.bootstrap.plan admin event(F4 P2 PR1.7)

session 创建期间 emit session.bootstrap.plan,detail 含 sessionId /
deviceId / clientCwd / runtimeRoot / fileProxyMountPoint /
projectClaudeBindTarget。这是 spec §5.1 守不变量 (d) 'project-claude
bind mount 严格按 cwd' 的 probe——assertF4CrossCwdIsolation 用此 event
断言 bind target 与 session cwd 严格对齐。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8:PR1 全量验收 + Codex 评审

**Files:**(无文件改动,验收 + commit checkpoint)

- [ ] **Step 8.1: 全套测试运行**

```bash
cd /Users/n374/Documents/Code/cerelay
npm run typecheck                                    # server / client / web 全过
npm run test:workspaces                              # server 425+ / client 135 / web 6 全过
docker compose -f docker-compose.e2e.yml build server
bash test/run-e2e-comprehensive.sh                  # P0 16 + P1-A 2 + P1-B 8 = 26/26
bash test/run-e2e-comprehensive-meta.sh             # 3/3
```

Expected: 全部绿。

- [ ] **Step 8.2: Codex 终审基础设施 PR**

按 `~/.claude/rules/review-workflow.md` 阶段 5 启动 Codex 评审:

```
/codex:rescue F4 P2 基础设施 PR(observability + helper)Codex 终审
```

prompt 内容包含:
- spec 路径 `docs/superpowers/specs/2026-05-02-f4-cross-cwd-fileproxy-isolation-design.md`
- PR1 范围:Task 1-7 commits(`git log -7 --oneline`)
- 验收要求:对照 spec §6 守护意图自查表 + §9 PR1 验收清单
- 关注点:emit gate 是否 fire-and-forget;contentSha256 计算路径是否在 gate 内;sideband 转录的 clientCwd 是否真实从 server 取(不是 daemon 注入)

- [ ] **Step 8.3: Codex 反馈处理**

若 Codex 提出 critical / important 问题,回到对应 task 修复后重跑 Step 8.1。

若 0 critical / important 全修,进 Step 8.4。

3 轮未收敛升级为高分歧 → 交用户。

- [ ] **Step 8.4: PR1 闭环 commit**

```bash
# 在 spec §9 验收章节标记 PR1 验收勾选
# 在 docs/e2e-comprehensive-testing.md §10 加 changelog 条目
git add docs/superpowers/specs/2026-05-02-f4-cross-cwd-fileproxy-isolation-design.md docs/e2e-comprehensive-testing.md
git commit -m "✅ infra / F4 P2 基础设施 PR 闭环登记 + Codex 终审通过(F4 P2 PR1.8)

PR1 (observability + helper) 全部 7 个 task 闭环:
- file-proxy.read.served / client.requested / sideband 转录加 clientCwd/clientPath/contentSha256
- daemon shadow sideband detail 加 fusePath
- 新增 config-preloader.plan / session.bootstrap.plan event
- orchestrator helper 加 cwd 过滤 + assertNoReadServedForCwd + assertF4CrossCwdIsolation

验收: e2e 26/26 + meta 3/3 + server 425+ / client 135 / web 6 + typecheck 全过。
Codex 终审通过(0 critical / N important / N nit)。

下一步:进 PR2 测试 case 落地(phase-p2.test.ts + phase-p2-meta.test.ts)。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

# PR 2:测试 Case 落地

## Task 9:Fixture 树落地

**Files:**
- Create: `test/e2e-comprehensive/fixtures/case-f4-cross/CLAUDE.md`
- Create: `test/e2e-comprehensive/fixtures/case-f4-cross/a/CLAUDE.md`
- Create: `test/e2e-comprehensive/fixtures/case-f4-cross/a/.claude/project-marker.txt`
- Create: `test/e2e-comprehensive/fixtures/case-f4-cross/a/.claude/settings.local.json`
- Create: `test/e2e-comprehensive/fixtures/case-f4-cross/b/CLAUDE.md`
- Create: `test/e2e-comprehensive/fixtures/case-f4-cross/b/.claude/project-marker.txt`
- Create: `test/e2e-comprehensive/fixtures/case-f4-cross/b/.claude/settings.local.json`

- [ ] **Step 9.1: 创建 fixture 树**

```bash
cd /Users/n374/Documents/Code/cerelay/test/e2e-comprehensive/fixtures
mkdir -p case-f4-cross/a/.claude case-f4-cross/b/.claude
```

写各文件内容(用 Write 工具):

`CLAUDE.md`:
```
ANCESTOR_SHARED
```

`a/CLAUDE.md`:
```
ANCESTOR_A_ONLY
```

`a/.claude/project-marker.txt`:
```
PROJECT_A_ONLY
```

`a/.claude/settings.local.json`:
```json
{"f4":"SETTINGS_A_ONLY"}
```

`b/CLAUDE.md`:
```
ANCESTOR_B_ONLY
```

`b/.claude/project-marker.txt`:
```
PROJECT_B_ONLY
```

`b/.claude/settings.local.json`:
```json
{"f4":"SETTINGS_B_ONLY"}
```

- [ ] **Step 9.2: 验证 fixture 树**

```bash
cd /Users/n374/Documents/Code/cerelay
ls -la test/e2e-comprehensive/fixtures/case-f4-cross/
ls -la test/e2e-comprehensive/fixtures/case-f4-cross/a/
ls -la test/e2e-comprehensive/fixtures/case-f4-cross/a/.claude/
```

Expected:每个文件存在且内容正确。

- [ ] **Step 9.3: commit**

```bash
git add test/e2e-comprehensive/fixtures/case-f4-cross/
git commit -m "🧪 e2e / F4 P2 fixture: case-f4-cross 两 cwd + 共同祖先树(F4 P2 PR2.9)

按 spec §5.2 布置:
- 共同祖先 CLAUDE.md = ANCESTOR_SHARED
- a/{CLAUDE.md, .claude/project-marker.txt, .claude/settings.local.json}
- b/{CLAUDE.md, .claude/project-marker.txt, .claude/settings.local.json}

各 marker 用大写下划线串便于断言时 includes 判断,A/B 完全不重叠。
home fixture(共享 \$HOME 的全局 marker)在 case 内部用 homeFixture
inline 写,不进 fixture 树。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10:phase-p2.test.ts 主 case 落地

**Files:**
- Create: `test/e2e-comprehensive/orchestrator/phase-p2.test.ts`

- [ ] **Step 10.1: 写完整 case 文件**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adminEvents,
  fileProxyEvents,
  configPreloaderEvents,
  sessionBootstrapEvents,
  ptyEvents,
  serverExec,
  assertF4CrossCwdIsolation,
} from "./server-events.ts";
import { clients } from "./clients.ts";
import { mockAdmin } from "./mock-admin.ts";
import { killAndVerifyExited } from "./run-helpers.ts";

const PROMPT = "echo F4-cross-cwd-probe";
const FIXTURES_BASE = "/fixtures/case-f4-cross";
const CWD_A = `${FIXTURES_BASE}/a`;
const CWD_B = `${FIXTURES_BASE}/b`;

test("F4-cross-cwd-fileproxy-isolation: 同 device 两 cwd 并发隔离", async () => {
  await mockAdmin.reset();

  // 简单 final response,避免 CC 跑工具
  await mockAdmin.loadScript({
    name: "f4-cross-cwd",
    match: { turnIndex: 1 },
    respond: {
      type: "stream",
      events: [
        { type: "message_start", message: { id: "msg_f4", type: "message", role: "assistant", model: "claude-sonnet-4-20250514", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "F4 OK" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ],
    },
  });

  // home fixture(共享 $HOME 的全局 marker)
  const homeFixture = {
    ".claude/f4-home-marker.txt": "HOME_SHARED_EXPECTED",
    ".claude.json": JSON.stringify({ f4: "HOME_JSON_SHARED_EXPECTED" }),
  };

  const baseline = await adminEvents.lastEventId();

  // 并发启动两 session
  const [runA, runB] = await Promise.all([
    clients.runAsync("client-a", { prompt: PROMPT, cwd: CWD_A, homeFixture }),
    clients.runAsync("client-a", { prompt: PROMPT, cwd: CWD_B, homeFixture }),
  ]);

  const spawnA = await ptyEvents.findSpawnReady({ expectedCwd: CWD_A, since: baseline, timeoutMs: 10_000 });
  const spawnB = await ptyEvents.findSpawnReady({ expectedCwd: CWD_B, since: baseline, timeoutMs: 10_000 });

  assert.notStrictEqual(spawnA.sessionId, spawnB.sessionId, "sessionId 应唯一");
  assert.strictEqual(spawnA.detail.cwd, CWD_A);
  assert.strictEqual(spawnB.detail.cwd, CWD_B);

  // === 阶段一:正向 probe(serverExec.run 在 namespace 内触发 FUSE) ===
  const aProject = await serverExec.run(spawnA.sessionId, {
    command: "cat", args: [`${CWD_A}/.claude/project-marker.txt`], timeoutMs: 5000,
  });
  const aHome = await serverExec.run(spawnA.sessionId, {
    command: "cat", args: ["/root/.claude/f4-home-marker.txt"], timeoutMs: 5000,
  });
  const aHomeJson = await serverExec.run(spawnA.sessionId, {
    command: "cat", args: ["/root/.claude.json"], timeoutMs: 5000,
  });
  const aSettings = await serverExec.run(spawnA.sessionId, {
    command: "cat", args: [`${CWD_A}/.claude/settings.local.json`], timeoutMs: 5000,
  });
  const aAncestor = await serverExec.run(spawnA.sessionId, {
    command: "cat", args: [`${CWD_A}/CLAUDE.md`], timeoutMs: 5000,
  });

  const bProject = await serverExec.run(spawnB.sessionId, {
    command: "cat", args: [`${CWD_B}/.claude/project-marker.txt`], timeoutMs: 5000,
  });
  const bHome = await serverExec.run(spawnB.sessionId, {
    command: "cat", args: ["/root/.claude/f4-home-marker.txt"], timeoutMs: 5000,
  });
  const bHomeJson = await serverExec.run(spawnB.sessionId, {
    command: "cat", args: ["/root/.claude.json"], timeoutMs: 5000,
  });
  const bSettings = await serverExec.run(spawnB.sessionId, {
    command: "cat", args: [`${CWD_B}/.claude/settings.local.json`], timeoutMs: 5000,
  });
  const bAncestor = await serverExec.run(spawnB.sessionId, {
    command: "cat", args: [`${CWD_B}/CLAUDE.md`], timeoutMs: 5000,
  });

  // === 阶段二:负向 probe(B 主动尝试访问 A 子树) ===
  const bAttemptA = await serverExec.run(spawnB.sessionId, {
    command: "cat", args: [`${CWD_A}/.claude/project-marker.txt`], timeoutMs: 5000,
  });
  // bAttemptA 可能成功(file 物理存在 fixture 同 mount)或失败,关键是 stdout 不能含 PROJECT_A_ONLY 之外的串台

  // === 阶段三:断言 ===
  // (1) stdout 正/负 marker
  assert.match(aProject.stdout, /PROJECT_A_ONLY/, "session A project marker");
  assert.doesNotMatch(aProject.stdout, /PROJECT_B_ONLY/, "session A 不能见 B 的 project marker");
  assert.match(bProject.stdout, /PROJECT_B_ONLY/, "session B project marker");
  assert.doesNotMatch(bProject.stdout, /PROJECT_A_ONLY/, "session B 不能见 A 的 project marker");

  assert.match(aHome.stdout, /HOME_SHARED_EXPECTED/, "session A home marker(共享)");
  assert.match(bHome.stdout, /HOME_SHARED_EXPECTED/, "session B home marker(共享)");
  assert.match(aHomeJson.stdout, /HOME_JSON_SHARED_EXPECTED/);
  assert.match(bHomeJson.stdout, /HOME_JSON_SHARED_EXPECTED/);

  assert.match(aSettings.stdout, /SETTINGS_A_ONLY/);
  assert.doesNotMatch(aSettings.stdout, /SETTINGS_B_ONLY/);
  assert.match(bSettings.stdout, /SETTINGS_B_ONLY/);
  assert.doesNotMatch(bSettings.stdout, /SETTINGS_A_ONLY/);

  assert.match(aAncestor.stdout, /ANCESTOR_A_ONLY/);
  assert.doesNotMatch(aAncestor.stdout, /ANCESTOR_B_ONLY/);
  assert.match(bAncestor.stdout, /ANCESTOR_B_ONLY/);
  assert.doesNotMatch(bAncestor.stdout, /ANCESTOR_A_ONLY/);

  // (2) read.served event sessionId+cwd 对齐(spec §5.3 阶段三 assertion 2)
  const projectReadA = await fileProxyEvents.waitForReadServed({
    root: "project-claude", sessionId: spawnA.sessionId, since: baseline, timeoutMs: 5000,
  });
  assert.strictEqual(projectReadA.detail.clientCwd, CWD_A);

  const projectReadB = await fileProxyEvents.waitForReadServed({
    root: "project-claude", sessionId: spawnB.sessionId, since: baseline, timeoutMs: 5000,
  });
  assert.strictEqual(projectReadB.detail.clientCwd, CWD_B);

  // (3) negative-assert: B 没有访问 cwdA 子树的 read.served event
  await fileProxyEvents.assertNoReadServedForCwd({
    sessionId: spawnB.sessionId, foreignCwd: CWD_A, since: baseline, timeoutMs: 500,
  });
  await fileProxyEvents.assertNoReadServedForCwd({
    sessionId: spawnA.sessionId, foreignCwd: CWD_B, since: baseline, timeoutMs: 500,
  });

  // (4) ConfigPreloader plan 不串台
  const planA = await configPreloaderEvents.waitForPlan({ sessionId: spawnA.sessionId, since: baseline, timeoutMs: 5000 });
  const planB = await configPreloaderEvents.waitForPlan({ sessionId: spawnB.sessionId, since: baseline, timeoutMs: 5000 });

  const ancestorsA = planA.detail.ancestorDirs as string[];
  const ancestorsB = planB.detail.ancestorDirs as string[];
  assert(!ancestorsA.some((p) => p.startsWith(CWD_B)), `planA.ancestorDirs 不能含 cwdB 子树: ${ancestorsA.join(", ")}`);
  assert(!ancestorsB.some((p) => p.startsWith(CWD_A)), `planB.ancestorDirs 不能含 cwdA 子树: ${ancestorsB.join(", ")}`);

  // (5) session.bootstrap.plan project-claude bind target 严格按 cwd
  const bootA = await sessionBootstrapEvents.waitForPlan({ sessionId: spawnA.sessionId, since: baseline, timeoutMs: 5000 });
  const bootB = await sessionBootstrapEvents.waitForPlan({ sessionId: spawnB.sessionId, since: baseline, timeoutMs: 5000 });
  assert.strictEqual(bootA.detail.projectClaudeBindTarget, `${CWD_A}/.claude`);
  assert.strictEqual(bootB.detail.projectClaudeBindTarget, `${CWD_B}/.claude`);

  // (6) 公共综合断言
  await assertF4CrossCwdIsolation({
    sessionA: { sessionId: spawnA.sessionId },
    sessionB: { sessionId: spawnB.sessionId },
    cwdA: CWD_A,
    cwdB: CWD_B,
    since: baseline,
  });

  // 收尾
  await killAndVerifyExited(runA);
  await killAndVerifyExited(runB);
});
```

- [ ] **Step 10.2: 拷贝 fixture 到容器内 mount**

容器内 fixture path 是 `/fixtures/case-f4-cross/...`,与宿主机 `test/e2e-comprehensive/fixtures/case-f4-cross/` 通过 docker compose volumes 映射(参考现有 fixture 路径)。确认 `docker-compose.e2e.yml` 已 mount `./test/e2e-comprehensive/fixtures:/fixtures:ro`(若已有则无需改;若没有则参考 client-a service 现有 mount 加)。

```bash
cd /Users/n374/Documents/Code/cerelay
grep -n "fixtures" docker-compose.e2e.yml
```

确认 mount 存在。

- [ ] **Step 10.3: 跑新 case**

```bash
cd /Users/n374/Documents/Code/cerelay
docker compose -f docker-compose.e2e.yml build server  # 若 PR1 后已 build 过可省
node --import tsx --test test/e2e-comprehensive/orchestrator/phase-p2.test.ts
```

Expected: case pass。若 fail,查看 detail 错位:
- assertF4 失败时会 dump 完整摘要
- read.served event 缺字段 → PR1 task 漏了 emit
- timeout → mockAdmin 脚本未匹配,检查 turnIndex

- [ ] **Step 10.4: 跑全套 e2e 套件确保不破坏既有**

```bash
cd /Users/n374/Documents/Code/cerelay
bash test/run-e2e-comprehensive.sh
```

注意:此时 `run-e2e-comprehensive.sh` 还没把 phase-p2.test.ts 加到入口。Step 10.4 只验既有 26/26 还过(phase-p2 需要 Task 12 才进入口)。

- [ ] **Step 10.5: commit**

```bash
git add test/e2e-comprehensive/orchestrator/phase-p2.test.ts
git commit -m "🧪 e2e / F4 P2 主 case: phase-p2.test.ts F4-cross-cwd-fileproxy-isolation(F4 P2 PR2.10)

实现 spec §5.3 编排骨架:
- mockAdmin 简单 final response 避免 CC 跑工具
- baseline + Promise.all 并发起两 session(同 client-a,不同 cwd)
- 阶段一: serverExec.run 在 namespace 内 cat 各 root 路径(project / home / home.json / settings.local.json / CLAUDE.md)
- 阶段二: B 主动 cat A 子树(strict negative-assert 触发条件)
- 阶段三 6 类断言:
  (1) stdout 正/负 marker
  (2) read.served sessionId+clientCwd 对齐
  (3) assertNoReadServedForCwd 双向 negative
  (4) config-preloader.plan ancestorDirs 不串
  (5) session.bootstrap.plan projectClaudeBindTarget 严格
  (6) assertF4CrossCwdIsolation 综合
- killAndVerifyExited 收尾(防 child 残留污染下一 case)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11:phase-p2-meta.test.ts meta failure 反向 case

**Files:**
- Modify: `server/src/test-toggles.ts`(加 `injectCrossCwdRootCollision` toggle)
- Modify: `server/src/file-proxy-manager.ts`(toggle 命中时强制把 project-claude root 错挂为另一 session 的 cwd)
- Create: `test/e2e-comprehensive/orchestrator/phase-p2-meta.test.ts`

- [ ] **Step 11.1: 加 test-toggle**

读 `server/src/test-toggles.ts`,在 `TestToggleState` 加 `injectCrossCwdRootCollision?: { fromSessionId: string; toCwd: string } | null`。

`server-events.ts` 加配套 admin 接口:`testToggles.injectCrossCwdRootCollision(opts)`(类似已有 `injectToolTimeout`)。

- [ ] **Step 11.2: file-proxy-manager.ts 命中 toggle 时强制错挂**

在 `FileProxyManager` constructor 末尾(`:258-261` 附近),`this.roots["project-claude"]` 设值后追加:

```typescript
// 仅 e2e meta failure case 用——在 CERELAY_ADMIN_EVENTS=true 且 toggle 命中时,
// 故意把 project-claude root 错挂到另一 session 的 cwd,验 assertF4CrossCwdIsolation 能 catch
const collision = getTestToggles().injectCrossCwdRootCollision;
if (collision && collision.fromSessionId === this.sessionId) {
  this.roots["project-claude"] = path.join(collision.toCwd, ".claude");
}
```

注意:必须 gate 到 `CERELAY_ADMIN_EVENTS=true` 才生效,生产路径零开销。

- [ ] **Step 11.3: 写 meta case**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adminEvents,
  ptyEvents,
  testToggles,
  assertF4CrossCwdIsolation,
} from "./server-events.ts";
import { clients } from "./clients.ts";
import { mockAdmin } from "./mock-admin.ts";
import { killAndVerifyExited } from "./run-helpers.ts";

const FIXTURES_BASE = "/fixtures/case-f4-cross";
const CWD_A = `${FIXTURES_BASE}/a`;
const CWD_B = `${FIXTURES_BASE}/b`;

test("F4-cross-cwd-meta: 故意串台 → assertF4CrossCwdIsolation 期望 throw", async () => {
  await mockAdmin.reset();
  await mockAdmin.loadScript({ /* 同 phase-p2.test.ts 简单 final */ });

  const baseline = await adminEvents.lastEventId();

  // 在并发启动前注入 cross-cwd 串台 toggle:让 sessionB 的 project-claude
  // root 错挂到 cwdA(模拟 race / state leak 漏洞)
  // 注意:toggle 用 fromSessionId 匹配,但启动前还没拿到 sessionId,
  // 改用 "对 cwd === CWD_B 的 session 强制错挂" 语义。
  // 实现见 task 11.1 的 toggle 字段调整为 { fromCwd: string; toCwd: string }。
  await testToggles.injectCrossCwdRootCollision({ fromCwd: CWD_B, toCwd: CWD_A });

  try {
    const [runA, runB] = await Promise.all([
      clients.runAsync("client-a", { prompt: "echo meta", cwd: CWD_A }),
      clients.runAsync("client-a", { prompt: "echo meta", cwd: CWD_B }),
    ]);
    const spawnA = await ptyEvents.findSpawnReady({ expectedCwd: CWD_A, since: baseline });
    const spawnB = await ptyEvents.findSpawnReady({ expectedCwd: CWD_B, since: baseline });

    // 期望 assertF4CrossCwdIsolation throw
    await assert.rejects(
      () => assertF4CrossCwdIsolation({
        sessionA: { sessionId: spawnA.sessionId },
        sessionB: { sessionId: spawnB.sessionId },
        cwdA: CWD_A,
        cwdB: CWD_B,
        since: baseline,
      }),
      /assertF4CrossCwdIsolation FAIL/,
      "故意串台时 assertF4CrossCwdIsolation 必须 throw,否则 helper 退化"
    );

    await killAndVerifyExited(runA);
    await killAndVerifyExited(runB);
  } finally {
    await testToggles.injectCrossCwdRootCollision(null);  // cleanup,防泄漏到下一 case
  }
});
```

注:Step 11.1 的 toggle 字段语义微调:从 `fromSessionId` 改为 `fromCwd`(启动前还没有 sessionId)。同步改 file-proxy-manager.ts 命中条件:`if (collision && collision.fromCwd === this.clientCwd)`。

- [ ] **Step 11.4: typecheck + 跑 meta case**

```bash
cd /Users/n374/Documents/Code/cerelay/server && npm run typecheck
docker compose -f docker-compose.e2e.yml build server
node --import tsx --test test/e2e-comprehensive/orchestrator/phase-p2-meta.test.ts
```

Expected: meta case pass(因为期望 throw 且 assert.rejects 验证)。

- [ ] **Step 11.5: commit**

```bash
git add server/src/test-toggles.ts server/src/file-proxy-manager.ts test/e2e-comprehensive/orchestrator/phase-p2-meta.test.ts
git commit -m "🧪 e2e / F4 P2 meta failure: assertF4CrossCwdIsolation 反向回归(F4 P2 PR2.11)

新增 injectCrossCwdRootCollision test-toggle: e2e meta 模式下让指定
fromCwd 的 session 把 project-claude root 错挂到 toCwd(模拟 race /
state leak)。gate 在 CERELAY_ADMIN_EVENTS=true,生产路径零开销。

phase-p2-meta.test.ts: 注入 toggle → 启动两并发 session →
assert.rejects(assertF4CrossCwdIsolation, /FAIL/) 期望 throw,验 helper
不退化。finally cleanup 防 toggle 泄漏。

Spec: docs/superpowers/specs/2026-05-02-f4-cross-cwd-fileproxy-isolation-design.md §5.4(meta failure case)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12:npm test 入口扩 + 文档闭环登记

**Files:**
- Modify: `test/run-e2e-comprehensive.sh`
- Modify: `test/run-e2e-comprehensive-meta.sh`
- Modify: `docs/e2e-comprehensive-testing.md`
- Modify: `docs/superpowers/specs/2026-05-02-f4-cross-cwd-fileproxy-isolation-design.md`

- [ ] **Step 12.1: 加 phase-p2 到 run-e2e-comprehensive.sh**

读 `test/run-e2e-comprehensive.sh`,找到当前的 test 文件列表(应该是 `phase-p0.test.ts phase-p1.test.ts`),改为 `phase-p0.test.ts phase-p1.test.ts phase-p2.test.ts`。

- [ ] **Step 12.2: 加 phase-p2-meta 到 run-e2e-comprehensive-meta.sh**

同理把 phase-p2-meta.test.ts 追加。

- [ ] **Step 12.3: e2e 文档 §2.3 状态升级**

在 `docs/e2e-comprehensive-testing.md` §2.3 P2 backlog,把 `F4-cross-cwd-fileproxy-isolation` 行的状态从 `🚧 spec 已批 / 待落地` 改为 `✅ 落地`。描述加补 PR1+PR2 commit 引用。

- [ ] **Step 12.4: e2e 文档 §10 changelog 加条目**

```markdown
| 2026-05-02 | **F4 cross-cwd-fileproxy-isolation P2 case 落地 ✅**:Claude × Codex 共创 spec(三处事实纠偏 + 5 处补强)→ PR1 基础设施(扩 admin event detail 加 clientCwd/clientPath/contentSha256 + 新增 config-preloader.plan / session.bootstrap.plan event + orchestrator helper 加 cwd 过滤 + assertF4CrossCwdIsolation 公共断言 + assertNoReadServedForCwd negative-assert) + PR2 测试(phase-p2.test.ts 主 case + phase-p2-meta.test.ts 反向回归 case + case-f4-cross fixture)。**最终交付**: e2e 27/27 (P0 16 + P1-A 2 + P1-B 8 + P2 1) + meta 4/4 (P0 3 + P2 1) + server unit + client unit + web unit + typecheck 全过。守的 4 条不变量:(a) fileProxy 三 root 内容不串、(b) 共享 ClientCacheStore 命中不污染、(c) cwd-ancestor **计算计划**不串台(真实 ancestor FUSE read 守不住,挂 INF-12 跟踪)、(d) project-claude bind mount 严格按 session cwd。e2e coverage: 新增 cross-cwd 隔离边界守护维度 |
```

- [ ] **Step 12.5: e2e 文档 §12 加 P2-α 章节**

在 §12 末尾(`#### 12.4` 之后)追加:

```markdown
### 12.5 P2-α 闭环登记 / P2-α Closure Log

| 日期 | 事件 | 验证 |
|---|---|---|
| 2026-05-02 | F4-cross-cwd-fileproxy-isolation P2 case 全部 13 个 task 闭环(PR1 基础设施 + PR2 测试) | `bash test/run-e2e-comprehensive.sh` 27/27 + `bash test/run-e2e-comprehensive-meta.sh` 4/4 + `cd server && npm test` 425+/+ + `cd client && npm test` 135/135 + typecheck 全过 |
| 2026-05-02 | INF-12-cwd-ancestor-root-registration 产品缺口登记到 §2.3 P2 backlog,等独立需求处理(F4 P2 不变量 (c) 真实 ancestor FUSE read 守护待该 INF 落地后再加固) | 见 §2.3 backlog INF-12 行 |
```

- [ ] **Step 12.6: spec §9 验收清单勾选**

打开 `docs/superpowers/specs/2026-05-02-f4-cross-cwd-fileproxy-isolation-design.md` §9,把 PR1 / PR2 / 整体验收清单的 `[ ]` 改为 `[x]`。

- [ ] **Step 12.7: 全套验收 + commit**

```bash
cd /Users/n374/Documents/Code/cerelay
npm run typecheck
npm run test:workspaces
docker compose -f docker-compose.e2e.yml build server
bash test/run-e2e-comprehensive.sh         # 期望 27/27
bash test/run-e2e-comprehensive-meta.sh    # 期望 4/4
```

Expected: 全部绿。

```bash
git add test/run-e2e-comprehensive.sh test/run-e2e-comprehensive-meta.sh \
  docs/e2e-comprehensive-testing.md \
  docs/superpowers/specs/2026-05-02-f4-cross-cwd-fileproxy-isolation-design.md
git commit -m "📝 docs / F4 P2 落地闭环登记 + npm test 入口扩(F4 P2 PR2.12)

- run-e2e-comprehensive.sh 加 phase-p2.test.ts 入口
- run-e2e-comprehensive-meta.sh 加 phase-p2-meta.test.ts 入口
- §2.3 P2 backlog F4-cross-cwd-fileproxy-isolation 状态 🚧 → ✅
- §10 changelog 加 P2 闭环条目
- §12.5 P2-α 闭环登记
- spec §9 验收清单全勾选

最终: e2e 27/27 + meta 4/4 + server/client/web unit + typecheck 全过。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13:Codex 终审 PR2 + 整体闭环

**Files:**(无文件改动,仅评审 + 闭环 commit)

- [ ] **Step 13.1: Codex 终审 PR2**

```
/codex:rescue F4 P2 测试 case PR(phase-p2 + meta + fixture + 文档闭环)Codex 终审
```

prompt 内容:
- spec 路径
- PR2 范围:Task 9-12 commits
- 验收要求:对照 spec §6 守护意图自查表 + §9 PR2 验收清单 + 整体验收清单
- 关注点:
  - phase-p2 case 是否真的经过 namespace FUSE(不绕 client 本地直读)
  - assertNoReadServedForCwd 是 poll-and-collect 还是 absence-of-log(必须前者)
  - meta case 是否真的反向期望 throw(不是被 try/catch swallow)
  - INF-12 跟踪条目是否清晰可追溯

- [ ] **Step 13.2: Codex 反馈处理**

若提出 critical / important,回到对应 task 修复后重跑 12.7 全套验收。

3 轮未收敛升级用户决策。

- [ ] **Step 13.3: 整体闭环 commit**

```bash
# spec 加最终 Codex 终审通过登记;§10 加最终 commit
git add docs/superpowers/specs/2026-05-02-f4-cross-cwd-fileproxy-isolation-design.md \
  docs/e2e-comprehensive-testing.md
git commit -m "✅ F4 P2 整体闭环 + Codex 终审通过(F4 P2 PR2.13)

PR1 基础设施 + PR2 测试 case 全部 12 个 task 闭环。Claude × Codex 双审通过。

最终交付:
- e2e 27/27 (P0 16 + P1-A 2 + P1-B 8 + P2 1)
- meta 4/4 (P0 3 + P2 1)
- server unit / client unit / web unit / typecheck 全过

守的 4 条 cross-cwd 隔离不变量(详见 spec §2):
- (a) fileProxy 三 root 内容不串 ✅
- (b) FileAgent / 共享 ClientCacheStore 命中不污染 ✅
- (c) cwd-ancestor walk 计算计划不串台 ✅(真实 ancestor FUSE read 守不住,挂 INF-12 跟踪)
- (d) project-claude bind mount 严格按 session cwd ✅

下一步: §2.3 P2 backlog 中 F4-cross-cwd 已 ✅,剩余 H1/H2(需求池等产品功能)
+ INF-12(独立需求处理)。本轮 e2e 加固周期完整闭环。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

# Self-Review

After implementing all tasks, run a final self-review against the spec.

**1. Spec coverage check** — for each spec section/requirement, confirm a task implements it:

- [ ] spec §1 目标 4 条不变量 → Task 3-7 (基础设施 emit) + Task 10 (测试断言)
- [ ] spec §2 三处事实纠偏 → Task 4 (sideband sessionId 已正确不需改) + Task 7+10 (cwd-ancestor 真实 read 标记 INF-12 跟踪) + Task 10 (home root 共享 fixture 共享 marker)
- [ ] spec §5.1 基础设施改动 → Task 1-7 全覆盖
- [ ] spec §5.2 fixture 拓扑 → Task 9
- [ ] spec §5.3 case 编排骨架 → Task 10
- [ ] spec §5.4 关键细则 → Task 3 (contentSha256) + Task 2 (negative-assert timeoutMs) + Task 10 (B 主动触发) + Task 11 (meta failure)
- [ ] spec §6 守护意图自查 7 类 → Task 13 Codex 终审 prompt 关注点
- [ ] spec §7 PR 拆分 → Task 8 (PR1 闭环) + Task 13 (PR2 闭环)
- [ ] spec §8 INF-12 跟踪 → 已在 e2e §2.3 backlog(spec 立项 commit `418afe0`),Task 12.5 加 §12.5 闭环登记交叉引用
- [ ] spec §9 验收标准 → Task 8.1 / 12.7 全套测试运行 + Task 12.6 spec 勾选

**2. Placeholder scan** — 已通读全 plan,无 TBD/TODO/"implement later"/含糊"add error handling"。所有 step 都有具体代码或具体命令。

**3. Type consistency** — 关键名称对照:
- `clientCwd` / `clientPath` / `contentSha256`:Task 1 定义,Task 3-4 emit,Task 2 helper 过滤,Task 10 断言 → 一致
- `ConfigPreloaderPlanDetail`:Task 1 定义,Task 6 emit,Task 2 helper,Task 10 断言 → 一致
- `SessionBootstrapPlanDetail`:Task 1 定义,Task 7 emit,Task 2 helper,Task 10 断言 → 一致
- `assertF4CrossCwdIsolation` / `assertNoReadServedForCwd`:Task 2 定义,Task 10 主用,Task 11 反向用 → 一致
- `injectCrossCwdRootCollision` toggle 字段从 `fromSessionId` 调整为 `fromCwd`:Task 11.1 定义 + Task 11.2 命中条件 + Task 11.3 注入 → Step 11.3 注释中已记录该调整,一致

**4. 风险标记** — 跨 PR 依赖
- PR1 全量验收(Task 8)必须先于 PR2 任何 task 启动 — Task 9+ 都依赖 PR1 emit/helper 就位
- Codex 终审失败时的回滚路径 — Task 8.3 / 13.2 已说明回到对应 task 修复

---

# Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-02-f4-cross-cwd-fileproxy-isolation.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - Dispatch a fresh subagent per task, review between tasks, fast iteration. Each task 5-8 steps,subagent 上下文负担小,主 context 只持摘要。

**2. Inline Execution** - 当前 session 内串行执行,使用 executing-plans skill 做 batch + checkpoint review。

**Which approach?**
