import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readFile, writeFile, editFile, multiEdit } from "../src/tools/fs.js";
import { executeBash } from "../src/tools/bash.js";
import { grep, globFiles } from "../src/tools/search.js";
import {
  ToolError,
  ToolExecutor,
  formatToolError,
  summarizeToolResult,
} from "../src/executor.js";

test("fs tools read, write, edit, and multi-edit files", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "axon-hand-fs-"));
  const filePath = path.join(cwd, "demo.txt");

  await writeFile({ file_path: "demo.txt", content: "ab你好cd你好" }, cwd);
  assert.deepEqual(await readFile({ file_path: "demo.txt", offset: 2, limit: 4 }, cwd), {
    content: "你好cd",
  });

  await editFile({ file_path: "demo.txt", old_string: "ab", new_string: "AB" }, cwd);
  await multiEdit({
    file_path: "demo.txt",
    edits: [
      { old_string: "cd", new_string: "CD" },
      { old_string: "你好", new_string: "世界" },
    ],
  }, cwd);

  const finalContent = await fs.readFile(filePath, "utf8");
  assert.equal(finalContent, "AB世界CD你好");

  await assert.rejects(
    () => editFile({ file_path: "demo.txt", old_string: "", new_string: "x" }, cwd),
    /old_string 不能为空/
  );
});

test("search tools find matches and globbed files", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "axon-hand-search-"));
  await fs.mkdir(path.join(cwd, "nested"));
  await fs.writeFile(path.join(cwd, "nested", "a.ts"), "alpha\nbeta target\n");
  await fs.writeFile(path.join(cwd, "nested", "b.js"), "target\n");

  const grepResult = await grep({ pattern: "target", path: "nested", glob: "*.ts" }, cwd);
  assert.equal(grepResult.matches.length, 1);
  assert.match(grepResult.matches[0]?.file ?? "", /a\.ts$/);

  const globResult = await globFiles({ pattern: "*.ts", path: "nested" }, cwd);
  assert.equal(globResult.files.length, 1);
  assert.match(globResult.files[0] ?? "", /a\.ts$/);
});

test("bash tool executes commands and validates timeout", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "axon-hand-bash-"));
  const result = await executeBash({ command: "printf 'ok'" }, cwd);
  assert.equal(result.stdout, "ok");
  assert.equal(result.exit_code, 0);

  await assert.rejects(() => executeBash({ command: "echo nope", timeout: 0 }, cwd), /timeout/);
});

test("ToolExecutor dispatches tools and formats results", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "axon-hand-executor-"));
  await fs.writeFile(path.join(cwd, "note.txt"), "hello");

  const executor = new ToolExecutor(cwd);
  const readResult = await executor.dispatch("Read", { file_path: "note.txt" });
  assert.deepEqual(readResult, { content: "hello" });
  assert.match(summarizeToolResult("Read", readResult), /返回 5 字符/);

  await assert.rejects(() => executor.dispatch("Unknown", {}), (error: unknown) => {
    assert.equal(error instanceof ToolError, true);
    return true;
  });

  const toolError = new ToolError("bad", "Read", "boom");
  assert.match(formatToolError(toolError), /"code":"bad"/);
  assert.equal(formatToolError(new Error("plain")), "plain");
});
