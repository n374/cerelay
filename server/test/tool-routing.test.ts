import test from "node:test";
import assert from "node:assert/strict";
import { isClientRoutedToolName, ToolRoutingStore } from "../src/tool-routing.js";

test("client routing includes built-in tools and MCP tools", () => {
  assert.equal(isClientRoutedToolName("Read"), true);
  assert.equal(isClientRoutedToolName("Bash"), true);
  assert.equal(isClientRoutedToolName("mcp__demo__ping"), true);
  assert.equal(isClientRoutedToolName("mcp__bad"), false);
  assert.equal(isClientRoutedToolName("WebFetch"), false);
  assert.equal(isClientRoutedToolName("Unknown"), false);
});

test("Plan D: cerelay 自己的 shadow MCP 工具不走 client-routed 路径（防双重执行）", () => {
  // cerelay-routed 子进程负责响应这些工具，PreToolUse hook 必须放行。
  assert.equal(isClientRoutedToolName("mcp__cerelay__bash"), false);
  assert.equal(isClientRoutedToolName("mcp__cerelay__read"), false);
  assert.equal(isClientRoutedToolName("mcp__cerelay__multi_edit"), false);
  // 用户配的其他 MCP server 工具仍然 client-routed
  assert.equal(isClientRoutedToolName("mcp__user__ping"), true);
});

test("tool routing store keeps built-ins fixed and allows extra configurable tools", () => {
  const routing = new ToolRoutingStore();

  assert.equal(routing.shouldRouteToHand("Read"), true);
  assert.equal(routing.shouldRouteToHand("mcp__demo__ping"), true);
  assert.equal(routing.shouldRouteToHand("WebFetch"), true);
  assert.equal(routing.shouldRouteToHand("WebSearch"), false);

  routing.update({
    handToolNames: ["WebSearch"],
    handToolPrefixes: ["connector__"],
  });

  assert.equal(routing.shouldRouteToHand("Read"), true);
  assert.equal(routing.shouldRouteToHand("WebFetch"), false);
  assert.equal(routing.shouldRouteToHand("WebSearch"), true);
  assert.equal(routing.shouldRouteToHand("connector__demo__call"), true);
});

test("ToolRoutingStore: cerelay shadow MCP 工具被排除在 hand routing 之外", () => {
  const routing = new ToolRoutingStore();
  assert.equal(routing.shouldRouteToHand("mcp__cerelay__bash"), false);
  assert.equal(routing.shouldRouteToHand("mcp__cerelay__edit"), false);
  // 即使加 prefix 配置，cerelay shadow 仍优先排除（防 prefix 冲突）
  routing.update({ handToolPrefixes: ["mcp__"] });
  assert.equal(routing.shouldRouteToHand("mcp__cerelay__bash"), false);
  assert.equal(routing.shouldRouteToHand("mcp__user__ping"), true);
});
