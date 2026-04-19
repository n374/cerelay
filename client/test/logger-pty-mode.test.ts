import test from "node:test";
import assert from "node:assert/strict";
import { createLogger, configureLogger } from "../src/logger.js";

/**
 * 测试 Hand Logger 在 PTY 模式下的输出隔离
 *
 * 背景：在 PTY passthrough 模式下，日志应该只写入文件，
 * 不应该混入 PTY 的 stdout/stderr，否则会干扰 PTY 的正常工作。
 */

test("Logger respects console output configuration", (t) => {
  // 保存原始的 stdout/stderr 写入函数
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;

  const capturedOutput: Array<{ stream: "stdout" | "stderr"; data: string }> =
    [];

  // 拦截 stdout/stderr 的写入
  process.stdout.write = ((data: string | Buffer) => {
    capturedOutput.push({ stream: "stdout", data: String(data) });
    return true;
  }) as any;

  process.stderr.write = ((data: string | Buffer) => {
    capturedOutput.push({ stream: "stderr", data: String(data) });
    return true;
  }) as any;

  t.after(() => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  });

  // 测试 1：默认情况下，日志输出到 console
  {
    capturedOutput.length = 0;
    configureLogger({ minLevel: "info", console: true });
    const logger = createLogger("test-console-enabled");
    logger.info("test message 1", { field: "value" });

    assert.ok(
      capturedOutput.length > 0,
      "console 启用时应该输出到 stdout/stderr"
    );
    const hasOutput = capturedOutput.some(
      (o) => o.data.includes("test message 1") || o.data.includes("value")
    );
    assert.ok(hasOutput, "日志内容应该包含消息和字段");
  }

  // 测试 2：禁用 console 时，日志不应该输出到 stdout/stderr
  {
    capturedOutput.length = 0;
    configureLogger({ minLevel: "info", console: false });
    const logger = createLogger("test-console-disabled");
    logger.info("test message 2", { field: "value" });

    // console 禁用后，不应该有任何输出到 stdout/stderr
    assert.equal(
      capturedOutput.length,
      0,
      "console 禁用时不应该写入 stdout/stderr"
    );
  }

  // 测试 3：禁用后重新启用，日志应该恢复输出
  {
    capturedOutput.length = 0;
    configureLogger({ console: true });
    const logger = createLogger("test-console-re-enabled");
    logger.info("test message 3");

    assert.ok(
      capturedOutput.length > 0,
      "重新启用 console 后应该恢复输出"
    );
  }
});

test("Logger writes to file even when console is disabled", async (t) => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");

  // 创建临时日志文件
  const tmpDir = os.tmpdir();
  const testLogFile = path.join(tmpDir, `axon-test-${Date.now()}.log`);

  t.after(async () => {
    try {
      await fs.rm(testLogFile);
    } catch {
      // 忽略删除失败
    }
  });

  // 禁用 console 输出，只写文件
  configureLogger({
    minLevel: "info",
    filePath: testLogFile,
    console: false,
  });

  const logger = createLogger("test-file-only");
  logger.info("file only message", { test: true });

  // 等待文件被写入
  await new Promise((resolve) => setTimeout(resolve, 100));

  // 验证日志被写入文件
  const content = await fs.readFile(testLogFile, "utf8");
  assert.ok(
    content.includes("file only message"),
    "日志应该被写入文件"
  );
  assert.ok(content.includes("test"), "字段应该被写入文件");
});

test("Logger handles error level correctly with console disabled", (t) => {
  const originalStderrWrite = process.stderr.write;
  const capturedStderr: string[] = [];

  process.stderr.write = ((data: string | Buffer) => {
    capturedStderr.push(String(data));
    return true;
  }) as any;

  t.after(() => {
    process.stderr.write = originalStderrWrite;
  });

  // 禁用 console
  configureLogger({ console: false, minLevel: "error" });
  const logger = createLogger("test-error");
  logger.error("test error message");

  // 即使 error 级别也不应该输出
  assert.equal(
    capturedStderr.length,
    0,
    "console 禁用时不应该输出 error 到 stderr"
  );
});

test("Logger json mode respects console configuration", (t) => {
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const capturedOutput: string[] = [];

  process.stdout.write = ((data: string | Buffer) => {
    capturedOutput.push(String(data));
    return true;
  }) as any;

  process.stderr.write = ((data: string | Buffer) => {
    capturedOutput.push(String(data));
    return true;
  }) as any;

  t.after(() => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    // 恢复默认配置
    configureLogger({ console: true });
  });

  // 测试 json 模式下 console 禁用
  {
    capturedOutput.length = 0;
    configureLogger({ json: true, console: false, minLevel: "info" });
    const logger = createLogger("test-json-disabled");
    logger.info("json test", { field: "value" });

    assert.equal(
      capturedOutput.length,
      0,
      "json 模式下 console 禁用时不应该输出"
    );
  }

  // 测试 json 模式下 console 启用
  {
    capturedOutput.length = 0;
    configureLogger({ json: true, console: true, minLevel: "info" });
    const logger = createLogger("test-json-enabled");
    logger.info("json test 2", { field: "value" });

    assert.ok(
      capturedOutput.length > 0,
      "json 模式下 console 启用时应该输出"
    );
    const output = capturedOutput.join("");
    try {
      const parsed = JSON.parse(output.split("\n")[0]);
      assert.equal(parsed.message, "json test 2", "json 格式应该包含消息");
      assert.equal(parsed.field, "value", "json 格式应该包含字段");
    } catch {
      throw new Error(`无法解析 json 输出: ${output}`);
    }
  }
});
