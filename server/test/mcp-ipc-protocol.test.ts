import test from "node:test";
import assert from "node:assert/strict";
import { decodeIpcLines, encodeIpcMessage } from "../src/mcp-routed/ipc-protocol.js";

test("encodeIpcMessage 输出以 \\n 结尾的 JSON 行", () => {
  const wire = encodeIpcMessage({ type: "hello", token: "abc" });
  assert.equal(wire.endsWith("\n"), true);
  const parsed = JSON.parse(wire.slice(0, -1));
  assert.deepEqual(parsed, { type: "hello", token: "abc" });
});

test("decodeIpcLines 切分多条消息并保留残余", () => {
  const buf = `${JSON.stringify({ type: "hello", token: "x" })}\n${JSON.stringify({
    type: "tool_call",
    id: "1",
    toolName: "Bash",
    input: {},
  })}\n{"type":"hello_ack","ok":tru`;
  const { messages, rest } = decodeIpcLines(buf);
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.type, "hello");
  assert.equal(messages[1]?.type, "tool_call");
  assert.match(rest, /hello_ack/);
});

test("decodeIpcLines 对损坏行静默丢弃", () => {
  const { messages, rest } = decodeIpcLines("garbage\n{}\n{\"type\":\"hello\",\"token\":\"x\"}\n");
  // garbage 被丢弃；{} 不含合法 type 也被丢弃；hello 留下。
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.type, "hello");
  assert.equal(rest, "");
});

test("decodeIpcLines 处理无 \\n 收尾的不完整缓冲", () => {
  const { messages, rest } = decodeIpcLines('{"type":"hello","token":"x"');
  assert.equal(messages.length, 0);
  assert.equal(rest, '{"type":"hello","token":"x"');
});
