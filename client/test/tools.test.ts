import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readFile, writeFile, editFile, multiEdit } from "../src/tools/fs.js";
import { executeBash } from "../src/tools/bash.js";
import { grep, globFiles } from "../src/tools/search.js";
import { FileProxyHandler } from "../src/file-proxy.js";
import {
  ToolError,
  ToolExecutor,
  formatToolError,
  summarizeToolResult,
} from "../src/executor.js";

test("fs tools read, write, edit, and multi-edit files", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cerelay-client-fs-"));
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
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cerelay-client-search-"));
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
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cerelay-client-bash-"));
  const result = await executeBash({ command: "printf 'ok'" }, cwd);
  assert.equal(result.stdout, "ok");
  assert.equal(result.exit_code, 0);

  await assert.rejects(() => executeBash({ command: "echo nope", timeout: 0 }, cwd), /timeout/);
});

test("client-routed tools can access cwd, parent paths, and absolute files", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cerelay-client-tools-root-"));
  const cwd = path.join(parent, "project");
  const siblingPath = path.join(parent, "sibling.txt");
  const outputPath = path.join(parent, "written.txt");
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(path.join(cwd, "package.json"), '{"name":"project"}');
  await fs.writeFile(siblingPath, "parent file");

  const pwd = await executeBash({ command: "pwd" }, cwd);
  assert.equal(pwd.stdout.trim(), await fs.realpath(cwd), "Bash 应在 Client cwd 中执行");

  const parentLs = await executeBash({ command: "ls .." }, cwd);
  assert.match(parentLs.stdout, /sibling\.txt/, "Bash 应能访问 cwd 上级目录");

  assert.deepEqual(await readFile({ file_path: siblingPath }, cwd), {
    content: "parent file",
  });

  await writeFile({ file_path: outputPath, content: "created outside cwd" }, cwd);
  assert.equal(await fs.readFile(outputPath, "utf8"), "created outside cwd");

  await editFile({ file_path: outputPath, old_string: "outside", new_string: "above" }, cwd);
  assert.equal(await fs.readFile(outputPath, "utf8"), "created above cwd");
});

test("file proxy remains scoped to Claude config paths, not user project files", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cerelay-client-home-"));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cerelay-client-project-"));
  await fs.writeFile(path.join(cwd, "package.json"), '{"name":"project"}');
  await fs.mkdir(path.join(cwd, "src"), { recursive: true });
  await fs.writeFile(path.join(cwd, "src", "index.ts"), "export default {};");
  await fs.mkdir(path.join(cwd, ".claude"), { recursive: true });
  await fs.writeFile(path.join(cwd, ".claude", "settings.local.json"), '{"hooks":{}}');

  const handler = new FileProxyHandler(home, cwd);

  const projectSnapshot = await handler.handle({
    type: "file_proxy_request",
    reqId: "snap-project-root",
    sessionId: "pty-test",
    op: "snapshot",
    path: cwd,
  });
  assert.equal(projectSnapshot.error?.code, 1, "用户项目根目录不应通过 FUSE file proxy 暴露");

  const adjacentSnapshot = await handler.handle({
    type: "file_proxy_request",
    reqId: "snap-project-claude-adjacent",
    sessionId: "pty-test",
    op: "snapshot",
    path: path.join(cwd, ".claude2"),
  });
  assert.equal(adjacentSnapshot.error?.code, 1, ".claude 相邻目录不应误命中 file proxy allow-list");

  const claudeSnapshot = await handler.handle({
    type: "file_proxy_request",
    reqId: "snap-project-claude",
    sessionId: "pty-test",
    op: "snapshot",
    path: path.join(cwd, ".claude"),
  });
  assert.equal(claudeSnapshot.error, undefined);
  const snapshotPaths = (claudeSnapshot.snapshot ?? []).map((entry) => entry.path);
  assert.ok(
    snapshotPaths.includes(path.join(cwd, ".claude", "settings.local.json")),
    "project .claude/settings.local.json 应通过 file proxy 暴露"
  );
  assert.equal(
    snapshotPaths.some((filePath) => filePath === path.join(cwd, "package.json") || filePath.includes(`${path.sep}src${path.sep}`)),
    false,
    ".claude snapshot should remain scoped to Claude config files"
  );
});

test("ToolExecutor dispatches tools and formats results", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cerelay-client-executor-"));
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

test("ToolExecutor discovers MCP tools from Brain-provided config and executes them through a generic MCP client", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cerelay-client-mcp-"));
  const scriptDir = await fs.mkdtemp(path.join(process.cwd(), ".cerelay-client-mcp-script-"));
  const scriptPath = path.join(scriptDir, "demo-mcp.mjs");

  t.after(async () => {
    await fs.rm(scriptDir, { recursive: true, force: true });
  });

  await fs.writeFile(
    scriptPath,
    `
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "demo", version: "1.0.0" });
server.registerTool(
  "echo",
  {
    description: "Echo the provided text",
    inputSchema: { text: z.string() },
  },
  async ({ text }) => ({
    content: [{ type: "text", text: \`echo:\${text}\` }],
    structuredContent: { echoed: text },
  })
);

await server.connect(new StdioServerTransport());
`,
    "utf8"
  );

  const executor = new ToolExecutor(cwd, {
    demo: {
      command: process.execPath,
      args: [scriptPath],
    },
  });
  t.after(async () => {
    await executor.close();
  });

  const catalog = await executor.describeMcpServers();
  assert.equal(Object.keys(catalog).length, 1);
  assert.equal(catalog.demo?.tools[0]?.name, "echo");
  assert.equal(catalog.demo?.tools[0]?.description, "Echo the provided text");

  const result = await executor.dispatch("mcp__demo__echo", { text: "hello" });
  assert.equal(
    ((result as { content?: Array<{ type?: string; text?: string }> }).content?.[0]?.text),
    "echo:hello"
  );
  assert.deepEqual(
    (result as { structuredContent?: Record<string, unknown> }).structuredContent,
    { echoed: "hello" }
  );
  assert.equal(summarizeToolResult("mcp__demo__echo", result), "mcp__demo__echo 完成");

  await assert.rejects(
    () => executor.dispatch("mcp__missing__tool", {}),
    /未找到 MCP server 配置|未找到 Hand 代理脚本/
  );
});

test("ToolExecutor executes WebFetch locally", async (t) => {
  const responses: Array<string> = [];
  const server = (await import("node:http")).createServer((_req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Axon-Test": "ok",
    });
    res.end("hello from hand");
  });

  t.after(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("测试服务器未监听");
  }

  const executor = new ToolExecutor(process.cwd());
  const result = await executor.dispatch("WebFetch", {
    url: `http://127.0.0.1:${address.port}/demo`,
  });

  assert.equal(typeof result, "object");
  assert.equal("status" in result, true);
  assert.equal((result as { status: number }).status, 200);
  assert.equal((result as { body: string }).body, "hello from hand");
  assert.equal((result as { headers: Record<string, string> }).headers["x-axon-test"], "ok");
  responses.push(summarizeToolResult("WebFetch", result));
  assert.match(responses[0] ?? "", /status=200/);
});
