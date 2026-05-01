import type { Writable } from "node:stream";
import { createLogger } from "./logger.js";

const log = createLogger("daemon-control");

/**
 * 发给 FUSE daemon 的 control message。
 *
 * 协议设计 (spec §7.3.4): line-delimited JSON, fire-and-forget。
 * 通过 spawn 子进程时注入的 extra fd (默认 fd=3, daemon 端 CERELAY_FUSE_CONTROL_FD)
 * 由 server 单向写入; daemon 不写回 response。
 */
type DaemonControlMessage =
  | { type: "put_negative"; path: string }
  | { type: "invalidate_negative_prefix"; path: string }
  | { type: "invalidate_cache"; path: string }
  | { type: "shutdown" };

/**
 * 向 FUSE daemon 推送 fire-and-forget control 消息。
 *
 * - 失败时降级 warn log, 不抛 - 不阻塞 RPC 主路径
 * - 不等 response - daemon 不写回 (协议设计)
 */
export class DaemonControlClient {
  constructor(private readonly stream: Writable) {}

  async putNegative(path: string): Promise<void> {
    return this.send({ type: "put_negative", path });
  }

  async invalidateNegativePrefix(path: string): Promise<void> {
    return this.send({ type: "invalidate_negative_prefix", path });
  }

  async invalidateCache(path: string): Promise<void> {
    return this.send({ type: "invalidate_cache", path });
  }

  async shutdown(): Promise<void> {
    return this.send({ type: "shutdown" });
  }

  private async send(msg: DaemonControlMessage): Promise<void> {
    try {
      const line = JSON.stringify(msg) + "\n";
      const ok = this.stream.write(line);
      if (!ok) {
        // backpressure: 等 drain 再返回
        await new Promise<void>((resolve) => this.stream.once("drain", resolve));
      }
    } catch (err) {
      log.warn("daemon control msg 发送失败 (降级, 不阻塞 RPC)", {
        type: msg.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
