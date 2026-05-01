// SeedWhitelist: 仅在 ledger 完全空 (首次连接 / 新 device) 时作为 SyncPlan 冷启动种子.
// 一旦该 device 跑过 session 写过 ledger, 后续不再用 SeedWhitelist.
//
// 当前状态: minimal hand-curated fixture, 基于 CC 启动期已知行为 + 用户实测日志
// (commit a6d389d spec §10.2 capture 流程的 fallback). 可由 scripts/seed-whitelist-codegen.ts
// 重新生成 (推荐) — 跑 capture 后用真实数据覆写本文件:
//
//   1. CERELAY_CAPTURE_SEED=/tmp/seed.json npm run server:up
//   2. 用 dev 真实 ~/.claude 跑常规 CC 启动 + /agents + /commands + 退出
//   3. node --import tsx scripts/seed-whitelist-codegen.ts /tmp/seed.json > server/src/seed-whitelist.ts
//   4. cd server && npm run typecheck && npm test
//   5. git add server/src/seed-whitelist.ts && git commit
//
// 当前 minimal fixture 的设计原则:
//   - subtrees: CC 启动期一定会 readdir 的目录 (确保整子树 walk + 进 manifest)
//   - files: CC 启动期常 stat 的单文件 (settings 系列)
//   - knownMissing: CC 启动期常探测但默认不存在的路径 (避免穿透 client)
//
// 这些来自:
//   - CC 已知启动期访问形态 (settings.json, plugins/, projects/, sessions/, backups/)
//   - 用户实测日志 (output-styles, themes, monitors, .config.json 等)

import type { SyncPlan } from "./protocol.js";

export const SEED_WHITELIST: Readonly<SyncPlan> = Object.freeze({
  scopes: {
    "claude-home": Object.freeze({
      // 整子树 walk - CC 启动会 readdir 这些目录
      subtrees: Object.freeze([
        // 用户级 plugins (含 marketplace, cache; CC 必读)
        Object.freeze({ relPath: "plugins", maxDepth: -1 }),
        // 项目级 sessions (CC 启动期会 readdir 列出可恢复 session)
        Object.freeze({ relPath: "projects", maxDepth: -1 }),
        // CC 启动期可能会 readdir 列出历史 backups
        Object.freeze({ relPath: "backups", maxDepth: -1 }),
        // CC 内部状态目录 (统计 / shell 快照 / TODO 等)
        Object.freeze({ relPath: "statsig", maxDepth: -1 }),
        Object.freeze({ relPath: "shell-snapshots", maxDepth: -1 }),
        Object.freeze({ relPath: "todos", maxDepth: -1 }),
        Object.freeze({ relPath: "session-env", maxDepth: -1 }),
      ]),
      // CC 启动期常 stat 的单文件
      files: Object.freeze([
        "settings.json",
        "settings.local.json",
        "CLAUDE.md",
        "CLAUDE.local.md",
        ".credentials.json",
      ]),
      // CC 启动期常探测但默认不存在的路径 (基于用户实测日志, 避免穿透)
      // 一次性探测后 CC 会缓存到内存, 后续不再探;
      // 但每次 daemon 重启都要重学 — 持久化为 known missing 让 daemon 启动后直接 ENOENT
      knownMissing: Object.freeze([
        ".config.json",
        // 用户级 agents/commands/skills - 默认 CC 不创建, 但每次启动都探
        "agents",
        "commands",
        "skills",
      ]),
    }),
    "claude-json": Object.freeze({
      subtrees: Object.freeze([{ relPath: "", maxDepth: 0 }]),
      files: Object.freeze([]),
      knownMissing: Object.freeze([]),
    }),
  },
}) as unknown as Readonly<SyncPlan>;
