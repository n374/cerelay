import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";

interface BulkFixtureSpec {
  /** 相对 $HOME 的子目录（必须落在 $HOME 内）。 */
  pathPrefix: string;
  /** 生成的文件数。 */
  count: number;
  /** 每个文件字节数（写入填充字符串，长度 = bytesPerFile）。 */
  bytesPerFile: number;
}

interface RunRequest {
  prompt: string;
  cwd: string;
  deviceLabel?: string;     // 仅日志用
  extraArgs?: string[];
  timeoutMs?: number;
  // 在 spawn client 前往 $HOME/<rel> 写入 fixture，run 结束后默认 best-effort 清理。
  // 用于 B1（~/.claude/<file>）/ B2（~/.claude.json）/ E1（settings.json 含 secret）。
  homeFixture?: Record<string, string>;
  // 默认 false：run 结束后删除 homeFixture 中列出的文件（不动目录）。设为 true 则保留。
  homeFixtureKeepAfter?: boolean;
  // 批量生成 fixture（用于 C1/C2 1k+ 文件 initial sync 压测）；
  // 与 homeFixture 同时生效，run 结束后 best-effort 删除整个 pathPrefix 子目录。
  homeFixtureBulk?: BulkFixtureSpec;
}

interface RunResponse {
  exitCode: number;
  stdout: string;
  stderr: string;
  sessionId: string;        // 由 agent 生成（client 内部 sessionId 由 server 端分配，agent 仅给一个 trace id）
  durationMs: number;
  deviceId: string;         // 容器持久化的 device-id，便于 orchestrator 查 server cache manifest
}

const CLIENT_BIN = process.env.CLIENT_BIN || "/app/client/dist/index.js";
const SERVER_URL = process.env.SERVER_URL || "ws://server:8765/ws";

// ============================================================
// INF-3: async run 状态管理
// ============================================================
// runStates Map<runId, RunState> 用于追踪所有 async 起的 child process。
// 同步 /run 不进 Map（向后兼容,P0/P1-A 18 case 完全不感知）。
//
// 治理策略（Codex PR2 review #2）:
//   - completed (exited/killed) 状态保留 RUN_STATE_TTL_MS = 5 min 后 GC
//   - Map 上限 RUN_STATE_MAX = 50 条,超出按 LRU 淘汰最早 completed 的
//   - 单条 stdout/stderr buffer 上限 RUN_STATE_BUFFER_CAP = 4 MB,超出截断尾部
//   - running 状态永远不淘汰（避免误杀活跃 session）
// ============================================================
const RUN_STATE_TTL_MS = 5 * 60 * 1000;
const RUN_STATE_MAX = 50;
const RUN_STATE_BUFFER_CAP = 4 * 1024 * 1024;

interface RunStateBase {
  runId: string;
  child: ChildProcess;
  startedAt: number;
  deviceId: string;
  stdoutChunks: Buffer[];
  stderrChunks: Buffer[];
  /** 累计 stdout 字节,达到 RUN_STATE_BUFFER_CAP 后停止追加。 */
  stdoutBytes: number;
  stderrBytes: number;
  /** 已注册的 wait promise 列表（POST /admin/run/{id}/wait 用）。 */
  waiters: Array<(s: RunState) => void>;
  /** Cleanup（fixture 删除）promise,exit 后异步执行;status 查询不需要等它。 */
  cleanup: Promise<void> | null;
  /** 同步模式标记,true = /run（已 await 完成）;false = /run-async（runState 进 Map）。 */
  isAsync: boolean;
}

interface RunStateRunning extends RunStateBase {
  state: "running";
  exitCode: null;
  durationMs: null;
  killedAt: null;
}

interface RunStateExited extends RunStateBase {
  state: "exited";
  exitCode: number;
  durationMs: number;
  killedAt: null;
  /** completed 时间戳,用于 TTL GC */
  completedAt: number;
}

interface RunStateKilled extends RunStateBase {
  state: "killed";
  exitCode: number | null;
  durationMs: number;
  killedAt: number;
  completedAt: number;
}

type RunState = RunStateRunning | RunStateExited | RunStateKilled;

const runStates = new Map<string, RunState>();

function appendBuffer(state: RunStateBase, which: "stdout" | "stderr", chunk: Buffer): void {
  const cap = RUN_STATE_BUFFER_CAP;
  if (which === "stdout") {
    if (state.stdoutBytes >= cap) return;
    const remaining = cap - state.stdoutBytes;
    const slice = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
    state.stdoutChunks.push(slice);
    state.stdoutBytes += slice.byteLength;
  } else {
    if (state.stderrBytes >= cap) return;
    const remaining = cap - state.stderrBytes;
    const slice = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
    state.stderrChunks.push(slice);
    state.stderrBytes += slice.byteLength;
  }
}

