// FileAgent in-flight 去重 Map（plan §3.4）。
//
// 问题：同 path 多个 read miss 同时发生时，如果各自独立穿透 client，会重复发起多次
// client 端 stat/read，浪费带宽 + 给 client 添堵。
//
// 解决：以 (op + absPath) 为 key 共享单次穿透。后续到达的并发调用直接 await 同一 promise。
//
// 失败处理：promise reject 时所有等待方都拿到同一错误；下次重试不复用错误结果（map 立即清除）。

export class InflightMap {
  private readonly map = new Map<string, Promise<unknown>>();

  /**
   * 以 key 为单位 dedupe：第一次调用执行 run()；并发到达的同 key 调用复用同一 promise。
   * run() 完成（resolve / reject）后立即从 map 移除——下次同 key 重试新执行。
   */
  dedupe<T>(key: string, run: () => Promise<T>): Promise<T> {
    const existing = this.map.get(key);
    if (existing) return existing as Promise<T>;

    const fresh = run().finally(() => {
      // 用 strict equality 防御：万一同 key 被串行重新填入新 promise，不要误删新的
      if (this.map.get(key) === fresh) {
        this.map.delete(key);
      }
    });
    this.map.set(key, fresh);
    return fresh;
  }

  /** 当前是否有 in-flight 的 op（GC 时跳过有 in-flight 的 path 用）。 */
  has(key: string): boolean {
    return this.map.has(key);
  }

  /** 当前 in-flight 项数，仅供 telemetry / 测试。 */
  size(): number {
    return this.map.size;
  }

  /** 取所有 in-flight key 的快照（GC 时按 absPath 跳过用）。 */
  keys(): string[] {
    return Array.from(this.map.keys());
  }
}

/** 把 op + absPath 拼成 inflight key（保持稳定字符串格式，方便测试断言）。 */
export function inflightKey(
  op: "read" | "stat" | "readdir" | "fetch",
  absPath: string,
): string {
  return `${op}:${absPath}`;
}
