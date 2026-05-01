import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  normalizeLedgerPath,
  probeCaseSensitivity,
  resetCaseSensitivityForTest,
} from "../src/path-normalize.js";

test("probeCaseSensitivity 在测试目录 probe 一次, 缓存结果", () => {
  resetCaseSensitivityForTest();
  const dir = mkdtempSync(path.join(tmpdir(), "case-probe-"));
  const result1 = probeCaseSensitivity(dir);
  const result2 = probeCaseSensitivity("/another/dir");
  assert.equal(result1, result2);
});

test("normalizeLedgerPath case-sensitive: basename 保留原 case", () => {
  resetCaseSensitivityForTest(true);
  const dir = mkdtempSync(path.join(tmpdir(), "norm-"));
  mkdirSync(path.join(dir, "Foo"));
  const input = path.join(dir, "Foo", "Bar.md");
  assert.equal(normalizeLedgerPath(input), path.join(realpathSync.native(path.dirname(input)), "Bar.md"));
});

test("normalizeLedgerPath case-insensitive: basename lower-case, parent realpath", () => {
  resetCaseSensitivityForTest(false);
  const dir = mkdtempSync(path.join(tmpdir(), "norm-"));
  mkdirSync(path.join(dir, "Foo"));
  const input = path.join(dir, "Foo", "Bar.md");
  const expected = path.join(realpathSync.native(path.dirname(input)), "bar.md");
  assert.equal(normalizeLedgerPath(input), expected);
});

test("normalizeLedgerPath 父目录 symlink: realpath 解析", () => {
  resetCaseSensitivityForTest(true);
  const dir = mkdtempSync(path.join(tmpdir(), "norm-"));
  mkdirSync(path.join(dir, "real"));
  symlinkSync(path.join(dir, "real"), path.join(dir, "link"));
  writeFileSync(path.join(dir, "real", "file.md"), "x");
  const input = path.join(dir, "link", "file.md");
  const result = normalizeLedgerPath(input);
  assert.equal(result, path.join(realpathSync.native(path.join(dir, "real")), "file.md"));
});

test("normalizeLedgerPath 父目录不存在: 保留原 parent", () => {
  resetCaseSensitivityForTest(true);
  const input = "/does/not/exist/anywhere/leaf";
  assert.equal(normalizeLedgerPath(input), input);
});
