// ============================================================
// 结构化日志模块
// 格式：JSON Lines（生产用），或人类友好格式（开发用）
// 使用方式：
//   const log = createLogger("component");
//   log.info("消息", { key: "value" });
// ============================================================

export type LogLevel = "debug" | "info" | "warn" | "error";

type LogFields = Record<string, unknown>;

interface LogEntry {
  time: string;
  level: LogLevel;
  component: string;
  message: string;
  [key: string]: unknown;
}

// 日志级别数值（用于过滤）
const LEVEL_VALUES: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// ============================================================
// Logger 类
// ============================================================

export class Logger {
  private readonly component: string;
  private readonly minLevel: LogLevel;
  private readonly jsonMode: boolean;

  constructor(component: string, minLevel: LogLevel = "info", jsonMode = false) {
    this.component = component;
    this.minLevel = minLevel;
    this.jsonMode = jsonMode;
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

  /** 创建带有额外固定字段的子 Logger */
  child(fields: LogFields): Logger {
    return new ChildLogger(this.component, this.minLevel, this.jsonMode, fields);
  }

  protected log(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_VALUES[level] < LEVEL_VALUES[this.minLevel]) {
      return;
    }

    const entry: LogEntry = {
      time: new Date().toISOString(),
      level,
      component: this.component,
      message,
      ...fields,
    };

    if (this.jsonMode) {
      const output = level === "error" ? process.stderr : process.stdout;
      output.write(JSON.stringify(entry) + "\n");
    } else {
      this.prettyPrint(entry);
    }
  }

  private prettyPrint(entry: LogEntry): void {
    const color = {
      debug: "\x1b[90m",
      info: "\x1b[36m",
      warn: "\x1b[33m",
      error: "\x1b[31m",
    }[entry.level];
    const reset = "\x1b[0m";
    const bold = "\x1b[1m";
    const dim = "\x1b[2m";

    const extras = Object.entries(entry)
      .filter(([k]) => !["time", "level", "component", "message"].includes(k))
      .map(([k, v]) => `${dim}${k}=${JSON.stringify(v)}${reset}`)
      .join(" ");

    const line = [
      `${dim}${entry.time.substring(11, 23)}${reset}`,
      `${color}${bold}${entry.level.toUpperCase().padEnd(5)}${reset}`,
      `${dim}[${entry.component}]${reset}`,
      entry.message,
      extras,
    ]
      .filter(Boolean)
      .join(" ");

    if (entry.level === "error") {
      process.stderr.write(line + "\n");
    } else {
      process.stdout.write(line + "\n");
    }
  }
}

// 子 Logger（携带固定字段）
class ChildLogger extends Logger {
  private readonly fixedFields: LogFields;

  constructor(component: string, minLevel: LogLevel, jsonMode: boolean, fixedFields: LogFields) {
    super(component, minLevel, jsonMode);
    this.fixedFields = fixedFields;
  }

  protected override log(level: LogLevel, message: string, fields?: LogFields): void {
    super.log(level, message, { ...this.fixedFields, ...fields });
  }
}

// ============================================================
// 全局 Logger 工厂
// ============================================================

let globalMinLevel: LogLevel = "info";
let globalJsonMode = false;

export function configureLogger(options: { minLevel?: LogLevel; json?: boolean }): void {
  if (options.minLevel) {
    globalMinLevel = options.minLevel;
  }
  if (options.json !== undefined) {
    globalJsonMode = options.json;
  }
}

export function createLogger(component: string): Logger {
  return new Logger(component, globalMinLevel, globalJsonMode);
}
