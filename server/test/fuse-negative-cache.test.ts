import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { PYTHON_FUSE_HOST_SCRIPT } from "../src/fuse-host-script.js";

/**
 * 从 PYTHON_FUSE_HOST_SCRIPT 抽出 NegativeCache 类源码，与 selftest 断言一起
 * 喂给 python3 -c 跑。这样既验证 daemon 内嵌的 NegativeCache 行为正确性，
 * 又不需要修改产品代码加 selftest 分支。
 */
function extractNegativeCacheSource(): string {
  const script = PYTHON_FUSE_HOST_SCRIPT;
  const startIdx = script.indexOf("class NegativeCache:");
  const endIdx = script.indexOf("class Cache:");
  if (startIdx < 0 || endIdx < 0 || startIdx >= endIdx) {
    throw new Error("无法从 PYTHON_FUSE_HOST_SCRIPT 提取 NegativeCache 类源码");
  }
  return script.slice(startIdx, endIdx);
}

function runPythonSelftest(testCode: string): { ok: boolean; output: string } {
  const negativeCacheSource = extractNegativeCacheSource();
  const fullCode = `import bisect, os, sys\n${negativeCacheSource}\n${testCode}\n`;
  const result = spawnSync("python3", ["-c", fullCode], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return {
    ok: result.status === 0,
    output: (result.stdout || "") + (result.stderr || ""),
  };
}

test("NegativeCache.contains 前缀命中: put('/a/b') 后 contains('/a/b/c/x') == True", () => {
  const { ok, output } = runPythonSelftest(`
nc = NegativeCache()
nc.put("/a/b")
assert nc.contains("/a/b") is True, "self 命中失败"
assert nc.contains("/a/b/c") is True, "直接子 path 命中失败"
assert nc.contains("/a/b/c/x") is True, "深层后代命中失败"
assert nc.contains("/a/c") is False, "兄弟不应命中"
assert nc.contains("/a") is False, "祖先不应命中"
print("OK")
`);
  assert.ok(ok, `python3 退出码非 0: ${output}`);
  assert.match(output, /OK/);
});

test("NegativeCache.put 祖先存在时跳过 + 吸收子 missing", () => {
  const { ok, output } = runPythonSelftest(`
nc = NegativeCache()
nc.put("/a/b/c")
nc.put("/a/b/d/e")
nc.put("/a/b/x/y/z")
assert len(nc._sorted) == 3, "初始 3 个独立 missing"

# 加入更浅 ancestor /a/b: 应吸收上述 3 个
nc.put("/a/b")
assert nc._sorted == ["/a/b"], f"吸收失败, 当前 _sorted = {nc._sorted}"

# 再 put 子 path: 因为祖先已存在, 直接跳过
nc.put("/a/b/foo")
assert nc._sorted == ["/a/b"], f"子 path 不应被加入, 当前 _sorted = {nc._sorted}"

# 加入完全独立路径
nc.put("/x/y")
assert sorted(nc._sorted) == ["/a/b", "/x/y"]
print("OK")
`);
  assert.ok(ok, `python3 退出码非 0: ${output}`);
  assert.match(output, /OK/);
});

test("NegativeCache.invalidate_prefix 沿父链清祖先 missing", () => {
  const { ok, output } = runPythonSelftest(`
nc = NegativeCache()
nc.put("/a/b")
nc.put("/x/y")

# 创建 /a/b/c/file: 清祖先 missing /a/b
nc.invalidate_prefix("/a/b/c/file")
assert "/a/b" not in nc._set, "祖先 missing 应被清"
assert "/x/y" in nc._set, "无关 missing 应保留"

# path 自身就是 missing 的情况 (rare 但合理)
nc.put("/foo")
nc.invalidate_prefix("/foo")
assert "/foo" not in nc._set, "path 自身 missing 应被清"
print("OK")
`);
  assert.ok(ok, `python3 退出码非 0: ${output}`);
  assert.match(output, /OK/);
});

test("NegativeCache.clear 全部清空", () => {
  const { ok, output } = runPythonSelftest(`
nc = NegativeCache()
nc.put("/a")
nc.put("/b")
nc.clear()
assert nc._sorted == []
assert nc._set == set()
print("OK")
`);
  assert.ok(ok, `python3 退出码非 0: ${output}`);
  assert.match(output, /OK/);
});
