import test from "node:test";
import assert from "node:assert/strict";
import {
  isClaudeHomeSettingsJson,
  redactClaudeSettingsLoginState,
} from "../src/claude-settings-redaction.js";

function buf(s: string): Buffer {
  return Buffer.from(s, "utf8");
}

// ============================================================
// redactClaudeSettingsLoginState
// ============================================================

test("非法 JSON 原样返回", () => {
  const input = buf("not-json{{{");
  const out = redactClaudeSettingsLoginState(input);
  assert.deepEqual(out, input);
});

test("空字符串原样返回", () => {
  const input = buf("");
  const out = redactClaudeSettingsLoginState(input);
  assert.deepEqual(out, input);
});

test("无登录态字段时 byte-equal 返回（不重新 stringify）", () => {
  const input = buf('{\n  "theme": "dark",\n  "statusLine": "git"\n}\n');
  const out = redactClaudeSettingsLoginState(input);
  assert.deepEqual(out, input, "原文无登录态字段时必须 byte-equal 返回");
});

test("env.ANTHROPIC_BASE_URL 命中", () => {
  const input = buf(JSON.stringify({
    theme: "dark",
    env: { ANTHROPIC_BASE_URL: "https://leak.example.com", FOO: "bar" },
  }));
  const out = redactClaudeSettingsLoginState(input);

  assert.equal(out.byteLength, input.byteLength, "size 必须等于原 size");
  const parsed = JSON.parse(out.toString("utf8"));
  assert.equal(parsed.env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(parsed.env.FOO, "bar", "env 中其他字段必须保留");
  assert.equal(parsed.theme, "dark", "顶层其他字段必须保留");
});

test("env.ANTHROPIC_API_KEY 命中", () => {
  const input = buf(JSON.stringify({ env: { ANTHROPIC_API_KEY: "sk-leak" } }));
  const out = redactClaudeSettingsLoginState(input);
  assert.equal(out.byteLength, input.byteLength);
  const parsed = JSON.parse(out.toString("utf8"));
  assert.equal(parsed.env.ANTHROPIC_API_KEY, undefined);
});

test("env.ANTHROPIC_AUTH_TOKEN 命中", () => {
  const input = buf(JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "tok-leak" } }));
  const out = redactClaudeSettingsLoginState(input);
  assert.equal(out.byteLength, input.byteLength);
  const parsed = JSON.parse(out.toString("utf8"));
  assert.equal(parsed.env.ANTHROPIC_AUTH_TOKEN, undefined);
});

test("顶层 apiKeyHelper 命中（无 env）", () => {
  const input = buf(JSON.stringify({
    theme: "light",
    apiKeyHelper: "/usr/bin/get-api-key",
  }));
  const out = redactClaudeSettingsLoginState(input);
  assert.equal(out.byteLength, input.byteLength);
  const parsed = JSON.parse(out.toString("utf8"));
  assert.equal(parsed.apiKeyHelper, undefined);
  assert.equal(parsed.theme, "light");
});

