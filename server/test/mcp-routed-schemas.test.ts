// schemas.ts 单测：固化"shadow tool schema 与 client/src/tools 实际接受字段
// 一致"这一不变量。每次 client 工具签名变化必须同步这里。
import test from "node:test";
import assert from "node:assert/strict";
import {
  SHADOW_TOOLS,
  SHADOW_TOOL_NAME_PREFIX,
  fullyQualifiedShadowToolName,
  isCerelayShadowToolName,
} from "../src/mcp-routed/schemas.ts";
import { isMcpToolName } from "../src/tool-routing.ts";

test("SHADOW_TOOLS 包含 7 个工具，shortName/builtinName 一一对应", () => {
  const shortNames = SHADOW_TOOLS.map((t) => t.shortName).sort();
  const builtinNames = SHADOW_TOOLS.map((t) => t.builtinName).sort();
  assert.deepEqual(shortNames, ["bash", "edit", "glob", "grep", "multi_edit", "read", "write"]);
  assert.deepEqual(builtinNames, [
    "Bash",
    "Edit",
    "Glob",
    "Grep",
    "MultiEdit",
    "Read",
    "Write",
  ]);
});

test("SHADOW_TOOLS shortName 唯一", () => {
  const set = new Set(SHADOW_TOOLS.map((t) => t.shortName));
  assert.equal(set.size, SHADOW_TOOLS.length);
});

test("每个 schema 必须 type:object + additionalProperties:false（防字段漂移）", () => {
  for (const tool of SHADOW_TOOLS) {
    assert.equal(tool.inputSchema.type, "object", `${tool.shortName} type 必须是 object`);
    assert.equal(
      tool.inputSchema.additionalProperties,
      false,
      `${tool.shortName} additionalProperties 必须是 false，否则 client 不实现的字段会被静默忽略`,
    );
  }
});

// 与 client/src/tools/* 接收字段对齐（每次扩展 client 工具时必须同步这里）。
const EXPECTED_TOOL_FIELDS: Record<string, { required: string[]; optional: string[] }> = {
  bash: { required: ["command"], optional: ["timeout"] },
  read: { required: ["file_path"], optional: ["offset", "limit"] },
  write: { required: ["file_path", "content"], optional: [] },
  edit: { required: ["file_path", "old_string", "new_string"], optional: ["replace_all"] },
  multi_edit: { required: ["file_path", "edits"], optional: [] },
  glob: { required: ["pattern"], optional: ["path"] },
  grep: { required: ["pattern"], optional: ["path", "glob"] },
};

test("每个 shadow tool 的字段必须严格匹配 client/src/tools 实际接受的字段", () => {
  for (const tool of SHADOW_TOOLS) {
    const expected = EXPECTED_TOOL_FIELDS[tool.shortName];
    if (!expected) {
      assert.fail(`${tool.shortName} 缺少 EXPECTED_TOOL_FIELDS 映射`);
    }
    const props = tool.inputSchema.properties as Record<string, unknown>;
    const actualKeys = Object.keys(props).sort();
    const expectedKeys = [...expected.required, ...expected.optional].sort();
    assert.deepEqual(
      actualKeys,
      expectedKeys,
      `${tool.shortName}.properties 字段集合不一致：实际 ${JSON.stringify(actualKeys)} vs 期望 ${JSON.stringify(expectedKeys)}`,
    );
    assert.deepEqual(
      (tool.inputSchema.required as string[]).sort(),
      expected.required.sort(),
      `${tool.shortName}.required 不一致`,
    );
  }
});

test("multi_edit edits[*] 不暴露 replace_all（与 client 实现一致）", () => {
  const multiEdit = SHADOW_TOOLS.find((t) => t.shortName === "multi_edit")!;
  const editsSchema = (multiEdit.inputSchema.properties as { edits: { items: { properties: Record<string, unknown> } } }).edits;
  const editKeys = Object.keys(editsSchema.items.properties).sort();
  assert.deepEqual(editKeys, ["new_string", "old_string"]);
});

test("bash.timeout 描述包含 'seconds'（client 按秒解释）", () => {
  const bash = SHADOW_TOOLS.find((t) => t.shortName === "bash")!;
  const timeoutSchema = (bash.inputSchema.properties as { timeout: { description: string } }).timeout;
  assert.match(timeoutSchema.description, /second/i);
});

test("read.offset/limit 描述包含 'character'（client 按字符切片）", () => {
  const read = SHADOW_TOOLS.find((t) => t.shortName === "read")!;
  const offsetSchema = (read.inputSchema.properties as { offset: { description: string } }).offset;
  const limitSchema = (read.inputSchema.properties as { limit: { description: string } }).limit;
  assert.match(offsetSchema.description, /character/i);
  assert.match(limitSchema.description, /character/i);
});

test("fullyQualifiedShadowToolName: 加 mcp__cerelay__ 前缀", () => {
  assert.equal(fullyQualifiedShadowToolName("bash"), "mcp__cerelay__bash");
  assert.equal(fullyQualifiedShadowToolName("multi_edit"), "mcp__cerelay__multi_edit");
});

test("isCerelayShadowToolName: 仅匹配 mcp__cerelay__* 前缀", () => {
  assert.equal(isCerelayShadowToolName("mcp__cerelay__bash"), true);
  assert.equal(isCerelayShadowToolName("mcp__cerelay__edit"), true);
  assert.equal(isCerelayShadowToolName("mcp__other__bash"), false);
  assert.equal(isCerelayShadowToolName("Bash"), false);
  assert.equal(isCerelayShadowToolName(""), false);
});

test("fully-qualified shadow tool 名仍然被 isMcpToolName 视为 MCP 工具（CC 命名规则一致）", () => {
  for (const tool of SHADOW_TOOLS) {
    const fqn = fullyQualifiedShadowToolName(tool.shortName);
    assert.equal(isMcpToolName(fqn), true, `${fqn} 应该被 isMcpToolName 接受`);
  }
});

test("SHADOW_TOOL_NAME_PREFIX 与 fullyQualifiedShadowToolName 的拼接一致", () => {
  assert.equal(SHADOW_TOOL_NAME_PREFIX, "mcp__cerelay__");
  assert.ok(fullyQualifiedShadowToolName("x").startsWith(SHADOW_TOOL_NAME_PREFIX));
});
