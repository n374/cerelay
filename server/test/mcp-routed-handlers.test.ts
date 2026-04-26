// handler factory 单测：用 mock IpcClient 验证每个工具的 input forward + output
// 渲染逻辑，不 spawn 子进程，跑得快。
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAllShadowToolHandlers,
  buildShadowToolHandler,
} from "../src/mcp-routed/handlers.ts";
import type { IpcClient } from "../src/mcp-routed/ipc-client.js";
import type { RemoteToolResult } from "../src/relay.js";
import { SHADOW_TOOLS } from "../src/mcp-routed/schemas.ts";

interface CallRecord {
  builtinName: string;
  input: unknown;
}

function createMockIpc(impl: (builtinName: string, input: unknown) => Promise<RemoteToolResult>): {
  client: IpcClient;
  calls: CallRecord[];
} {
  const calls: CallRecord[] = [];
  const client = {
    async callTool(builtinName: string, input: unknown): Promise<RemoteToolResult> {
      calls.push({ builtinName, input });
      return impl(builtinName, input);
    },
  } as unknown as IpcClient;
  return { client, calls };
}

test("buildAllShadowToolHandlers 返回 7 个 handler，名字与 SHADOW_TOOLS 顺序一致", () => {
  const ipc = createMockIpc(async () => ({})).client;
  const handlers = buildAllShadowToolHandlers(ipc);
  assert.equal(handlers.length, 7);
  assert.deepEqual(
    handlers.map((h) => h.name),
    SHADOW_TOOLS.map((s) => s.shortName),
  );
});

test("bash handler: input 透传、output 走 renderToolResultForClaude（含 stdout/stderr/exit_code）", async () => {
  const { client, calls } = createMockIpc(async () => ({
    output: { stdout: "hello\n", stderr: "", exit_code: 0 },
  }));
  const def = buildShadowToolHandler(SHADOW_TOOLS[0]!, client);
  const result = await def.handler({ command: "echo hello", description: "demo" });
  assert.deepEqual(calls, [
    { builtinName: "Bash", input: { command: "echo hello", description: "demo" } },
  ]);
  assert.equal(result.isError, false);
  assert.equal((result.content[0] as { type: string }).type, "text");
  assert.match((result.content[0] as { text: string }).text, /stdout:\nhello/);
  assert.match((result.content[0] as { text: string }).text, /exit_code: 0/);
});

test("bash handler: stderr 非空时也渲染 stderr block", async () => {
  const { client } = createMockIpc(async () => ({
    output: { stdout: "", stderr: "boom\n", exit_code: 2 },
  }));
  const def = buildShadowToolHandler(SHADOW_TOOLS[0]!, client);
  const result = await def.handler({ command: "false" });
  assert.equal(result.isError, false, "Bash 退出码非零不算 isError，由模型自行判断");
  assert.match((result.content[0] as { text: string }).text, /stderr:\nboom/);
  assert.match((result.content[0] as { text: string }).text, /exit_code: 2/);
});

test("read handler: output.content 渲染成纯文本", async () => {
  const { client, calls } = createMockIpc(async () => ({
    output: { content: "line1\nline2\n" },
  }));
  const def = buildShadowToolHandler(SHADOW_TOOLS[1]!, client); // read
  const result = await def.handler({ file_path: "/abs/path.ts", offset: 1, limit: 100 });
  assert.equal(calls[0]?.builtinName, "Read");
  assert.deepEqual(calls[0]?.input, { file_path: "/abs/path.ts", offset: 1, limit: 100 });
  assert.equal(result.isError, false);
  assert.equal((result.content[0] as { text: string }).text, "line1\nline2\n");
});

test("write handler: input 透传 + 渲染 output.path", async () => {
  const { client, calls } = createMockIpc(async () => ({ output: { path: "/abs/out.ts" } }));
  const def = buildShadowToolHandler(SHADOW_TOOLS[2]!, client); // write
  const result = await def.handler({ file_path: "/abs/out.ts", content: "hi" });
  assert.equal(calls[0]?.builtinName, "Write");
  assert.deepEqual(calls[0]?.input, { file_path: "/abs/out.ts", content: "hi" });
  assert.equal(result.isError, false);
  assert.equal((result.content[0] as { text: string }).text, "/abs/out.ts");
});

