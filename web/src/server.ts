// ============================================================
// Cerelay Web Server
// 1. 静态文件服务：提供 Web UI（public/ 目录）
// 2. WebSocket 代理：浏览器 ↔ Web Server ↔ Server
//    浏览器不直接连 Server，所有 WS 流量通过本地 Web Server 中转
//    （未来可在此层加认证/TLS终止）
// ============================================================

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import type { Socket } from "node:net";
import WebSocket, { WebSocketServer } from "ws";

// 静态文件的 MIME 类型映射
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

interface WebServerOptions {
  port: number;
  /** Cerelay Server 地址，例如 localhost:8765 */
  serverAddress: string;
}

export class WebServer {
  private readonly port: number;
  private readonly serverAddress: string;
  private readonly publicDir: string;
  private readonly publicDirPrefix: string;

  // HTTP 服务器（提供静态文件）
  private readonly httpServer = createServer(this.handleHttpRequest.bind(this));
  // WebSocket 服务器（接受浏览器连接）
  private readonly wsServer = new WebSocketServer({ noServer: true });

  private shuttingDown = false;

  constructor(options: WebServerOptions) {
    this.port = options.port;
    this.serverAddress = options.serverAddress;

    // 静态文件目录：同级的 public/（开发时），或编译产物的 ../public/（生产时）
    const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
    // 开发时：src/../public → web/public
    // 生产时：dist/../public → web/public
    this.publicDir = path.resolve(__dirname, "..", "public");
    this.publicDirPrefix = `${this.publicDir}${path.sep}`;

    this.httpServer.on("upgrade", this.handleUpgrade.bind(this));
    this.wsServer.on("connection", (socket, req) => {
      void this.handleBrowserConnection(socket, req);
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.httpServer.once("error", reject);
      this.httpServer.listen(this.port, () => {
        this.httpServer.off("error", reject);
        resolve();
      });
    });
  }

  getListenPort(): number {
    const address = this.httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("服务器尚未监听端口");
    }
    return address.port;
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    this.shuttingDown = true;

    // 关闭所有 WebSocket 连接
    for (const client of this.wsServer.clients) {
      client.close();
    }

    await new Promise<void>((resolve) => {
      this.wsServer.close(() => resolve());
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  // ============================================================
  // HTTP 请求处理（静态文件服务）
  // ============================================================

  private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    // 健康检查端点
    if (req.url === "/health") {
      this.writeHead(res, 200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ status: "ok", time: new Date().toISOString() }));
      return;
    }

    let pathname = "/";
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    } catch {
      this.writeHead(res, 400, { "content-type": "text/plain; charset=utf-8" });
      res.end("Bad Request");
      return;
    }

    const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const resolved = path.resolve(this.publicDir, relativePath);
    if (resolved !== this.publicDir && !resolved.startsWith(this.publicDirPrefix)) {
      this.writeHead(res, 403, { "content-type": "text/plain; charset=utf-8" });
      res.end("Forbidden");
      return;
    }

    fs.stat(resolved, (err, stats) => {
      if (err || !stats.isFile()) {
        // SPA fallback：所有未找到的路径都返回 index.html
        const indexPath = path.join(this.publicDir, "index.html");
        this.serveFile(indexPath, res);
        return;
      }
      this.serveFile(resolved, res);
    });
  }

  private serveFile(filePath: string, res: ServerResponse): void {
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

    fs.readFile(filePath, (err, data) => {
      if (err) {
        this.writeHead(res, 500, { "content-type": "text/plain; charset=utf-8" });
        res.end("Internal Server Error");
        return;
      }
      this.writeHead(res, 200, { "content-type": contentType });
      res.end(data);
    });
  }

  // ============================================================
  // WebSocket 升级处理
  // ============================================================

  private handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
    if (request.url !== "/ws") {
      socket.destroy();
      return;
    }

    this.wsServer.handleUpgrade(request, socket, head, (ws) => {
      this.wsServer.emit("connection", ws, request);
    });
  }

  // ============================================================
  // 浏览器 ↔ Server 代理
  // 每个浏览器 WS 连接都建立一个到 Server 的 WS 连接
  // ============================================================

  private async handleBrowserConnection(browserSocket: WebSocket, _req: IncomingMessage): Promise<void> {
    const serverURL = `ws://${this.serverAddress}/ws`;
    const pendingBrowserMessages: Array<{ data: WebSocket.RawData; isBinary: boolean }> = [];

    // 建立到 Server 的连接
    const serverSocket = new WebSocket(serverURL);

    // 双向代理：浏览器 → Server
    browserSocket.on("message", (data, isBinary) => {
      if (serverSocket.readyState === WebSocket.OPEN) {
        serverSocket.send(data, { binary: isBinary });
        return;
      }

      if (serverSocket.readyState === WebSocket.CONNECTING) {
        pendingBrowserMessages.push({ data, isBinary });
      }
    });

    await new Promise<void>((resolve, reject) => {
      serverSocket.once("open", resolve);
      serverSocket.once("error", reject);
    }).catch((err: Error) => {
      console.error(`[cerelay-web] 连接 Server 失败: ${err.message}`);
      browserSocket.close(1011, "Server unavailable");
    });

    if (serverSocket.readyState !== WebSocket.OPEN) {
      return;
    }

    for (const pending of pendingBrowserMessages) {
      serverSocket.send(pending.data, { binary: pending.isBinary });
    }
    pendingBrowserMessages.length = 0;

    // 双向代理：Server → 浏览器
    serverSocket.on("message", (data, isBinary) => {
      if (browserSocket.readyState === WebSocket.OPEN) {
        browserSocket.send(data, { binary: isBinary });
      }
    });

    // 任一侧断开时，关闭另一侧
    browserSocket.on("close", () => {
      if (serverSocket.readyState === WebSocket.OPEN || serverSocket.readyState === WebSocket.CONNECTING) {
        serverSocket.close();
      }
    });

    serverSocket.on("close", () => {
      if (browserSocket.readyState === WebSocket.OPEN) {
        browserSocket.close();
      }
    });

    // 错误处理
    browserSocket.on("error", (err) => {
      console.error("[cerelay-web] 浏览器 WS 错误:", err);
      serverSocket.close();
    });

    serverSocket.on("error", (err) => {
      console.error("[cerelay-web] Server WS 错误:", err);
      browserSocket.close();
    });
  }

  private writeHead(res: ServerResponse, status: number, headers: Record<string, string>): void {
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      ...headers,
    });
  }
}
