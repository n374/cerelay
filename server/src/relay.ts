const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

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
      const timer = setTimeout(() => {
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
      return;
    }

    this.pending.delete(requestId);
    pending.resolve(result);
  }

  reject(requestId: string, error: Error): void {
    const pending = this.pending.get(requestId);
    if (!pending) {
      return;
    }

    this.pending.delete(requestId);
    pending.reject(error);
  }

  cleanup(error = new Error("会话已关闭")): void {
    const entries = Array.from(this.pending.entries());
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