test("edit handler: input 透传（含 replace_all） + 渲染 output.path", async () => {
  const { client, calls } = createMockIpc(async () => ({ output: { path: "/abs/x.ts" } }));
  const def = buildShadowToolHandler(SHADOW_TOOLS[3]!, client); // edit
  const result = await def.handler({
    file_path: "/abs/x.ts",
    old_string: "foo",
    new_string: "bar",
    replace_all: true,
  });
  assert.equal(calls[0]?.builtinName, "Edit");
  assert.deepEqual(calls[0]?.input, {
    file_path: "/abs/x.ts",
    old_string: "foo",
    new_string: "bar",
    replace_all: true,
  });
  assert.equal(result.isError, false);
  assert.equal((result.content[0] as { text: string }).text, "/abs/x.ts");
});

test("multi_edit handler: edits 数组透传（不含 replace_all，与 client 实现一致） + 渲染 output.path", async () => {
  const { client, calls } = createMockIpc(async () => ({ output: { path: "/abs/y.ts" } }));
  const def = buildShadowToolHandler(SHADOW_TOOLS[4]!, client); // multi_edit
  const edits = [
    { old_string: "a", new_string: "A" },
    { old_string: "b", new_string: "B" },
  ];
  const result = await def.handler({ file_path: "/abs/y.ts", edits });
  assert.equal(calls[0]?.builtinName, "MultiEdit");
  assert.deepEqual(calls[0]?.input, { file_path: "/abs/y.ts", edits });
  assert.equal(result.isError, false);
  assert.equal((result.content[0] as { text: string }).text, "/abs/y.ts");
});

test("glob handler: output.files 数组渲染为换行分隔字符串", async () => {
  const { client, calls } = createMockIpc(async () => ({
    output: { files: ["src/a.ts", "src/b.ts"] },
  }));
  const def = buildShadowToolHandler(SHADOW_TOOLS[5]!, client); // glob
  const result = await def.handler({ pattern: "src/*.ts", path: "/abs/proj" });
  assert.equal(calls[0]?.builtinName, "Glob");
  assert.deepEqual(calls[0]?.input, { pattern: "src/*.ts", path: "/abs/proj" });
  assert.equal(result.isError, false);
  assert.equal((result.content[0] as { text: string }).text, "src/a.ts\nsrc/b.ts");
});

test("grep handler: output.matches 渲染为 file:line:text", async () => {
  const { client, calls } = createMockIpc(async () => ({
    output: {
      matches: [
        { file: "src/a.ts", line: 10, text: "foo" },
        { file: "src/b.ts", line: 7, text: "bar" },
      ],
    },
  }));
  const def = buildShadowToolHandler(SHADOW_TOOLS[6]!, client); // grep
  const result = await def.handler({ pattern: "TODO", path: "/abs", glob: "*.ts" });
  assert.equal(calls[0]?.builtinName, "Grep");
  assert.deepEqual(calls[0]?.input, { pattern: "TODO", path: "/abs", glob: "*.ts" });
  assert.equal(result.isError, false);
  assert.equal(
    (result.content[0] as { text: string }).text,
    "src/a.ts:10:foo\nsrc/b.ts:7:bar",
  );
});

test("handler: dispatcher 返回 error 时 isError:true 且 content 为 error 文本", async () => {
  const { client } = createMockIpc(async () => ({ error: "permission denied" }));
  const def = buildShadowToolHandler(SHADOW_TOOLS[1]!, client); // read
  const result = await def.handler({ file_path: "/forbidden" });
  assert.equal(result.isError, true);
  assert.equal((result.content[0] as { text: string }).text, "permission denied");
});

test("handler: 空渲染保持空字符串，不再补 (empty) 占位（Plan §4.6 要求）", async () => {
  const { client } = createMockIpc(async () => ({}));
  const def = buildShadowToolHandler(SHADOW_TOOLS[1]!, client); // read with empty result
  const result = await def.handler({ file_path: "/x" });
  assert.equal(result.isError, false);
  assert.equal((result.content[0] as { text: string }).text, "");
});

test("handler: ipc.callTool 抛错时收敛为 isError:true，不向 SDK 抛出 raw stack", async () => {
  const client = {
    async callTool(): Promise<never> {
      throw new Error("dispatcher exploded");
    },
  } as unknown as IpcClient;
  const def = buildShadowToolHandler(SHADOW_TOOLS[0]!, client);
  const result = await def.handler({ command: "ls" });
  assert.equal(result.isError, true);
  assert.equal((result.content[0] as { text: string }).text, "dispatcher exploded");
});
