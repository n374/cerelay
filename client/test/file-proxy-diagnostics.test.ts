import test from "node:test";
import assert from "node:assert/strict";
import { FileProxyDedupMap } from "../src/file-proxy-diagnostics.js";
import { configureLogger } from "../src/logger.js";

function captureLogLines(t: { after(callback: () => void): void }): string[] {
  const lines: string[] = [];
  configureLogger({
    minLevel: "info",
    console: true,
    filePath: null,
    consoleSink: (line) => {
      lines.push(line);
      return true;
    },
  });
  t.after(() => {
    configureLogger({ console: true, filePath: null, consoleSink: undefined });
  });
  return lines;
}

function makeTimerHarness() {
  const callbacks: Array<() => void> = [];
  return {
    setTimeoutFn: ((callback: () => void) => {
      callbacks.push(callback);
      return { unref() {} } as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimeoutFn: (() => undefined) as typeof clearTimeout,
    fireNext() {
      const callback = callbacks.shift();
      callback?.();
    },
  };
}

test("FileProxyDedupMap emits first occurrence immediately", (t) => {
  const lines = captureLogLines(t);
  const timers = makeTimerHarness();
  const dedup = new FileProxyDedupMap({
    roots: ["/repo"],
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  dedup.record({ op: "read", path: "/repo/.claude/a.json", status: "ok", bytes: 12, elapsedMs: 3 });

  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /file_proxy: read \.claude\/a\.json bytes=12 elapsedMs=3 ok/);
});

test("FileProxyDedupMap emits repeat summary when timer fires", (t) => {
  const lines = captureLogLines(t);
  const timers = makeTimerHarness();
  const dedup = new FileProxyDedupMap({
    roots: ["/repo"],
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  dedup.record({ op: "read", path: "/repo/.claude/a.json", status: "ok", bytes: 12, elapsedMs: 3 });
  dedup.record({ op: "read", path: "/repo/.claude/a.json", status: "ok", bytes: 5, elapsedMs: 7 });
  timers.fireNext();

  assert.equal(lines.length, 2);
  assert.match(lines[1]!, /repeated \+1 times totalBytes=17 maxElapsedMs=7/);
});

test("FileProxyDedupMap does not emit summary for a single occurrence", (t) => {
  const lines = captureLogLines(t);
  const timers = makeTimerHarness();
  const dedup = new FileProxyDedupMap({
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  dedup.record({ op: "getattr", path: "/tmp/a", status: "error", errno: 2, bytes: 0, elapsedMs: 1 });
  timers.fireNext();

  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /errno=2/);
});

test("FileProxyDedupMap dispose flushes pending repeat summaries", (t) => {
  const lines = captureLogLines(t);
  const timers = makeTimerHarness();
  const dedup = new FileProxyDedupMap({
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  dedup.record({ op: "write", path: "/tmp/a", status: "ok", bytes: 4, elapsedMs: 2 });
  dedup.record({ op: "write", path: "/tmp/a", status: "ok", bytes: 6, elapsedMs: 4 });
  dedup.dispose();

  assert.equal(lines.length, 2);
  assert.match(lines[1]!, /file_proxy: write \/tmp\/a repeated \+1 times totalBytes=10 maxElapsedMs=4/);
});
