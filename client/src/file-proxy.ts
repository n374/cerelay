import { constants } from "node:fs";
import {
  access,
  mkdir,
  readdir,
  readFile,
  rename,
  rmdir,
  stat,
  truncate,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { open } from "node:fs/promises";
import path from "node:path";
import { createLogger } from "./logger.js";
import type {
  FileProxyRequest,
  FileProxyResponse,
  FileProxySnapshotEntry,
  FileProxyStat,
} from "./protocol.js";

const log = createLogger("file-proxy");

/**
 * Hand 侧文件代理处理器。
 * 接收 Brain 转发的 FUSE 文件操作，执行本地 I/O 后返回结果。
 * 严格限制可访问路径：仅 ~/.claude/、~/.claude.json、{cwd}/.claude/
 */
export class FileProxyHandler {
  private readonly allowedPrefixes: string[];

  constructor(homeDir: string, cwd: string) {
    const resolvedHome = path.resolve(homeDir);
    const resolvedCwd = path.resolve(cwd);
    this.allowedPrefixes = [
      path.join(resolvedHome, ".claude") + path.sep,
      path.join(resolvedHome, ".claude"),
      path.join(resolvedHome, ".claude.json"),
      path.join(resolvedCwd, ".claude") + path.sep,
      path.join(resolvedCwd, ".claude"),
    ];
  }

  async handle(req: FileProxyRequest): Promise<FileProxyResponse> {
    const base: Pick<FileProxyResponse, "type" | "reqId" | "sessionId"> = {
      type: "file_proxy_response",
      reqId: req.reqId,
      sessionId: req.sessionId,
    };

    if (!this.isAllowed(req.path)) {
      log.warn("文件代理拒绝访问", { path: req.path, op: req.op });
      return { ...base, error: { code: 1, message: "EPERM: access denied" } };
    }

    try {
      switch (req.op) {
        case "getattr":
          return { ...base, stat: await this.doGetattr(req.path) };

        case "readdir":
          return { ...base, entries: await this.doReaddir(req.path) };

        case "read":
          return {
            ...base,
            data: await this.doRead(req.path, req.offset ?? 0, req.size ?? 0),
          };

        case "write":
          return {
            ...base,
            written: await this.doWrite(
              req.path,
              req.data ?? "",
              req.offset ?? 0
            ),
          };

        case "create":
          await this.doCreate(req.path, req.mode ?? 0o644, req.data);
          return { ...base };

        case "unlink":
          await unlink(req.path);
          return { ...base };

        case "mkdir":
          await mkdir(req.path, { recursive: true, mode: req.mode ?? 0o755 });
          return { ...base };

        case "rmdir":
          await rmdir(req.path);
          return { ...base };

        case "rename":
          if (!req.newPath || !this.isAllowed(req.newPath)) {
            return {
              ...base,
              error: { code: 1, message: "EPERM: rename target denied" },
            };
          }
          await rename(req.path, req.newPath);
          return { ...base };

        case "truncate":
          await truncate(req.path, req.size ?? 0);
          return { ...base };

        case "utimens":
          await utimes(
            req.path,
            new Date((req.atime ?? Date.now() / 1000) * 1000),
            new Date((req.mtime ?? Date.now() / 1000) * 1000)
          );
          return { ...base };

        case "snapshot":
          return { ...base, snapshot: await this.doSnapshot(req.path) };

        default:
          return {
            ...base,
            error: { code: 38, message: `ENOSYS: op ${req.op} not supported` },
          };
      }
    } catch (err) {
      const errno = extractErrno(err);
      const message =
        err instanceof Error ? err.message : String(err);
      log.debug("文件代理操作失败", {
        op: req.op,
        path: req.path,
        errno,
        message,
      });
      return { ...base, error: { code: errno, message } };
    }
  }

  private isAllowed(filePath: string): boolean {
    const normalized = path.resolve(filePath);
    return this.allowedPrefixes.some(
      (prefix) => normalized === prefix || (prefix.endsWith(path.sep) && normalized.startsWith(prefix))
    );
  }

  private async doGetattr(filePath: string): Promise<FileProxyStat> {
    const st = await stat(filePath);
    return {
      mode: st.mode,
      size: st.size,
      mtime: Math.floor(st.mtimeMs / 1000),
      atime: Math.floor(st.atimeMs / 1000),
      uid: st.uid,
      gid: st.gid,
      isDir: st.isDirectory(),
    };
  }

  private async doReaddir(dirPath: string): Promise<string[]> {
    return await readdir(dirPath);
  }

  /**
   * 递归扫描目录树，返回完整快照（stat + readdir + 小文件内容）。
   * 用于 FUSE 缓存预注入，消除启动时的逐文件 round-trip。
   */
  private async doSnapshot(rootPath: string, maxDepth = 5): Promise<FileProxySnapshotEntry[]> {
    const results: FileProxySnapshotEntry[] = [];

    const scan = async (dirPath: string, depth: number): Promise<void> => {
      if (depth > maxDepth) return;

      let entries: string[];
      let dirStat: FileProxyStat;
      try {
        const st = await stat(dirPath);
        dirStat = {
          mode: st.mode,
          size: st.size,
          mtime: Math.floor(st.mtimeMs / 1000),
          atime: Math.floor(st.atimeMs / 1000),
          uid: st.uid,
          gid: st.gid,
          isDir: st.isDirectory(),
        };
        entries = await readdir(dirPath);
      } catch {
        return;
      }

      results.push({ path: dirPath, stat: dirStat, entries });

      // 并行 stat 所有条目
      const childStats = await Promise.allSettled(
        entries.map(async (entry) => {
          const fullPath = path.join(dirPath, entry);
          const st = await stat(fullPath);
          const fileStat: FileProxyStat = {
            mode: st.mode,
            size: st.size,
            mtime: Math.floor(st.mtimeMs / 1000),
            atime: Math.floor(st.atimeMs / 1000),
            uid: st.uid,
            gid: st.gid,
            isDir: st.isDirectory(),
          };
          return { fullPath, fileStat, isDir: st.isDirectory(), size: st.size };
        })
      );

      const subdirs: Promise<void>[] = [];
      for (const result of childStats) {
        if (result.status !== "fulfilled") continue;
        const { fullPath, fileStat, isDir, size } = result.value;

        if (isDir) {
          results.push({ path: fullPath, stat: fileStat });
          subdirs.push(scan(fullPath, depth + 1));
        } else {
          // stat 缓存足以消除最频繁的 getattr round-trip，
          // 文件内容按需代理（单次 read 延迟 <1ms，不构成瓶颈）
          results.push({ path: fullPath, stat: fileStat });
        }
      }

      await Promise.allSettled(subdirs);
    };

    await scan(rootPath, 0);
    return results;
  }

  private async doRead(
    filePath: string,
    offset: number,
    size: number
  ): Promise<string> {
    const fh = await open(filePath, "r");
    try {
      const buf = Buffer.alloc(size);
      const { bytesRead } = await fh.read(buf, 0, size, offset);
      return buf.subarray(0, bytesRead).toString("base64");
    } finally {
      await fh.close();
    }
  }

  private async doWrite(
    filePath: string,
    data: string,
    offset: number
  ): Promise<number> {
    const buf = Buffer.from(data, "base64");
    // 确保父目录存在
    await mkdir(path.dirname(filePath), { recursive: true });
    const fh = await open(filePath, "r+").catch(async () => {
      // 文件不存在时创建
      return await open(filePath, "w+");
    });
    try {
      const { bytesWritten } = await fh.write(buf, 0, buf.length, offset);
      return bytesWritten;
    } finally {
      await fh.close();
    }
  }

  private async doCreate(
    filePath: string,
    mode: number,
    data?: string
  ): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const content = data ? Buffer.from(data, "base64") : Buffer.alloc(0);
    await writeFile(filePath, content, { mode });
  }
}

function extractErrno(err: unknown): number {
  if (err && typeof err === "object" && "errno" in err) {
    const e = (err as { errno: number }).errno;
    // Node.js errno 是负数，FUSE 需要正数
    return Math.abs(e);
  }
  return 5; // EIO
}
