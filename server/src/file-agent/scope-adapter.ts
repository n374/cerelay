// FileAgent 内部使用的 absPath ↔ scope+rel 适配层。
// 详见 plan §2 P7/P8：协议字段不新增，scope 适配在 FileAgent 内部完成。
//
// 当前 scope 集合（与 client 协议保持一致）：
//   - "claude-home": 对应 ${homeDir}/.claude/<rel>
//   - "claude-json": 对应 ${homeDir}/.claude.json（rel = ""）

import path from "node:path";
import type { CacheScope } from "../protocol.js";
import { pathStartsWithRoot } from "../path-utils.js";

export interface ScopeRel {
  scope: CacheScope;
  relPath: string;
}

/**
 * absPath → scope+rel 适配器。Per-FileAgent 持有 homeDir 配置。
 *
 * 不在已知 scope 范围内的路径返回 null（调用方应当 fallback：read miss 时仍要穿透
 * client，但因为没有 scope 落地不写 cache）。
 */
export class ScopeAdapter {
  private readonly homeClaudeRoot: string;
  private readonly homeClaudeJsonPath: string;

  constructor(public readonly homeDir: string) {
    const resolvedHome = path.resolve(homeDir);
    this.homeClaudeRoot = path.join(resolvedHome, ".claude");
    this.homeClaudeJsonPath = path.join(resolvedHome, ".claude.json");
  }

  /** absPath → scope+rel；不在已知 scope 内时返回 null。 */
  toScopeRel(absPath: string): ScopeRel | null {
    if (absPath === this.homeClaudeJsonPath) {
      return { scope: "claude-json", relPath: "" };
    }
    if (pathStartsWithRoot(absPath, this.homeClaudeRoot)) {
      const rel = absPath === this.homeClaudeRoot
        ? ""
        : absPath.slice(this.homeClaudeRoot.length + 1);
      return { scope: "claude-home", relPath: rel };
    }
    return null;
  }

  /** scope+rel → absPath。 */
  toAbsPath(scope: CacheScope, relPath: string): string {
    if (scope === "claude-json") {
      return this.homeClaudeJsonPath;
    }
    // claude-home
    return relPath ? path.join(this.homeClaudeRoot, relPath) : this.homeClaudeRoot;
  }
}