test("4 个字段同时命中", () => {
  const input = buf(JSON.stringify({
    theme: "dark",
    statusLine: "git",
    apiKeyHelper: "/usr/bin/key",
    env: {
      ANTHROPIC_BASE_URL: "https://leak.example.com/api",
      ANTHROPIC_API_KEY: "sk-leak-12345",
      ANTHROPIC_AUTH_TOKEN: "oauth-token-leak",
      OTHER_VAR: "preserved",
    },
    hooks: { PreToolUse: [] },
  }));
  const out = redactClaudeSettingsLoginState(input);

  assert.equal(out.byteLength, input.byteLength);
  const parsed = JSON.parse(out.toString("utf8"));
  assert.equal(parsed.apiKeyHelper, undefined);
  assert.equal(parsed.env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(parsed.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(parsed.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(parsed.env.OTHER_VAR, "preserved");
  assert.equal(parsed.theme, "dark");
  assert.equal(parsed.statusLine, "git");
  assert.deepEqual(parsed.hooks, { PreToolUse: [] });
});

test("env 删空后保留空对象", () => {
  const input = buf(JSON.stringify({ env: { ANTHROPIC_API_KEY: "x" } }));
  const out = redactClaudeSettingsLoginState(input);
  assert.equal(out.byteLength, input.byteLength);
  const parsed = JSON.parse(out.toString("utf8"));
  assert.deepEqual(parsed, { env: {} });
});

test("数组根原样返回（防御非对象根）", () => {
  const input = buf("[1,2,3]");
  const out = redactClaudeSettingsLoginState(input);
  assert.deepEqual(out, input);
});

test("标量根原样返回（防御非对象根）", () => {
  const input = buf('"foo"');
  const out = redactClaudeSettingsLoginState(input);
  assert.deepEqual(out, input);
});

test("null 根原样返回", () => {
  const input = buf("null");
  const out = redactClaudeSettingsLoginState(input);
  assert.deepEqual(out, input);
});

test("嵌套 env 不穿透（只删 top-level env 的目标 key）", () => {
  const input = buf(JSON.stringify({
    theme: "dark",
    nested: { env: { ANTHROPIC_API_KEY: "should-not-be-deleted" } },
  }));
  const out = redactClaudeSettingsLoginState(input);
  // 没有 top-level 登录态字段 → 不命中 → byte-equal 返回
  assert.deepEqual(out, input);
});

test("trailing whitespace 后 JSON.parse 仍然成功", () => {
  const input = buf(JSON.stringify({
    apiKeyHelper: "/path/to/something/very/long/just/to/create/diff",
    env: { ANTHROPIC_API_KEY: "sk-very-long-leaked-key-value" },
  }));
  const out = redactClaudeSettingsLoginState(input);
  // 必须能正常 parse（V8 接受 trailing whitespace）
  const parsed = JSON.parse(out.toString("utf8"));
  assert.equal(parsed.apiKeyHelper, undefined);
  assert.equal(parsed.env.ANTHROPIC_API_KEY, undefined);
});

test("apiKeyHelper 为非字符串时仍然删除", () => {
  // 防御性：即使字段类型异常也要删
  const input = buf(JSON.stringify({ apiKeyHelper: { script: "x" } }));
  const out = redactClaudeSettingsLoginState(input);
  assert.equal(out.byteLength, input.byteLength);
  const parsed = JSON.parse(out.toString("utf8"));
  assert.equal(parsed.apiKeyHelper, undefined);
});

test("env 不是对象时不影响", () => {
  // env 是字符串：不算"含登录态字段"，不重新 stringify
  const input = buf(JSON.stringify({ env: "not-an-object" }));
  const out = redactClaudeSettingsLoginState(input);
  assert.deepEqual(out, input);
});

test("env 是数组时不影响", () => {
  const input = buf(JSON.stringify({ env: [] }));
  const out = redactClaudeSettingsLoginState(input);
  assert.deepEqual(out, input);
});

test("命中后输出尾部全是 0x20 空格", () => {
  const input = buf(JSON.stringify({
    apiKeyHelper: "/very/long/path/to/helper/script",
  }));
  const out = redactClaudeSettingsLoginState(input);
  assert.equal(out.byteLength, input.byteLength);

  // 找到 minified JSON 的末尾位置（"}" 后面应当全是空格）
  const text = out.toString("utf8");
  const closingBrace = text.lastIndexOf("}");
  assert.ok(closingBrace > 0);
  const tail = text.slice(closingBrace + 1);
  assert.match(tail, /^ *$/, "}" + " 之后必须全是空格");
});

test("offset 任意位置（含 padding 区）都不泄漏原始字段值", () => {
  // 安全检查：删除字段后，原文位置不应该残留登录态字符串
  const input = buf(JSON.stringify({
    apiKeyHelper: "/secret/key/script-DO-NOT-LEAK",
    env: {
      ANTHROPIC_API_KEY: "sk-DO-NOT-LEAK-1234567890",
      ANTHROPIC_BASE_URL: "https://DO-NOT-LEAK.example.com",
    },
  }));
  const out = redactClaudeSettingsLoginState(input);
  const text = out.toString("utf8");
  assert.doesNotMatch(text, /DO-NOT-LEAK/);
});

// ============================================================
// isClaudeHomeSettingsJson
// ============================================================

test("isClaudeHomeSettingsJson: claude-home + settings.json → true", () => {
  assert.equal(isClaudeHomeSettingsJson("claude-home", "settings.json"), true);
});

test("isClaudeHomeSettingsJson: claude-home + settings.local.json → false", () => {
  assert.equal(isClaudeHomeSettingsJson("claude-home", "settings.local.json"), false);
});

test("isClaudeHomeSettingsJson: claude-home + 嵌套 settings.json → false", () => {
  assert.equal(isClaudeHomeSettingsJson("claude-home", "subdir/settings.json"), false);
});

test("isClaudeHomeSettingsJson: claude-json + 空 → false", () => {
  assert.equal(isClaudeHomeSettingsJson("claude-json", ""), false);
});

test("isClaudeHomeSettingsJson: claude-json + settings.json → false", () => {
  // claude-json scope 是单文件 ~/.claude.json，不是 ~/.claude/settings.json
  assert.equal(isClaudeHomeSettingsJson("claude-json", "settings.json"), false);
});
