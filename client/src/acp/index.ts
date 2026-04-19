// ============================================================
// ACP Server 入口
// 通过 `cerelay acp` 子命令启动 stdio ACP 服务器
// 供编辑器（Zed、VS Code 等）通过 ACP 协议连接
// ============================================================

import process from "node:process";
import { AcpServer } from "./server.js";

export interface AcpCommandOptions {
  /** 完整的 WebSocket URL（含 key query string） */
  serverURL: string;
  /** 默认工作目录 */
  cwd: string;
}

export async function runAcpServer(options: AcpCommandOptions): Promise<void> {
  const acpServer = new AcpServer({
    serverURL: options.serverURL,
    cwd: options.cwd,
  });

  // 捕获进程信号，优雅退出
  const shutdown = async (): Promise<void> => {
    await acpServer.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });

  acpServer.start();
}
