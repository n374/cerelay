#!/usr/bin/env node
/**
 * SeedWhitelist codegen.
 *
 * 输入: 由 cerelay server 在 CERELAY_CAPTURE_SEED=path 模式下产出的 capture JSON.
 * 输出: TypeScript 源码 (stdout), 内容是 SEED_WHITELIST const 定义.
 *
 * 用法:
 *   1. CERELAY_CAPTURE_SEED=/tmp/seed-capture.json npm run server:up
 *   2. 跑常规 CC 启动 + 几个 prompt + /agents + /commands + 退出
 *   3. node --import tsx scripts/seed-whitelist-codegen.ts /tmp/seed-capture.json > server/src/seed-whitelist.ts
 *   4. cd server && npm run typecheck && npm test  # 确认无 regression
 *   5. git add server/src/seed-whitelist.ts && git commit
 *
 * 设计 (spec §10.2):
 * - capture 模式跳过 daemon snapshot 注入, 让所有 RPC 穿透 client
 * - 真实 dev ~/.claude 不是 clean 环境 — 反映真实启动期访问形态
 * - 输出 ts const 内联进 binary, 运行时无 IO 加载
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

interface CaptureEvent {
  op: string;
  path: string;
  result: "ok" | "missing";
  isDir?: boolean;
  mtime?: number;
}

interface CaptureFile {
  events: CaptureEvent[];
}

function main(): void {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("Usage: seed-whitelist-codegen <capture.json>");
    process.exit(1);
  }

  const data = JSON.parse(readFileSync(inputPath, "utf8")) as CaptureFile;
  if (!data.events || !Array.isArray(data.events)) {
    console.error("Invalid capture file: missing events array");
    process.exit(1);
  }

  const HOME = process.env.HOME || homedir();
  const claudeHome = path.join(HOME, ".claude");
  const claudeJson = path.join(HOME, ".claude.json");
  const homePrefix = claudeHome + path.sep;

  // home-claude scope: 聚合 readdir/getattr/read 路径到 subtrees + files + knownMissing
  const homeSubtrees = new Set<string>();
  const homeFiles = new Set<string>();
  const homeMissing = new Set<string>();

  for (const ev of data.events) {
    // claude-json scope (单文件) - 不做特殊处理, 由 const 兜底
    if (ev.path === claudeJson) continue;

    if (!ev.path.startsWith(homePrefix) && ev.path !== claudeHome) continue;

    const rel = ev.path === claudeHome ? "" : ev.path.slice(homePrefix.length);

    if (ev.result === "missing") {
      homeMissing.add(rel);
      continue;
    }

    if (ev.op === "readdir" && ev.result === "ok") {
      // readdir 过的目录 → subtree (unlimited depth)
      homeSubtrees.add(rel);
    } else if (ev.result === "ok" && !ev.isDir) {
      // 单文件 (getattr/read ok) → files
      homeFiles.add(rel);
    }
    // dir + getattr 但没 readdir 过 → 不进 subtrees, 也不进 files (跟 SyncPlan 计算逻辑一致)
  }

  // 子项被父 subtree 覆盖时去重
  const homeSubtreesArr = [...homeSubtrees].sort();
  const filteredFiles = [...homeFiles]
    .filter((f) => !homeSubtreesArr.some((st) => st === "" || f.startsWith(st + path.sep)))
    .sort();
  const filteredMissing = [...homeMissing].sort();

  // 生成 ts 源码
  const out: string[] = [];
  out.push("// 由 scripts/seed-whitelist-codegen.ts 一次性产出. 不要手改.");
  out.push(`// Capture source: ${path.basename(inputPath)}`);
  out.push("//");
  out.push(`// 重新生成: node --import tsx scripts/seed-whitelist-codegen.ts <capture.json> > server/src/seed-whitelist.ts`);
  out.push(`// Capture 流程见 docs/superpowers/specs/2026-05-01-access-ledger-driven-cache-design.md §10.2`);
  out.push("");
  out.push(`import type { SyncPlan } from "./protocol.js";`);
  out.push("");
  out.push(`export const SEED_WHITELIST: Readonly<SyncPlan> = Object.freeze({`);
  out.push(`  scopes: {`);
  out.push(`    "claude-home": Object.freeze({`);
  out.push(`      subtrees: Object.freeze([`);
  for (const rel of homeSubtreesArr) {
    out.push(`        Object.freeze({ relPath: ${JSON.stringify(rel)}, maxDepth: -1 } as const),`);
  }
  out.push(`      ] as const),`);
  out.push(`      files: Object.freeze([`);
  for (const f of filteredFiles) {
    out.push(`        ${JSON.stringify(f)},`);
  }
  out.push(`      ] as const),`);
  out.push(`      knownMissing: Object.freeze([`);
  for (const m of filteredMissing) {
    out.push(`        ${JSON.stringify(m)},`);
  }
  out.push(`      ] as const),`);
  out.push(`    }),`);
  out.push(`    "claude-json": Object.freeze({`);
  out.push(`      subtrees: Object.freeze([{ relPath: "", maxDepth: 0 }] as const),`);
  out.push(`      files: Object.freeze([] as const),`);
  out.push(`      knownMissing: Object.freeze([] as const),`);
  out.push(`    }),`);
  out.push(`  },`);
  out.push(`} as const) as SyncPlan;`);
  out.push("");

  process.stdout.write(out.join("\n"));
}

main();
