// ============================================================
// ACP Server 入口
// 通过 `axon-hand acp` 子命令启动 stdio ACP 服务器
// 供编辑器（Zed、VS Code 等）通过 ACP 协议连接
// ============================================================

import process from "node:process";
import { AcpServer } from "./server.js";

export interface AcpCommandOptions {
  /** Axon Brain WebSocket 地址 */
  server: string;
  /** 默认工作目录 */
  cwd: string;
}

export async function runAcpServer(options: AcpCommandOptions): Promise<void> {
  const serverURL = `ws://${options.server}/ws`;
  const acpServer = new AcpServer({
    serverURL,
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
