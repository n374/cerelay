import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { DaemonControlClient } from "../src/daemon-control.js";

/**
 * Capture 写出的字节到 in-memory buffer, 供同步断言。
 * Writable 实现保证 write() 返回前 _write 已被调用并 push 到 chunks。
 */
class CapturingStream extends Writable {
  public chunks: string[] = [];

  override _write(chunk: any, _enc: BufferEncoding, cb: (e?: Error) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    cb();
  }

  lines(): string[] {
    return this.chunks.join("").split("\n").filter((s) => s.length > 0);
  }
}

test("DaemonControlClient.putNegative 写出 line-delimited JSON", async () => {
  const stream = new CapturingStream();
  const client = new DaemonControlClient(stream);
  await client.putNegative("/foo/bar");
  const lines = stream.lines();
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { type: "put_negative", path: "/foo/bar" });
});

test("DaemonControlClient.invalidateNegativePrefix 字段名是 path 不是 prefix", async () => {
  const stream = new CapturingStream();
  const client = new DaemonControlClient(stream);
  await client.invalidateNegativePrefix("/a/b");
  const lines = stream.lines();
  assert.deepEqual(JSON.parse(lines[0]), { type: "invalidate_negative_prefix", path: "/a/b" });
});

test("DaemonControlClient.invalidateCache 带 path 字段 (精确清理, 非 clear-all)", async () => {
  const stream = new CapturingStream();
  const client = new DaemonControlClient(stream);
  await client.invalidateCache("/some/file");
  const lines = stream.lines();
  assert.deepEqual(JSON.parse(lines[0]), { type: "invalidate_cache", path: "/some/file" });
});

test("DaemonControlClient.shutdown 不带 path", async () => {
  const stream = new CapturingStream();
  const client = new DaemonControlClient(stream);
  await client.shutdown();
  const lines = stream.lines();
  assert.deepEqual(JSON.parse(lines[0]), { type: "shutdown" });
});

test("多次发送累积成多行 line-delimited JSON", async () => {
  const stream = new CapturingStream();
  const client = new DaemonControlClient(stream);
  await client.putNegative("/a");
  await client.putNegative("/b");
  await client.invalidateNegativePrefix("/c");
  const lines = stream.lines();
  assert.equal(lines.length, 3);
  assert.deepEqual(JSON.parse(lines[0]), { type: "put_negative", path: "/a" });
  assert.deepEqual(JSON.parse(lines[1]), { type: "put_negative", path: "/b" });
  assert.deepEqual(JSON.parse(lines[2]), { type: "invalidate_negative_prefix", path: "/c" });
});

test("stream.write 抛错时降级为 warn (不抛, 不阻塞)", async () => {
  const broken = {
    write: () => { throw new Error("EPIPE"); },
    once: () => {},
  } as unknown as Writable;
  const client = new DaemonControlClient(broken);
  // 不应抛出
  await client.putNegative("/x");
  assert.ok(true);
});
