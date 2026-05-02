import path from "node:path";
import type { AccessLedgerRuntime } from "./access-ledger.js";
import type { ScopeWalkInstruction, SyncPlan } from "./protocol.js";
import { SEED_WHITELIST } from "./seed-whitelist.js";

export interface ComputeSyncPlanArgs {
  ledger: AccessLedgerRuntime;
  homedir: string;
}

export function computeSyncPlan({ ledger, homedir }: ComputeSyncPlanArgs): SyncPlan {
  const allPaths = ledger.allPathsSortedSnapshot();
  if (allPaths.length === 0) {
    return SEED_WHITELIST as SyncPlan;
  }

  const homeRoot = path.join(homedir, ".claude");
  const homePrefix = `${homeRoot}/`;
  const claudeJsonPath = path.join(homedir, ".claude.json");
  const entries = ledger.toJSON().entries;
  const homeInstruction: ScopeWalkInstruction = {
    subtrees: [],
    files: [],
    knownMissing: [],
  };

  for (const absPath of allPaths) {
    if (absPath === claudeJsonPath) continue;
    if (absPath !== homeRoot && !absPath.startsWith(homePrefix)) continue;

    const entry = entries[absPath];
    if (!entry) continue;
    const relPath = absPath === homeRoot ? "" : absPath.slice(homePrefix.length);

    if (entry.kind === "missing") {
      homeInstruction.knownMissing.push(relPath);
      continue;
    }

    if (isUnderAnySubtree(absPath, homeInstruction.subtrees, homeRoot)) continue;

    if (entry.kind === "dir" && entry.readdirObserved) {
      homeInstruction.subtrees.push({ relPath, maxDepth: -1 });
    } else if (entry.kind === "dir") {
      // dir 但 readdirObserved=false (CC stat 过但没 readdir): 当 maxDepth=0 subtree
      // 处理, 让 client readdir 它一次 (不下钻子目录) — 直接子项 file 进 manifest,
      // server 反向构造 snapshot 时从 file 父链派生 dir 自身 stat 进 daemon _stat_perm,
      // CC 启动后 getattr 该 dir 命中不穿透.
      homeInstruction.subtrees.push({ relPath, maxDepth: 0 });
    } else if (entry.kind === "file") {
      homeInstruction.files.push(relPath);
    }
  }

  // 中间目录补齐: ledger 可能只记了叶子 file (如 projects/<sid>/c.jsonl) 但没记
  // 父 dir (projects/) 的 readdirObserved. 这种情况下 plan 缺父 dir 覆盖, manifest
  // 不含父 dir 的 stat, daemon snapshot 注入也漏父 dir, CC 启动期 stat 父 dir
  // 直接穿透 client. 这里把每个 file/missing 路径的所有"未被 subtree 覆盖"的
  // 父链祖先也加进 files, 让 client walk 时 stat 父 dir, manifest 记录 dir entry.
  collectIntermediateAncestors(homeInstruction, homeRoot);

  return {
    scopes: {
      "claude-home": homeInstruction,
      "claude-json": {
        subtrees: [{ relPath: "", maxDepth: 0 }],
        files: [],
        knownMissing: [],
      },
    },
  };
}

function isUnderAnySubtree(
  absPath: string,
  subtrees: Array<{ relPath: string; maxDepth: number }>,
  homeRoot: string,
): boolean {
  for (const subtree of subtrees) {
    const subtreeAbs = subtree.relPath ? path.join(homeRoot, subtree.relPath) : homeRoot;
    if (absPath === subtreeAbs || absPath.startsWith(`${subtreeAbs}/`)) {
      return true;
    }
  }
  return false;
}

/**
 * 把 instruction.files 和 instruction.knownMissing 里所有 path 的中间父目录补到
 * instruction.files (除非已被 subtree 覆盖). 解决 ledger 只记叶子不记 readdir
 * 父 dir 的穿透问题 — 让 client walk 时 stat 父 dir, manifest/snapshot 含 dir
 * entry, daemon 启动后 getattr 父 dir 命中 _stat_perm 不穿透.
 */
function collectIntermediateAncestors(
  instruction: ScopeWalkInstruction,
  homeRoot: string,
): void {
  // 把所有现有 file 和 missing 路径的所有 (除自身外) 父链 relPath 收集起来
  const ancestors = new Set<string>();
  const seedRelPaths = [...instruction.files, ...instruction.knownMissing];
  for (const rel of seedRelPaths) {
    if (!rel) continue;
    let parent = path.posix.dirname(rel);
    while (parent && parent !== "." && parent !== "/") {
      ancestors.add(parent);
      const next = path.posix.dirname(parent);
      if (next === parent) break;
      parent = next;
    }
  }

  // 排除已经在 files 里 / 已被 subtree 覆盖 / 已被父 missing 吸收的
  const existingFiles = new Set(instruction.files);
  const missingSet = new Set(instruction.knownMissing);
  const toAdd: string[] = [];
  for (const rel of ancestors) {
    if (existingFiles.has(rel)) continue;
    const abs = path.join(homeRoot, rel);
    if (isUnderAnySubtree(abs, instruction.subtrees, homeRoot)) continue;
    // 如果父目录被 missing 标记 → 不加 (它已经在 knownMissing, 不该 stat)
    if (missingSet.has(rel)) continue;
    toAdd.push(rel);
  }
  instruction.files.push(...toAdd);
}
