import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configureLogger, createLogger } from "../src/logger.js";

test("logger writes plain-text logs to the configured file", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "axon-hand-log-test-"));
  const logPath = path.join(dir, "hand.log");
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
