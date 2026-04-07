import { createLogger } from "./logger.js";

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
  resolve: (result: RemoteToolResult) => void;
  reject: (error: Error) => void;
}

export class ToolRelay {
  private readonly pending = new Map<string, PendingCall>();

  createPending(requestId: string, toolName: string): Promise<RemoteToolResult> {
    return new Promise<RemoteToolResult>((resolve, reject) => {
      log.debug("创建工具结果等待项", {
        requestId,
        toolName,
        pendingCountBefore: this.pending.size,
      });

      const timer = setTimeout(() => {
        log.warn("等待工具结果超时", {
          requestId,
          toolName,
          timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
        });
        this.reject(
          requestId,
          new Error(`等待工具结果超时（requestId=${requestId}, toolName=${toolName}）`)
        );
      }, DEFAULT_TOOL_TIMEOUT_MS);

      this.pending.set(requestId, {
        toolName,
        timer,
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
