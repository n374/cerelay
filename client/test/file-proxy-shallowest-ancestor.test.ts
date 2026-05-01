import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileProxyHandler, findShallowestMissingAncestor } from "../src/file-proxy.js";
import type { FileProxyOp, FileProxyRequest } from "../src/protocol.js";

test("findShallowestMissingAncestor: 父目录都存在, 返回 path 自身", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "fpa-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, "a"));

  const result = await findShallowestMissingAncestor(path.join(dir, "a", "missing.md"), dir);

  assert.equal(result, path.join(dir, "a", "missing.md"));
});

test("findShallowestMissingAncestor: 多级祖先都不存在, 返回最浅", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "fpa-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const result = await findShallowestMissingAncestor(path.join(dir, "a", "b", "c", "leaf"), dir);

  assert.equal(result, path.join(dir, "a"));
});

test("findShallowestMissingAncestor: cap 在 rootPath, 不越界向上", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "fpa-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const rootPath = path.join(dir, "sub");
  const result = await findShallowestMissingAncestor(path.join(rootPath, "miss.md"), rootPath);

  assert.equal(result, rootPath);
});

test("FileProxyHandler ENOENT 响应携带 shallowestMissingAncestor", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "fpa-home-"));
  const cwd = await mkdtemp(path.join(tmpdir(), "fpa-cwd-"));
  t.after(() => Promise.all([
    rm(home, { recursive: true, force: true }),
    rm(cwd, { recursive: true, force: true }),
  ]));
  await mkdir(path.join(home, ".claude", "existing"), { recursive: true });
  const handler = new FileProxyHandler(home, cwd);

  const cases: Array<{ op: FileProxyOp; filePath: string; expected: string }> = [
    {
      op: "getattr",
      filePath: path.join(home, ".claude", "existing", "missing.json"),
      expected: path.join(home, ".claude", "existing", "missing.json"),
    },
    {
      op: "read",
      filePath: path.join(home, ".claude", "a", "b", "leaf.json"),
      expected: path.join(home, ".claude", "a"),
    },
    {
      op: "readdir",
      filePath: path.join(cwd, ".claude", "project", "missing"),
      expected: path.join(cwd, ".claude"),
    },
  ];

  for (const item of cases) {
    const response = await handler.handle(makeRequest(item.op, item.filePath));
    assert.equal(response.error?.code, 2);
    assert.equal(response.shallowestMissingAncestor, item.expected);
  }
});

function makeRequest(op: FileProxyOp, filePath: string): FileProxyRequest {
  return {
    type: "file_proxy_request",
    reqId: `${op}-${filePath}`,
    sessionId: "session-1",
    op,
    path: filePath,
    size: op === "read" ? 64 : undefined,
    offset: op === "read" ? 0 : undefined,
  };
}
