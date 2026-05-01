import net from "node:net";
import path from "node:path";
import { createLogger } from "./logger.js";

const log = createLogger("daemon-control");

type DaemonControlMessage =
  | { type: "put_negative"; path: string }
  | { type: "invalidate_negative_prefix"; prefix: string }
  | { type: "invalidate_cache" };

export interface DaemonControlClientOptions {
  socketPath?: string;
  timeoutMs?: number;
}

export class DaemonControlClient {
  private readonly socketPath: string;
  private readonly timeoutMs: number;

  constructor(options: DaemonControlClientOptions = {}) {
    this.socketPath = options.socketPath ?? resolveDaemonControlSocketPath();
    this.timeoutMs = options.timeoutMs ?? 250;
  }

  async putNegative(path: string): Promise<void> {
    await this.send({ type: "put_negative", path });
  }

  async invalidateNegativePrefix(prefix: string): Promise<void> {
    await this.send({ type: "invalidate_negative_prefix", prefix });
  }

  async invalidateCache(): Promise<void> {
    await this.send({ type: "invalidate_cache" });
  }

  private async send(message: DaemonControlMessage): Promise<void> {
    await new Promise<void>((resolve) => {
      const socket = net.createConnection({ path: this.socketPath });
      let settled = false;
      let timer: NodeJS.Timeout;

      const finish = (error?: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) {
          log.warn("daemon control msg 发送失败 (降级, 不阻塞 RPC)", {
            socketPath: this.socketPath,
            type: message.type,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        resolve();
      };

      timer = setTimeout(() => {
        finish(new Error("daemon control msg timed out"));
      }, this.timeoutMs);

      socket.setEncoding("utf8");
      socket.once("error", finish);
      socket.once("connect", () => {
        socket.write(`${JSON.stringify(message)}\n`, (error) => {
          if (error) {
            finish(error);
          }
        });
      });
      socket.on("data", (chunk) => {
        if (chunk.includes("\n")) {
          finish();
        }
      });
      socket.once("close", () => finish());
    });
  }
}

function resolveDaemonControlSocketPath(): string {
  const explicitSocket = process.env.CERELAY_FUSE_CONTROL_SOCKET?.trim();
  if (explicitSocket) {
    return explicitSocket;
  }
  const dataDir = process.env.CERELAY_DATA_DIR?.trim() || "/var/lib/cerelay";
  return path.join(dataDir, "fuse-control.sock");
}
