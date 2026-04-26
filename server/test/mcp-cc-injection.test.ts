import test from "node:test";
import assert from "node:assert/strict";
import {
  SHADOWED_BUILTIN_TOOLS,
  buildMcpConfigJson,
  buildShadowMcpInjectionArgs,
  buildSteeringPrompt,
  resolveShadowMcpLaunchSpec,
} from "../src/mcp-cc-injection.ts";

test("SHADOWED_BUILTIN_TOOLS 含 7 个 CC 内置工具名", () => {
  assert.deepEqual(
    [...SHADOWED_BUILTIN_TOOLS].sort(),
    ["Bash", "Edit", "Glob", "Grep", "MultiEdit", "Read", "Write"],
  );
});

test("resolveShadowMcpLaunchSpec 在 dev 环境（仅有 .ts）返回 tsx loader 形式", () => {
  // 当前测试在 server/dist 不存在的 dev 环境跑。
  const spec = resolveShadowMcpLaunchSpec();
  assert.ok(spec.command.length > 0);
  // 至少要么是 dist .js 单 arg，要么是 [--import, tsx, ...ts]。
  if (spec.args.length === 1) {
    assert.match(spec.args[0]!, /mcp-routed\/index\.js$/);
  } else {
    assert.deepEqual(spec.args.slice(0, 2), ["--import", "tsx"]);
    assert.match(spec.args[2]!, /mcp-routed\/index\.ts$/);
  }
});

test("buildMcpConfigJson 含 cerelay server、env 三件套、可注入 launchSpec", () => {
  const json = buildMcpConfigJson({
    sessionId: "pty-test-1",
    socketPath: "/tmp/test.sock",
    token: "secret",
    launchSpec: { command: "/usr/bin/node", args: ["/abs/index.js"] },
  });
  const parsed = JSON.parse(json);
  assert.equal(typeof parsed.mcpServers, "object");
  const cerelay = parsed.mcpServers.cerelay;
  assert.equal(cerelay.command, "/usr/bin/node");
  assert.deepEqual(cerelay.args, ["/abs/index.js"]);
  assert.deepEqual(cerelay.env, {
    CERELAY_MCP_IPC_SOCKET: "/tmp/test.sock",
    CERELAY_MCP_IPC_TOKEN: "secret",
    CERELAY_MCP_SESSION_ID: "pty-test-1",
  });
});

test("buildSteeringPrompt 含 7 个 builtin → mcp__cerelay__ 映射 + append 风格标签", () => {
  const prompt = buildSteeringPrompt();
  assert.match(prompt, /<cerelay-tool-routing-policy>/);
  assert.match(prompt, /<\/cerelay-tool-routing-policy>/);
  // 7 个 builtin 都要在 prompt 里出现并跟 mcp__cerelay__ 对应工具名映射。
  for (const builtin of SHADOWED_BUILTIN_TOOLS) {
    assert.match(prompt, new RegExp(`${builtin}\\s+→\\s+mcp__cerelay__`));
  }
  // 用户自配 MCP 不应被替换的提示
  assert.match(prompt, /User-installed MCP servers/);
});

test("buildShadowMcpInjectionArgs 输出 --mcp-config / --append-system-prompt / --disallowedTools", () => {
  const args = buildShadowMcpInjectionArgs({
    sessionId: "pty-x",
    socketPath: "/tmp/x.sock",
    token: "tok",
    launchSpec: { command: "/usr/bin/node", args: ["/x.js"] },
  });
  // 结构：[--mcp-config, <json>, --append-system-prompt, <text>, --disallowedTools, <list>]
  assert.equal(args.length, 6);
  assert.equal(args[0], "--mcp-config");
  const config = JSON.parse(args[1]!);
  assert.equal(config.mcpServers.cerelay.env.CERELAY_MCP_SESSION_ID, "pty-x");
  assert.equal(args[2], "--append-system-prompt");
  assert.match(args[3]!, /cerelay-tool-routing-policy/);
  assert.equal(args[4], "--disallowedTools");
  assert.equal(
    args[5],
    "Bash,Read,Write,Edit,MultiEdit,Glob,Grep",
    "硬保险列表必须覆盖 SHADOWED_BUILTIN_TOOLS",
  );
});
