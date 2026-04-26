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

test("decodeIpcLines 拒绝缺少必填字段的 tool_call（防 toolName=undefined 进 dispatcher）", () => {
  // 缺 toolName
  const buf = `{"type":"tool_call","id":"1","input":{}}\n{"type":"tool_call","id":"2","toolName":"Bash","input":{}}\n`;
  const { messages } = decodeIpcLines(buf);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.type, "tool_call");
});

test("decodeIpcLines 拒绝 hello 缺 token / hello_ack 缺 ok / tool_result 缺 id", () => {
  const buf = [
    `{"type":"hello"}`,
    `{"type":"hello_ack"}`,
    `{"type":"tool_result","output":"x"}`,
    `{"type":"hello","token":"good"}`,
  ].join("\n") + "\n";
  const { messages } = decodeIpcLines(buf);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.type, "hello");
});

test("decodeIpcLines 跨多 chunk 累积才能切出完整行（半包重组）", () => {
  // 模拟 socket 多 chunk 投递。
  let leftover = "";
  const collected: string[] = [];
  for (const chunk of ['{"type":"', 'hello","tok', 'en":"abc"}\n{"type":"hel', 'lo_ack","ok":true}\n']) {
    leftover += chunk;
    const { messages, rest } = decodeIpcLines(leftover);
    leftover = rest;
    for (const m of messages) {
      collected.push(m.type);
    }
  }
  assert.deepEqual(collected, ["hello", "hello_ack"]);
  assert.equal(leftover, "");
});
