import { createWriteStream, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import type { WriteStream } from "node:fs";

export type LogLevel = "debug" | "info" | "warn" | "error";

type LogFields = Record<string, unknown>;

interface LogEntry {
  time: string;
  level: LogLevel;
  component: string;
  message: string;
  [key: string]: unknown;
}

const LEVEL_VALUES: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class Logger {
  private readonly component: string;

  constructor(component: string) {
    this.component = component;
  }

  debug(message: string, fields?: LogFields): void {
    this.log("debug", message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.log("info", message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.log("warn", message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.log("error", message, fields);
  }

  child(fields: LogFields): Logger {
    return new ChildLogger(this.component, fields);
  }

  protected log(level: LogLevel, message: string, fields?: LogFields): void {
    // 运行时引用全局配置，确保 configureLogger 后生效
    if (LEVEL_VALUES[level] < LEVEL_VALUES[globalMinLevel]) {
      return;
    }

    const entry: LogEntry = {
      time: new Date().toISOString(),
      level,
      component: this.component,
      message,
      ...fields,
    };

    if (globalJsonMode) {
      const line = JSON.stringify(entry);
      if (globalConsoleOutputEnabled) {
        const output = level === "error" ? process.stderr : process.stdout;
        writeConsoleLine(output, line);
      }
      writeLogFile(line);
      return;
    }

    this.prettyPrint(entry);
  }

  private prettyPrint(entry: LogEntry): void {
    const plainLine = formatPrettyLine(entry, false);
    writeLogFile(plainLine);
    if (globalConsoleOutputEnabled) {
      const line = formatPrettyLine(entry, true);
      if (entry.level === "error") {
        writeConsoleLine(process.stderr, line);
      } else {
        writeConsoleLine(process.stdout, line);
      }
    }
  }
}

function formatPrettyLine(entry: LogEntry, colorize: boolean): string {
    const color = {
      debug: "\x1b[90m",
      info: "\x1b[36m",
      warn: "\x1b[33m",
      error: "\x1b[31m",
    }[entry.level];
    const reset = "\x1b[0m";
    const bold = "\x1b[1m";
    const dim = "\x1b[2m";
    const maybeColor = (value: string): string => colorize ? value : "";

    const extras = Object.entries(entry)
      .filter(([key]) => !["time", "level", "component", "message"].includes(key))
      .map(([key, value]) => `${maybeColor(dim)}${key}=${JSON.stringify(value)}${maybeColor(reset)}`)
      .join(" ");

    return [
      `${maybeColor(dim)}${entry.time.substring(11, 23)}${maybeColor(reset)}`,
      `${maybeColor(color)}${maybeColor(bold)}${entry.level.toUpperCase().padEnd(5)}${maybeColor(reset)}`,
      `${maybeColor(dim)}[${entry.component}]${maybeColor(reset)}`,
      entry.message,
      extras,
    ]
      .filter(Boolean)
      .join(" ");
}

class ChildLogger extends Logger {
  private readonly fixedFields: LogFields;

  constructor(component: string, fixedFields: LogFields) {
    super(component);
    this.fixedFields = fixedFields;
  }

  protected override log(level: LogLevel, message: string, fields?: LogFields): void {
    super.log(level, message, { ...this.fixedFields, ...fields });
  }
}

let globalMinLevel: LogLevel = "info";
let globalJsonMode = false;
let globalLogFilePath: string | null = resolveDefaultLogFilePath();
let globalLogFileStream: ReturnType<typeof createWriteStream> | null = null;
let globalConsoleOutputEnabled = true;
let globalConsoleSink: ((line: string) => boolean) | undefined;

export function configureLogger(options: {
  minLevel?: LogLevel;
  json?: boolean;
  filePath?: string | null;
  console?: boolean;
  consoleSink?: (line: string) => boolean;
}): void {
  if (options.minLevel) {
    globalMinLevel = options.minLevel;
  }
  if (options.json !== undefined) {
    globalJsonMode = options.json;
  }
  if (options.filePath !== undefined) {
    if (globalLogFileStream) {
      globalLogFileStream.end();
      globalLogFileStream = null;
    }
    globalLogFilePath = options.filePath;
  }
  if (options.console !== undefined) {
    globalConsoleOutputEnabled = options.console;
  }
  if (options.consoleSink !== undefined) {
    globalConsoleSink = options.consoleSink;
  }
}

export function createLogger(component: string): Logger {
  return new Logger(component);
}

export function resolveDefaultLogFilePath(): string {
  return path.join(tmpdir(), "cerelay-client.log");
}

export function getLogFilePath(): string | null {
  return globalLogFilePath;
}

function writeLogFile(line: string): void {
  const stream = ensureLogFileStream();
  if (!stream) {
    return;
  }
  stream.write(line + "\n");
}

function writeConsoleLine(stream: NodeJS.WriteStream, line: string): void {
  if (globalConsoleSink?.(line)) {
    return;
  }
  stream.write(line + "\n");
}

export function flushLogger(): Promise<void> {
  const stream = globalLogFileStream;
  if (!stream) {
    return Promise.resolve();
  }
  globalLogFileStream = null;
  return endStream(stream);
}

function endStream(stream: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      stream.off("finish", onFinish);
      stream.off("error", onError);
    };
    const onFinish = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    stream.once("finish", onFinish);
    stream.once("error", onError);
    stream.end();
  });
}

function ensureLogFileStream(): ReturnType<typeof createWriteStream> | null {
  if (!globalLogFilePath) {
    return null;
  }
  if (globalLogFileStream) {
    return globalLogFileStream;
  }

  const dir = path.dirname(globalLogFilePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  globalLogFileStream = createWriteStream(globalLogFilePath, {
    flags: "a",
    encoding: "utf8",
  });
  return globalLogFileStream;
}
