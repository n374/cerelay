import test from "node:test";
import assert from "node:assert/strict";
import { AdminEventBuffer } from "../src/admin-events.js";

test("AdminEventBuffer: 关闭时 record/fetch 都是 no-op", () => {
  const buf = new AdminEventBuffer(false);
  buf.record("test.kind", "s1", { foo: "bar" });
  assert.deepEqual(buf.fetch({}), []);
});

test("AdminEventBuffer: 开启时 record + 单调 id + sessionId/since 过滤", () => {
  const buf = new AdminEventBuffer(true);
  buf.record("a", "s1");
  buf.record("b", "s2");
  buf.record("c", "s1");
  const all = buf.fetch({});
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((e) => e.id), [1, 2, 3]);

  const onlyS1 = buf.fetch({ sessionId: "s1" });
  assert.deepEqual(onlyS1.map((e) => e.kind), ["a", "c"]);

  const sinceFirst = buf.fetch({ since: 1 });
  assert.deepEqual(sinceFirst.map((e) => e.id), [2, 3]);
});

test("AdminEventBuffer: 超过 MAX_BUFFER (10k) 时自动丢最早", () => {
  const buf = new AdminEventBuffer(true);
  for (let i = 0; i < 10_005; i++) buf.record("k", null);
  const all = buf.fetch({});
  assert.equal(all.length, 10_000);
  assert.equal(all[0].id, 6);             // 1-5 被丢
  assert.equal(all.at(-1)?.id, 10_005);
});
