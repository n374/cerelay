import test from "node:test";
import assert from "node:assert/strict";
import { isHandRoutedToolName } from "../src/session.js";
import { ToolRoutingStore } from "../src/tool-routing.js";

test("hand routing includes built-in tools and MCP tools", () => {
  assert.equal(isHandRoutedToolName("Read"), true);
  assert.equal(isHandRoutedToolName("Bash"), true);
  assert.equal(isHandRoutedToolName("mcp__demo__ping"), true);
  assert.equal(isHandRoutedToolName("mcp__bad"), false);
  assert.equal(isHandRoutedToolName("WebFetch"), false);
  assert.equal(isHandRoutedToolName("Unknown"), false);
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
