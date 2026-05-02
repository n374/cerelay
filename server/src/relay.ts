import { createLogger } from "./logger.js";
import type { AdminEventBuffer } from "./admin-events.js";

const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
const log = createLogger("relay");

export interface RemoteToolResult {
  output?: unknown;
  summary?: string;
  error?: string;
}

interface PendingCall {
  toolName: string;
  timer: NodeJS.Timeout;
  /** INF-8：本次 pending 实际生效的超时 ms，emit `tool.timeout.fired` 用 */
  timeoutMs: number;
  resolve: (result: RemoteToolResult) => void;
  reject: (error: Error) => void;
}

export interface ToolRelayOptions {
  /** INF-8：emit `tool.timeout.fired` 时带上的 sessionId（缺省 emit 也带 null）。 */
  sessionId?: string;
  /** INF-8：admin event buffer，未传则不 emit（生产 / 单测无 admin events 时无副作用）。 */
  adminEvents?: AdminEventBuffer;
}

export interface CreatePendingOptions {
  /**
   * INF-8 fault injection 钩子：覆盖默认 120s 超时，让 e2e 能在合理时间内
   * 触发 timeout 路径。仅 e2e (CERELAY_ADMIN_EVENTS=true + test-toggles
   * `injectToolTimeout`) 生效；生产路径不传 = 沿用 DEFAULT_TOOL_TIMEOUT_MS。
   */
  timeoutMsOverride?: number;
}

export class ToolRelay {
  private readonly pending = new Map<string, PendingCall>();
  private readonly opts: ToolRelayOptions;

  constructor(opts: ToolRelayOptions = {}) {
    this.opts = opts;
  }

  createPending(
    requestId: string,
    toolName: string,
    options: CreatePendingOptions = {},
  ): Promise<RemoteToolResult> {
    const timeoutMs = options.timeoutMsOverride ?? DEFAULT_TOOL_TIMEOUT_MS;
    return new Promise<RemoteToolResult>((resolve, reject) => {
      log.debug("创建工具结果等待项", {
        requestId,
        toolName,
        pendingCountBefore: this.pending.size,
        timeoutMs,
        injected: options.timeoutMsOverride !== undefined,
      });

      const timer = setTimeout(() => {
        log.warn("等待工具结果超时", {
          requestId,
          toolName,
          timeoutMs,
        });
        // INF-8：tool relay timeout 触发 → emit `tool.timeout.fired` admin event。
        // detail 含 sessionId / requestId / toolName / timeoutMs / injected
        // (true = 由 test-toggles `injectToolTimeout` 注入的短超时；false = 默认 120s 超时)。
        // G1-tool-timeout case 的主断言用此 event 验证 timeout 路径真触发。
        this.opts.adminEvents?.record(
          "tool.timeout.fired",
          this.opts.sessionId ?? null,
          {
            requestId,
            toolName,
            timeoutMs,
            injected: options.timeoutMsOverride !== undefined,
            pendingCount: this.pending.size,
          },
        );
        this.reject(
          requestId,
          new Error(`等待工具结果超时（requestId=${requestId}, toolName=${toolName}）`)
        );
      }, timeoutMs);

      this.pending.set(requestId, {
        toolName,
        timer,
        timeoutMs,
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  resolve(requestId: string, result: RemoteToolResult): void {
    const pending = this.pending.get(requestId);
    if (!pending) {
      log.debug("收到未知 requestId 的工具结果", { requestId });
      return;
    }

    this.pending.delete(requestId);
    log.debug("工具结果等待项已完成", {
      requestId,
      toolName: pending.toolName,
      pendingCountAfter: this.pending.size,
      hasError: Boolean(result.error),
      hasSummary: Boolean(result.summary),
      outputType: result.output === undefined ? "undefined" : typeof result.output,
    });
    pending.resolve(result);
  }

  reject(requestId: string, error: Error): void {
    const pending = this.pending.get(requestId);
    if (!pending) {
      log.debug("收到未知 requestId 的工具错误", { requestId, error: error.message });
      return;
    }

    this.pending.delete(requestId);
    log.debug("工具结果等待项已拒绝", {
      requestId,
      toolName: pending.toolName,
      pendingCountAfter: this.pending.size,
      error: error.message,
    });
    pending.reject(error);
  }

  cleanup(error = new Error("会话已关闭")): void {
    const entries = Array.from(this.pending.entries());
    log.debug("清理未完成的工具等待项", {
      count: entries.length,
      error: error.message,
    });
    this.pending.clear();

    for (const [, pending] of entries) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  size(): number {
    return this.pending.size;
  }
}
