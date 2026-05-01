import path from "node:path";
import type { AccessLedgerRuntime } from "./access-ledger.js";
import { SEED_WHITELIST } from "./seed-whitelist.js";

// Temporary Phase 1 types. Phase 2 migrates these to protocol.ts.
export interface SyncPlan {
  scopes: {
    "claude-home"?: ScopeWalkInstruction;
    "claude-json"?: ScopeWalkInstruction;
  };
}

export interface ScopeWalkInstruction {
  subtrees: Array<{ relPath: string; maxDepth: number }>;
  files: string[];
  knownMissing: string[];
}

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
    } else if (entry.kind === "file") {
      homeInstruction.files.push(relPath);
    }
  }

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
