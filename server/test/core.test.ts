import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { HandRegistry } from "../src/hand-registry.js";
import { StatsCollector } from "../src/stats.js";
import { ToolRelay } from "../src/relay.js";

test("HandRegistry tracks hands, bindings, and stats", async () => {
  const registry = new HandRegistry();
  const socket = createMockSocket();

  registry.register("hand-1", socket, "token-1", "127.0.0.1");
  registry.bindSession("hand-1", "sess-1");

  assert.equal(registry.count(), 1);
  assert.equal(registry.get("hand-1")?.sessionIds.has("sess-1"), true);

  await registry.sendTo("hand-1", { ok: true });
  assert.deepEqual(socket.sent, ['{"ok":true}']);

  const stats = registry.stats();
  assert.equal(stats.length, 1);
  assert.equal(stats[0]?.sessionCount, 1);

  registry.unbindSession("hand-1", "sess-1");
  registry.unregister("hand-1");
  assert.equal(registry.count(), 0);
});

test("HandRegistry rejects missing or closed sockets", async () => {
  const registry = new HandRegistry();
  const closedSocket = createMockSocket(WebSocket.CLOSED);
  registry.register("hand-closed", closedSocket, "token", "127.0.0.1");

  await assert.rejects(() => registry.sendTo("missing", {}), /Hand 不存在/);
  await assert.rejects(() => registry.sendTo("hand-closed", {}), /Hand 连接已关闭/);
});

test("StatsCollector aggregates counters", () => {
  const stats = new StatsCollector();
  stats.onHandConnected();
  stats.onHandConnected();
  stats.onHandDisconnected();
  stats.onSessionCreated();
  stats.onSessionCreated();
  stats.onSessionEnded();
  stats.onToolCall("Read");
  stats.onToolCall("Read");
  stats.onToolCall("Write");
  stats.onMessageReceived();
  stats.onError();

  const snapshot = stats.snapshot();
  assert.equal(snapshot.handsOnline, 1);
  assert.equal(snapshot.totalConnections, 2);
  assert.equal(snapshot.sessionsActive, 1);
  assert.equal(snapshot.sessionsTotal, 2);
  assert.equal(snapshot.sessionsCompleted, 1);
  assert.equal(snapshot.toolCallsTotal, 3);
  assert.deepEqual(snapshot.toolCallsByName, { Read: 2, Write: 1 });
  assert.equal(snapshot.messagesTotal, 1);
  assert.equal(snapshot.errorsTotal, 1);
});

test("ToolRelay resolves, rejects, and cleans up pending calls", async () => {
  const relay = new ToolRelay();

  const pending = relay.createPending("req-1", "Read");
  assert.equal(relay.size(), 1);
  relay.resolve("req-1", { output: "ok" });
  assert.deepEqual(await pending, { output: "ok" });
  assert.equal(relay.size(), 0);

  const rejected = relay.createPending("req-2", "Write");
  relay.reject("req-2", new Error("boom"));
  await assert.rejects(rejected, /boom/);

  const cleaned = relay.createPending("req-3", "Bash");
  relay.cleanup(new Error("closed"));
  await assert.rejects(cleaned, /closed/);
});

function createMockSocket(readyState = WebSocket.OPEN): WebSocket & { sent: string[] } {
  return {
    readyState,
    sent: [] as string[],
    send(data: unknown, callback?: (error?: Error) => void) {
      this.sent.push(String(data));
      callback?.();
    },
  } as WebSocket & { sent: string[] };
}