function gcRunStates(): void {
  const now = Date.now();
  // TTL: 删 completed 且超过 TTL 的
  for (const [id, s] of runStates) {
    if ((s.state === "exited" || s.state === "killed") && s.completedAt + RUN_STATE_TTL_MS < now) {
      runStates.delete(id);
    }
  }
  // LRU: 超上限时按 completedAt 升序删最早 completed 的
  if (runStates.size > RUN_STATE_MAX) {
    const completed = [...runStates.values()]
      .filter((s): s is RunStateExited | RunStateKilled => s.state !== "running")
      .sort((a, b) => a.completedAt - b.completedAt);
    const toRemove = runStates.size - RUN_STATE_MAX;
    for (let i = 0; i < toRemove && i < completed.length; i++) {
      runStates.delete(completed[i].runId);
    }
  }
}

function statusResponse(state: RunState): {
  runId: string;
  state: "running" | "exited" | "killed";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  deviceId: string;
  durationMs: number | null;
  startedAt: number;
} {
  return {
    runId: state.runId,
    state: state.state,
    exitCode: state.exitCode,
    stdout: Buffer.concat(state.stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(state.stderrChunks).toString("utf8"),
    deviceId: state.deviceId,
    durationMs: state.durationMs,
    startedAt: state.startedAt,
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const HOME_DIR = process.env.HOME || "/home/clientuser";
const DEVICE_ID_PATH = path.join(
  process.env.XDG_CONFIG_HOME || path.join(HOME_DIR, ".config"),
  "cerelay",
  "device-id",
);

async function readDeviceId(): Promise<string> {
  try {
    return (await readFile(DEVICE_ID_PATH, "utf8")).trim();
  } catch {
    return "";
  }
}

// meta-deviceid-collision 测试用：把持久化 device-id 文件覆写成指定值，让 client
// 进程（read 这个文件）拿到伪造 ID，模拟两个容器共用同一 deviceId 的 regression。
// 同时记录原始值，reset 时恢复，避免污染同一 process 后续测试。
let backupDeviceId: string | null = null;
async function setForcedDeviceId(forced: string | null): Promise<void> {
  if (forced === null) {
    if (backupDeviceId !== null) {
      await mkdir(path.dirname(DEVICE_ID_PATH), { recursive: true });
      await writeFile(DEVICE_ID_PATH, backupDeviceId, "utf8");
      backupDeviceId = null;
    }
    return;
  }
  if (backupDeviceId === null) {
    backupDeviceId = await readDeviceId();
  }
  await mkdir(path.dirname(DEVICE_ID_PATH), { recursive: true });
  await writeFile(DEVICE_ID_PATH, forced, "utf8");
}

async function applyHomeFixture(files: Record<string, string>): Promise<string[]> {
  const written: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    // 拒绝绝对路径或上跳：fixture 必须落在 $HOME 内
    if (rel.startsWith("/") || rel.split("/").some((seg) => seg === "..")) {
      throw new Error(`homeFixture rel must be inside $HOME: ${rel}`);
    }
    const abs = path.join(HOME_DIR, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
    written.push(abs);
    // eslint-disable-next-line no-console
    console.log(`[client-agent] homeFixture wrote ${abs} (${content.length} bytes)`);
  }
  return written;
}

interface BulkWriteResult {
  rootAbs: string;       // 创建的根目录绝对路径，cleanup 时整个 rmrf
  fileCount: number;
}

async function applyHomeFixtureBulk(spec: BulkFixtureSpec): Promise<BulkWriteResult> {
  if (
    spec.pathPrefix.startsWith("/") ||
    spec.pathPrefix.split("/").some((seg) => seg === "..")
  ) {
    throw new Error(`homeFixtureBulk pathPrefix must be inside $HOME: ${spec.pathPrefix}`);
  }
  const rootAbs = path.join(HOME_DIR, spec.pathPrefix);
  await mkdir(rootAbs, { recursive: true });
  // 内容用 'A' 填充到目标字节数；每个文件包含 idx 串保证 sha256 不重复
  // （否则 dedup blob 池只剩 1 个 blob，无法压测 manifest entryCount/revision）。
  for (let i = 0; i < spec.count; i += 1) {
    const idxStr = String(i).padStart(6, "0");
    const head = `bulk-${idxStr}\n`;
    const padLen = Math.max(0, spec.bytesPerFile - head.length);
    const content = head + "A".repeat(padLen);
    const abs = path.join(rootAbs, `bulk_${idxStr}.txt`);
    await writeFile(abs, content, "utf8");
  }
  return { rootAbs, fileCount: spec.count };
}

async function cleanupHomeFixture(absPaths: string[]): Promise<void> {
  // 特例：~/.claude.json 不删除——CC 启动期会 parse 它，缺文件直接退出 1。
  // 容器 entrypoint 只在启动时写 "{}"，运行时再 rm 会让下个 case 的 CC 启动失败。
  // 因此 cleanup 时把 .claude.json 重置为空对象保持下一 case 可启动。
  const claudeJsonAbs = path.join(HOME_DIR, ".claude.json");
  for (const p of absPaths) {
    try {
      if (p === claudeJsonAbs) {
        await writeFile(p, "{}", "utf8");
      } else {
        await rm(p, { force: true });
      }
    } catch { /* best-effort */ }
  }
}

// ============================================================
// 共享底层：spawn child + 装上 stdio/exit handlers
// ============================================================
// runClient (sync /run) 与 runClientAsync (async /run-async) 都通过此函数起 child;
// 只是后续等不等 exit 不同。
// ============================================================
async function startClientRun(req: RunRequest): Promise<{
  state: RunState;
  homeFixtureWritten: string[];
  homeFixtureBulkWritten: BulkWriteResult | null;
}> {
  const traceId = randomUUID();
  const startedAt = Date.now();
  const args = [
    CLIENT_BIN,
    "--server", SERVER_URL,
    "--cwd", req.cwd,
    "--prompt", req.prompt,
    ...(req.extraArgs ?? []),
  ];

  const homeFixtureWritten = req.homeFixture
    ? await applyHomeFixture(req.homeFixture)
    : [];
  const homeFixtureBulkWritten = req.homeFixtureBulk
    ? await applyHomeFixtureBulk(req.homeFixtureBulk)
    : null;
  const deviceId = await readDeviceId();

  // 诊断：spawn 前列出 ~/.claude 内容
  if (req.homeFixture || req.homeFixtureBulk) {
    try {
      const { readdir } = await import("node:fs/promises");
      const claudeDir = path.join(HOME_DIR, ".claude");
      const entries = await readdir(claudeDir, { withFileTypes: true });
      // eslint-disable-next-line no-console
      console.log(
        `[client-agent] pre-spawn ${claudeDir} contains: ${entries.map((e) => e.name + (e.isDirectory() ? "/" : "")).join(", ") || "(empty)"}`,
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log(`[client-agent] pre-spawn readdir failed: ${err}`);
    }
  }

  const child = spawn("node", args, {
    env: {
      ...process.env,
      CERELAY_E2E_TRACE_ID: traceId,
      CERELAY_E2E_DEVICE_LABEL: req.deviceLabel || "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const state: RunStateRunning = {
    runId: traceId,
    child,
    startedAt,
    deviceId,
    stdoutChunks: [],
    stderrChunks: [],
    stdoutBytes: 0,
    stderrBytes: 0,
    waiters: [],
    cleanup: null,
    isAsync: false,           // 调用方根据自身路径覆盖
    state: "running",
    exitCode: null,
    durationMs: null,
    killedAt: null,
  };

  child.stdout?.on("data", (c) => appendBuffer(state, "stdout", Buffer.from(c)));
  child.stderr?.on("data", (c) => appendBuffer(state, "stderr", Buffer.from(c)));

  return { state, homeFixtureWritten, homeFixtureBulkWritten };
}

/** child exit / error 后跑的清理 + 状态翻转,sync/async 共用。 */
function finalizeRun(opts: {
  state: RunState;
  exitCode: number | null;
  homeFixtureWritten: string[];
  homeFixtureBulkWritten: BulkWriteResult | null;
  keepAfter: boolean | undefined;
  killed: boolean;
}): void {
  const now = Date.now();
  const newState = opts.killed
    ? Object.assign(opts.state as RunStateBase, {
        state: "killed" as const,
        exitCode: opts.exitCode,
        durationMs: now - opts.state.startedAt,
        killedAt: now,
        completedAt: now,
      })
    : Object.assign(opts.state as RunStateBase, {
        state: "exited" as const,
        exitCode: opts.exitCode ?? -1,
        durationMs: now - opts.state.startedAt,
        killedAt: null,
        completedAt: now,
      });

  // cleanup fixture (best-effort, 异步)
  newState.cleanup = (async () => {
    if (opts.keepAfter) return;
    await cleanupHomeFixture(opts.homeFixtureWritten);
    if (opts.homeFixtureBulkWritten) {
      try {
        await rm(opts.homeFixtureBulkWritten.rootAbs, { recursive: true, force: true });
      } catch { /* best-effort */ }
    }
  })();

  // 唤醒所有 waiter
  const waiters = newState.waiters.splice(0);
  for (const w of waiters) w(newState as RunState);

  // async 模式触发 GC
  if (newState.isAsync) gcRunStates();
}

async function runClient(req: RunRequest): Promise<RunResponse> {
  const { state, homeFixtureWritten, homeFixtureBulkWritten } = await startClientRun(req);
  state.isAsync = false;

  const timeoutMs = req.timeoutMs ?? 60_000;

  return await new Promise<RunResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      state.child.kill("SIGKILL");
      reject(new Error(`client timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    state.child.once("exit", async (code) => {
      clearTimeout(timer);
      finalizeRun({
        state,
        exitCode: code,
        homeFixtureWritten,
        homeFixtureBulkWritten,
        keepAfter: req.homeFixtureKeepAfter,
        killed: false,
      });
      // sync 模式必须等 cleanup 完成再返回（与原行为一致）
      await state.cleanup;
      resolve({
        exitCode: code ?? -1,
        stdout: Buffer.concat(state.stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(state.stderrChunks).toString("utf8"),
        sessionId: state.runId,
        durationMs: Date.now() - state.startedAt,
        deviceId: state.deviceId,
      });
    });

    state.child.once("error", async (err) => {
      clearTimeout(timer);
      finalizeRun({
        state,
        exitCode: null,
        homeFixtureWritten,
        homeFixtureBulkWritten,
        keepAfter: req.homeFixtureKeepAfter,
        killed: false,
      });
      await state.cleanup;
      reject(err);
    });
  });
}

/** INF-3: 异步起 child,立即返回 runId,后续 GET /admin/run/{id}/* 查询。 */
async function runClientAsync(req: RunRequest): Promise<{ runId: string }> {
  const { state, homeFixtureWritten, homeFixtureBulkWritten } = await startClientRun(req);
  state.isAsync = true;
  runStates.set(state.runId, state);

  // 安装 exit/error handler,exit 后翻状态 + 触发 cleanup + waiters
  const handleExit = (code: number | null) => {
    if (state.state !== "running") return; // 已被 kill 处理
    finalizeRun({
      state,
      exitCode: code,
      homeFixtureWritten,
      homeFixtureBulkWritten,
      keepAfter: req.homeFixtureKeepAfter,
      killed: false,
    });
  };
  state.child.once("exit", handleExit);
  state.child.once("error", () => handleExit(null));

  // 可选 timeout cleanup guard——不是同步 /run 那种"timeout = reject error"语义,
  // 而是 agent 层的兜底:防 child 卡住永远 running 占着 runState。
  // 触发时 finalizeRun({killed:true}) **先** 翻状态为 killed,再 child.kill,
  // 这样后续 child.once("exit") handler 中的 if (state !== "running") return
  // 守门会跳过 finalizeRun 的二次调用,状态保持 killed (Codex PR2 review important #1)。
  if (req.timeoutMs && req.timeoutMs > 0) {
    setTimeout(() => {
      if (state.state === "running") {
        finalizeRun({
          state,
          exitCode: null,
          homeFixtureWritten,
          homeFixtureBulkWritten,
          keepAfter: req.homeFixtureKeepAfter,
          killed: true,
        });
        try { state.child.kill("SIGKILL"); } catch { /* best-effort */ }
      }
    }, req.timeoutMs);
  }

  return { runId: state.runId };
}

// ============================================================
// HTTP 路由
// ============================================================
const server = createServer(async (req, res) => {
  try {
    if (req.url === "/healthz" && req.method === "GET") {
      return sendJson(res, 200, { ok: true });
    }
    if (req.url === "/device" && req.method === "GET") {
      const deviceId = await readDeviceId();
      return sendJson(res, 200, { deviceId });
    }
    if (req.url === "/admin/toggles" && req.method === "POST") {
      // meta-deviceid-collision 测试用：覆盖持久化 device-id 文件。
      const body = JSON.parse(await readBody(req)) as { forceDeviceId?: string; reset?: boolean };
      if (body.reset) {
        await setForcedDeviceId(null);
        return sendJson(res, 200, { ok: true, deviceId: await readDeviceId() });
      }
      if (typeof body.forceDeviceId === "string") {
        await setForcedDeviceId(body.forceDeviceId);
        return sendJson(res, 200, { ok: true, deviceId: body.forceDeviceId });
      }
      return sendJson(res, 400, { error: "forceDeviceId or reset required" });
    }
    if (req.url === "/run" && req.method === "POST") {
      const body = JSON.parse(await readBody(req)) as RunRequest;
      if (!body.prompt || !body.cwd) {
        return sendJson(res, 400, { error: "prompt + cwd required" });
      }
      try {
        const result = await runClient(body);
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, 500, { error: String(err) });
      }
    }
    // INF-3: async run 入口
    if (req.url === "/run-async" && req.method === "POST") {
      const body = JSON.parse(await readBody(req)) as RunRequest;
      if (!body.prompt || !body.cwd) {
        return sendJson(res, 400, { error: "prompt + cwd required" });
      }
      try {
        const result = await runClientAsync(body);
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, 500, { error: String(err) });
      }
    }
    // INF-3: status / kill / wait
    if (req.url && req.method === "GET") {
      const m = /^\/admin\/run\/([^/]+)\/status$/.exec(req.url);
      if (m) {
        const state = runStates.get(m[1]);
        if (!state) return sendJson(res, 404, { error: "unknown runId" });
        return sendJson(res, 200, statusResponse(state));
      }
    }
    if (req.url && req.method === "POST") {
      const killMatch = /^\/admin\/run\/([^/]+)\/kill$/.exec(req.url);
      if (killMatch) {
        const state = runStates.get(killMatch[1]);
        if (!state) return sendJson(res, 404, { error: "unknown runId" });
        if (state.state !== "running") {
          return sendJson(res, 200, { ok: true, alreadyDone: true, state: state.state });
        }
        // 先翻状态再 kill,避免 exit handler 把 killed 当 exited
        finalizeRun({
          state,
          exitCode: null,
          homeFixtureWritten: [],
          homeFixtureBulkWritten: null,
          keepAfter: true,    // kill 路径不动 fixture（外部测试可能还要查）
          killed: true,
        });
        try { state.child.kill("SIGKILL"); } catch { /* best-effort */ }
        return sendJson(res, 200, { ok: true, state: "killed" });
      }
      const waitMatch = /^\/admin\/run\/([^/]+)\/wait$/.exec(req.url);
      if (waitMatch) {
        const state = runStates.get(waitMatch[1]);
        if (!state) return sendJson(res, 404, { error: "unknown runId" });
        const body = JSON.parse(await readBody(req)) as { timeoutMs?: number };
        const timeoutMs = body.timeoutMs ?? 60_000;
        if (state.state !== "running") {
          return sendJson(res, 200, statusResponse(state));
        }
        const result = await new Promise<RunState | null>((resolve) => {
          const timer = setTimeout(() => resolve(null), timeoutMs);
          state.waiters.push((s) => {
            clearTimeout(timer);
            resolve(s);
          });
        });
        if (!result) return sendJson(res, 504, { error: "wait timeout", state: "running" });
        return sendJson(res, 200, statusResponse(result));
      }
    }
    // INF-4: mutate-home-fixture（C3-runtime-delta 用）。
    //
    // 注意（Codex PR2 review important #4）:
    //   - 复用 applyHomeFixture,**没有 cleanup** —— 调用方负责后续清理或覆盖
    //   - 当前**未禁止**写 .claude.json (cleanup 特例),但 mutate 不进 RunRequest
    //     的 cleanupHomeFixture 路径,理论上不会触发"被 rm 后 CC 启动失败"。
    //     调用方仍应避免直接 mutate .claude.json,如有需要走专用 helper。
    //   - log "homeFixture wrote" 复用了原 fixture 写入的 prefix,是有意为之
    //     (调用栈一致),诊断时按 endpoint 路由区分 pre-run vs runtime mutation
    if (req.url === "/admin/mutate-home-fixture" && req.method === "POST") {
      try {
        const body = JSON.parse(await readBody(req)) as { files: Record<string, string> };
        if (!body.files || typeof body.files !== "object") {
          return sendJson(res, 400, { error: "files required" });
        }
        const written = await applyHomeFixture(body.files);
        // eslint-disable-next-line no-console
        console.log(`[client-agent] /admin/mutate-home-fixture wrote ${written.length} files`);
        return sendJson(res, 200, { ok: true, written });
      } catch (err) {
        return sendJson(res, 400, { error: String(err) });
      }
    }
    sendJson(res, 404, { error: "not found", url: req.url });
  } catch (err) {
    sendJson(res, 500, { error: String(err) });
  }
});

const port = Number.parseInt(process.env.PORT || "9100", 10);
server.listen(port, () => {
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr !== null ? addr.port : port;
  // eslint-disable-next-line no-console
  console.log(`[client-agent] listening on :${actualPort} → ${SERVER_URL} (bin=${CLIENT_BIN})`);
});
