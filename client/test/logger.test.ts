import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configureLogger, createLogger, endStream, flushLogger } from "../src/logger.js";

test("consoleSink can intercept active console lines", (t) => {
  const originalStdoutWrite = process.stdout.write;
  const stdout: string[] = [];
  const sinkLines: string[] = [];
  process.stdout.write = ((data: string | Buffer) => {
    stdout.push(String(data));
    return true;
  }) as typeof process.stdout.write;
  t.after(() => {
    process.stdout.write = originalStdoutWrite;
    configureLogger({ console: true, json: false, filePath: null, consoleSink: undefined });
  });

  configureLogger({
    minLevel: "info",
    console: true,
    filePath: null,
    consoleSink: (line) => {
      sinkLines.push(line);
      return true;
    },
  });
  createLogger("sink-test").info("intercept me");

  assert.equal(stdout.length, 0);
  assert.equal(sinkLines.length, 1);
  assert.match(sinkLines[0]!, /intercept me/);
});

test("consoleSink returning false allows stdout write", (t) => {
  const originalStdoutWrite = process.stdout.write;
  const stdout: string[] = [];
  process.stdout.write = ((data: string | Buffer) => {
    stdout.push(String(data));
    return true;
  }) as typeof process.stdout.write;
  t.after(() => {
    process.stdout.write = originalStdoutWrite;
    configureLogger({ console: true, json: false, filePath: null, consoleSink: undefined });
  });

  configureLogger({
    minLevel: "info",
    console: true,
    filePath: null,
    consoleSink: () => false,
  });
  createLogger("sink-test").info("write normally");

  assert.ok(stdout.join("").includes("write normally"));
});

test("flushLogger resolves without an active file stream", async () => {
  configureLogger({ filePath: null, consoleSink: undefined });
  await assert.doesNotReject(flushLogger());
});

test("endStream resolves immediately for an already-ended stream", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cerelay-client-log-ended-"));
  const logPath = path.join(dir, "client.log");
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const endedStream = createWriteStream(logPath);
  endedStream.end();
  await once(endedStream, "finish");

  const result = await Promise.race([
    endStream(endedStream).then(() => "ok"),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 50)),
  ]);

  assert.strictEqual(result, "ok");
});

test("logger writes plain-text logs to the configured file", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cerelay-client-log-test-"));
  const logPath = path.join(dir, "client.log");
  t.after(async () => {
    configureLogger({ filePath: null, minLevel: "info" });
    await rm(dir, { recursive: true, force: true });
  });

  configureLogger({
    minLevel: "debug",
    filePath: logPath,
  });

  const logger = createLogger("hand-test");
  logger.info("hello file log", { sessionId: "sess-1" });
  logger.debug("debug line");

  await new Promise((resolve) => setTimeout(resolve, 30));
  const content = await readFile(logPath, "utf8");

  assert.match(content, /INFO\s+\[hand-test\]\s+hello file log/);
  assert.match(content, /sessionId="sess-1"/);
  assert.match(content, /DEBUG\s+\[hand-test\]\s+debug line/);
});
