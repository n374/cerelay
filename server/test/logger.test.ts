import test from "node:test";
import assert from "node:assert/strict";
import { Logger, configureLogger, createLogger } from "../src/logger.js";

test("Logger writes json logs to the expected stream", () => {
  const stdout = captureWrites(process.stdout);
  const stderr = captureWrites(process.stderr);

  try {
    const logger = new Logger("unit", "debug", true);
    logger.info("hello", { a: 1 });
    logger.error("oops", { b: 2 });

    assert.match(stdout.output, /"component":"unit"/);
    assert.match(stdout.output, /"message":"hello"/);
    assert.match(stderr.output, /"message":"oops"/);
  } finally {
    stdout.restore();
    stderr.restore();
  }
});

test("configureLogger affects createLogger", () => {
  const stdout = captureWrites(process.stdout);

  try {
    configureLogger({ minLevel: "warn", json: true });
    const logger = createLogger("configured");
    logger.info("skip");
    logger.warn("shown");
    assert.doesNotMatch(stdout.output, /skip/);
    assert.match(stdout.output, /shown/);
  } finally {
    stdout.restore();
    configureLogger({ minLevel: "info", json: false });
  }
});

function captureWrites(stream: NodeJS.WriteStream): {
  output: string;
  restore: () => void;
} {
  let output = "";
  const original = stream.write.bind(stream);

  const replacement = ((chunk: unknown, ...args: unknown[]) => {
    output += String(chunk);
    const cb = args.find((arg) => typeof arg === "function") as (() => void) | undefined;
    cb?.();
    return true;
  }) as typeof stream.write;

  stream.write = replacement;

  return {
    get output() {
      return output;
    },
    restore() {
      stream.write = original;
    },
  };
}
