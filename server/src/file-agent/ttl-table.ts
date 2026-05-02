// FileAgent 内部 TTL 表：跟踪每条 absPath cache 的 expiresAt 时间戳。
//
// 设计要点（plan §3.2）：
//   - 每次 read/stat/readdir/prefetch 命中或写入，bump expiresAt = max(existing, now + ttlMs)
//   - 用 max 而非覆盖，避免短 ttl 调用把长 ttl 已留的 entry 提早干掉
//   - Task 7 GC 时基于 expiresAt < now 决定 evict
//
// 与 manifest 的关系：
//   - manifest 存"内容是什么"（store 负责），TTL 表存"内容应保留多久"（这里负责）
//   - 两个分离，避免 manifest schema 频繁迁移；GC 时联动
//
// 持久化策略（本期）：暂不持久化——server 重启后 TTL 表清空，下次 read 时重新 bump。
// 副作用：重启后已 cache 的 entries 没有 TTL 记录，GC 不会清它们直到再被 read 一次。
// 这对 startupTtl=7d 的场景不是问题，长期使用看测试再优化。

export interface TtlTableSnapshot {
  /** absPath → expiresAt（unix ms），仅含未过期的项。 */
  active: Record<string, number>;
}

export class TtlTable {
  private readonly entries = new Map<string, number>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Bump 一个 path 的 expiresAt：max(existing, this.now() + ttlMs)。
   * 拒绝 ttlMs ≤ 0 / Infinity / NaN（运行时强校验，对应 plan §3.2 P4）。
   */
  bump(absPath: string, ttlMs: number): void {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new RangeError(
        `FileAgent ttlMs 必须是有限正数（不允许 0 / 负数 / Infinity / NaN）；收到 ${ttlMs}`,
      );
    }
    const candidate = this.now() + ttlMs;
    const existing = this.entries.get(absPath);
    if (existing === undefined || candidate > existing) {
      this.entries.set(absPath, candidate);
    }
  }

  /** 查询某 path 的 expiresAt（未跟踪返回 null）。 */
  getExpiresAt(absPath: string): number | null {
    return this.entries.get(absPath) ?? null;
  }

  /**
   * 判断某 path 当前是否过期（未跟踪视为"已过期"——Task 7 GC 时考虑同时清掉
   * manifest 中没 TTL 记录的 entries 还是保留它们，由 GC 策略决定）。
   */
  isExpired(absPath: string): boolean {
    const expiresAt = this.entries.get(absPath);
    if (expiresAt === undefined) return true;
    return expiresAt < this.now();
  }

  /** 移除单条 TTL 跟踪（path 在 manifest 中被删时调用，避免 TTL 表无限累积）。 */
  drop(absPath: string): void {
    this.entries.delete(absPath);
  }

  /** Snapshot —— 仅含未过期的项（Task 7 GC 用）。 */
  snapshot(): TtlTableSnapshot {
    const now = this.now();
    const active: Record<string, number> = {};
    for (const [p, exp] of this.entries) {
      if (exp >= now) {
        active[p] = exp;
      }
    }
    return { active };
  }

  /**
   * 仅收集过期 paths（不从表移除）。GC 调用方决定要不要 drop——遇到 in-flight 时
   * 跳过该 path 但**保留**ttl 条目，让下次 GC 重试。
   */
  collectExpired(): string[] {
    const now = this.now();
    const expired: string[] = [];
    for (const [p, exp] of this.entries) {
      if (exp < now) expired.push(p);
    }
    return expired;
  }

  /**
   * 把所有 expiresAt < now 的 path 收集出来并从表中移除（保留旧 API，便于过渡）。
   * 推荐 GC 用 collectExpired() + 选择性 drop()，给 in-flight 路径留缓刑。
   */
  collectAndDropExpired(): string[] {
    const expired = this.collectExpired();
    for (const p of expired) {
      this.entries.delete(p);
    }
    return expired;
  }

  /** 当前跟踪的 path 数量（含已过期未清的）。 */
  size(): number {
    return this.entries.size;
  }
}
