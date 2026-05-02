// 配置预加载模块（plan §4）。
//
// 职责：所有"配置加载范围决策"的唯一来源——
//   1. 启动期算访问范围（home + cwd 父链 CLAUDE.md）
//   2. 调 fileAgent.prefetch 一次性预热文件到 cache
//   3. 提供 namespace mount plan 给 claude-session-runtime（决定 bootstrap mount 哪些 ancestor）
//
// 关键约束：
//   - 同步阻塞 session 启动（异步预热毫无意义）
//   - 调用方应 await preheat() 完成后才 spawn CC
//   - ttlMs 必须有限正数（推荐 7 天 = 604_800_000 ms）

import path from "node:path";
import type { FileAgent, PrefetchItem, PrefetchResult } from "./file-agent/index.js";
import { computeAncestorChain } from "./path-utils.js";
import { createLogger } from "./logger.js";
import type { AdminEventBuffer } from "./admin-events.js";

const log = createLogger("config-preloader");

export interface ConfigPreloaderOptions {
  homeDir: string;
  cwd: string;
  fileAgent: FileAgent;
  /** 启动期 ttl，必须为有限正数（推荐 7 天 = 604_800_000 ms）。 */
  ttlMs: number;
  /**
   * 整体超时（默认 30s）。超时仅用于异常 fallback 不阻塞 session 启动；
   * 正常流程同步阻塞等 prefetch 完成。
   */
  totalTimeoutMs?: number;
  /** session 标识，用于 admin event 关联（可选）。 */
  sessionId?: string;
  /** admin event buffer，用于 e2e probe（可选；未注入时静默跳过）。 */
  adminEvents?: AdminEventBuffer;
}

export interface NamespaceMountPlan {
  /** 父链目录（用于 bootstrap 中按级 mount-bind ancestor CLAUDE.md / CLAUDE.local.md）。 */
  ancestorDirs: string[];
  /** home 目录路径。 */
  homeDir: string;
  /** cwd。 */
  cwd: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class ConfigPreloader {
  private readonly homeDir: string;
  private readonly cwd: string;
  private readonly fileAgent: FileAgent;
  private readonly ttlMs: number;
  private readonly totalTimeoutMs: number;
  private readonly sessionId: string | undefined;
  private readonly adminEvents: AdminEventBuffer | undefined;

  constructor(opts: ConfigPreloaderOptions) {
    if (!Number.isFinite(opts.ttlMs) || opts.ttlMs <= 0) {
      throw new RangeError(
        `ConfigPreloader ttlMs 必须是有限正数；收到 ${opts.ttlMs}`,
      );
    }
    this.homeDir = opts.homeDir;
    this.cwd = opts.cwd;
    this.fileAgent = opts.fileAgent;
    this.ttlMs = opts.ttlMs;
    this.totalTimeoutMs = opts.totalTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.sessionId = opts.sessionId;
    this.adminEvents = opts.adminEvents;
  }

  /**
   * 计算访问范围 + 调 fileAgent.prefetch 一次完成预热。
   * 同步阻塞调用方——直到 prefetch 返回（或超时）才 resolve。
   */
  async preheat(): Promise<PrefetchResult> {
    const items = this.buildPrefetchItems();
    if (items.length === 0) {
      return {
        fetched: 0,
        alreadyHot: 0,
        missing: 0,
        failed: [],
        durationMs: 0,
      };
    }

    log.info("ConfigPreloader 启动期预热开始", {
      homeDir: this.homeDir,
      cwd: this.cwd,
      itemCount: items.length,
      ttlMs: this.ttlMs,
    } as Record<string, unknown>);

    const result = await Promise.race([
      this.fileAgent.prefetch(items, this.ttlMs),
      this.timeoutPromise(),
    ]);

    log.info("ConfigPreloader 预热完成", result as unknown as Record<string, unknown>);
    return result;
  }

  /**
   * 返回 namespace 内需要 bind-mount 的路径计划。
   * claude-session-runtime 调用此方法转换成 bootstrap shell 脚本的 env var
   * （CERELAY_ANCESTOR_DIRS 等）；不再自己算 ancestor chain。
   */
  getNamespaceMountPlan(): NamespaceMountPlan {
    return {
      ancestorDirs: computeAncestorChain(this.cwd, this.homeDir),
      homeDir: this.homeDir,
      cwd: this.cwd,
    };
  }

  /**
   * 拼装一次性的 PrefetchItem[]。
   *   - homeDir/.claude → dir-recursive
   *   - homeDir/.claude.json → file
   *   - ancestorChain × {CLAUDE.md, CLAUDE.local.md} → file（每个一项）
   * cwd === homeDir 时 ancestor 部分为空。
   */
  private buildPrefetchItems(): PrefetchItem[] {
    const items: PrefetchItem[] = [];

    // home 目录 .claude 整棵子树（需要 fetcher.fetchReaddir 才能展开；
    // 配置 dispatcher 后才能真正预热——Task 9 接通时启用）
    items.push({
      kind: "dir-recursive",
      absPath: path.join(this.homeDir, ".claude"),
    });
    items.push({
      kind: "file",
      absPath: path.join(this.homeDir, ".claude.json"),
    });

    // 父链 CLAUDE.md / CLAUDE.local.md
    const ancestorChain = computeAncestorChain(this.cwd, this.homeDir);
    for (const dir of ancestorChain) {
      items.push({ kind: "file", absPath: path.join(dir, "CLAUDE.md") });
      items.push({ kind: "file", absPath: path.join(dir, "CLAUDE.local.md") });
    }

    // F4 P2 不变量 (c) probe — config-preloader.plan
    // 把 ancestor chain 和 prefetch items 暴露给 admin events，e2e 用此守
    // "session A 的预热计划不串到 session B 的 cwd 子树"。
    // preheat() 内只调一次，不重复 emit。
    // 仅在 adminEvents 与 sessionId 都注入时 emit——否则顶层 sessionId 为 null，
    // e2e findPlan({sessionId}) 过滤失效，event 写出去也无消费方。
    if (this.adminEvents && this.sessionId) {
      this.adminEvents.record("config-preloader.plan", this.sessionId, {
        clientCwd: this.cwd,
        homeDir: this.homeDir,
        ancestorDirs: ancestorChain.slice(),
        prefetchAbsPaths: items.map((it) => it.absPath),
      });
    }

    return items;
  }

  private timeoutPromise(): Promise<PrefetchResult> {
    return new Promise((_resolve, reject) => {
      setTimeout(() => {
        reject(
          new Error(
            `ConfigPreloader.preheat 超时（${this.totalTimeoutMs}ms）`,
          ),
        );
      }, this.totalTimeoutMs).unref?.();
    });
  }
}
