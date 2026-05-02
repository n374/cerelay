// 与 Client 交互的协议层 v1（plan §2 P7：协议消息构造/解析与业务逻辑分离）。
//
// 当前职责：
//   - 把 absPath 翻译成现有 cache_task_* 协议消息（保 P8：协议字段不新增）
//   - 提供"单 path fetch"的 ScopeWalkInstruction 构造（Task 9 cache-task-manager 派发用）
//
// 未来若要抽独立"协议层模块"（plan §9 Out of Scope），只需替换 v1 实现，业务逻辑
// （sync-coordinator）不动。

import type { CacheScope, CacheTaskChange, ScopeWalkInstruction, SyncPlan } from "../protocol.js";
import type { ScopeAdapter } from "./scope-adapter.js";

/**
 * 把单个 absPath 包装成"微型 SyncPlan"，让 active client 只针对这一项做 walk。
 * 用于 FileAgent.read miss 时穿透——sync-coordinator 派发该 plan 给 active client。
 *
 * 注意：plan 字段保持现有 ScopeWalkInstruction 形态（subtrees + files + knownMissing），
 * 不引入新字段（plan §2 P8）。
 */
export function buildSinglePathFetchPlan(
  absPath: string,
  scopeAdapter: ScopeAdapter,
): SyncPlan | null {
  const sr = scopeAdapter.toScopeRel(absPath);
  if (!sr) return null;

  const instruction: ScopeWalkInstruction = {
    subtrees: [],
    files: [sr.relPath],
    knownMissing: [],
  };

  // 仅生成包含该单 scope 的 plan；其他 scope 缺省（client 跳过）。
  const scopes: SyncPlan["scopes"] = {};
  if (sr.scope === "claude-home") scopes["claude-home"] = instruction;
  else if (sr.scope === "claude-json") scopes["claude-json"] = instruction;
  return { scopes };
}

/**
 * 从一批 cache_task_delta change 中筛出某个 absPath 的 change。
 * 用于 sync-coordinator 在 fetch 路径下从 client 推送中提取目标 entry。
 */
export function findChangeForAbsPath(
  changes: CacheTaskChange[],
  absPath: string,
  scopeAdapter: ScopeAdapter,
): CacheTaskChange | null {
  const sr = scopeAdapter.toScopeRel(absPath);
  if (!sr) return null;
  for (const c of changes) {
    if (c.scope === sr.scope && c.path === sr.relPath) {
      return c;
    }
  }
  return null;
}

/** 把 sync-coordinator 拿到的 change 投影成 (absPath, scope, relPath) 三元组。 */
export function projectChangeAbsPath(
  change: CacheTaskChange,
  scopeAdapter: ScopeAdapter,
): { absPath: string; scope: CacheScope; relPath: string } {
  const absPath = scopeAdapter.toAbsPath(change.scope, change.path);
  return { absPath, scope: change.scope, relPath: change.path };
}
