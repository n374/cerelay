// ============================================================
// Client 注册表：Multi-Client 连接管理
// 策略：
//   - 每个 Client 连接有唯一 clientId
//   - Session 与创建它的 Client 绑定（Session Affinity）
//   - 发送消息时路由到对应 Client；若 Client 断线则报错
// ============================================================

import WebSocket from "ws";
import type { ClientHello } from "./protocol.js";

function makeCacheKey(deviceId: string, cwd: string): string {
  return `${deviceId}\0${cwd}`;
}

export interface ClientInfo {
  /** 唯一 ID */
  id: string;
  /** 连接建立时间 */
  connectedAt: Date;
  /** 关联的 session ID 集合 */
  sessionIds: Set<string>;
  /** 认证 token ID（noauth 表示未启用认证）*/
  tokenId: string;
  /** 远端地址（用于展示）*/
  remoteAddress: string;
  /** WebSocket 连接 */
  socket: WebSocket;
  /** Client 上报的设备 ID */
  deviceId?: string;
  /** Client 上报的 cwd */
  cwd?: string;
  /** Client 上报的 cache 能力 */
  cacheCapabilities?: ClientHello["capabilities"];
  /** 最近一次 cache task heartbeat 时间 */
  lastHeartbeatAt?: Date;
}

export class ClientRegistry {
  private readonly clients = new Map<string, ClientInfo>();
  private readonly clientsByCacheKey = new Map<string, Set<string>>();

  /** 注册一个新的 Client 连接 */
  register(id: string, socket: WebSocket, tokenId: string, remoteAddress: string): ClientInfo {
    const info: ClientInfo = {
      id,
      connectedAt: new Date(),
      sessionIds: new Set(),
      tokenId,
      remoteAddress,
      socket,
    };
    this.clients.set(id, info);
    return info;
  }

  /** 移除 Client 连接 */
  unregister(clientId: string): void {
    this.detachCacheKey(clientId);
    this.clients.delete(clientId);
  }

  /** 根据 clientId 获取 ClientInfo */
  get(clientId: string): ClientInfo | undefined {
    return this.clients.get(clientId);
  }

  /** 获取所有在线 Client */
  all(): ClientInfo[] {
    return Array.from(this.clients.values());
  }

  /** 将 session 绑定到 client */
  bindSession(clientId: string, sessionId: string): void {
    const client = this.clients.get(clientId);
    if (client) {
      client.sessionIds.add(sessionId);
    }
  }

  /** 解绑 session */
  unbindSession(clientId: string, sessionId: string): void {
    const client = this.clients.get(clientId);
    if (client) {
      client.sessionIds.delete(sessionId);
    }
  }

  /** 在线数量 */
  count(): number {
    return this.clients.size;
  }

  attachHello(clientId: string, hello: ClientHello): void {
    const client = this.clients.get(clientId);
    if (!client) {
      return;
    }

    this.detachCacheKey(clientId);
    client.deviceId = hello.deviceId;
    client.cwd = hello.cwd;
    client.cacheCapabilities = hello.capabilities;

    const cacheKey = this.cacheKeyOf(clientId);
    if (!cacheKey) {
      return;
    }
    const clientIds = this.clientsByCacheKey.get(cacheKey) ?? new Set<string>();
    clientIds.add(clientId);
    this.clientsByCacheKey.set(cacheKey, clientIds);
  }

  cacheKeyOf(clientId: string): string | undefined {
    const client = this.clients.get(clientId);
    if (!client?.deviceId || !client.cwd) {
      return undefined;
    }
    return makeCacheKey(client.deviceId, client.cwd);
  }

  cacheKeysOf(clientId: string): string[] {
    const key = this.cacheKeyOf(clientId);
    return key ? [key] : [];
  }

  listClientsByCacheKey(cacheKey: string): ClientInfo[] {
    const clientIds = this.clientsByCacheKey.get(cacheKey);
    if (!clientIds) {
      return [];
    }
    return Array.from(clientIds)
      .map((clientId) => this.clients.get(clientId))
      .filter((client): client is ClientInfo => Boolean(client));
  }

  setLastHeartbeat(clientId: string, at = new Date()): void {
    const client = this.clients.get(clientId);
    if (client) {
      client.lastHeartbeatAt = at;
    }
  }

  /**
   * 向指定 client 发送消息
   * 如果 client 不存在或已断开，抛出错误
   */
  async sendTo(clientId: string, message: unknown): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client) {
      throw new Error(`Client 不存在或已断开: ${clientId}`);
    }

    if (client.socket.readyState !== WebSocket.OPEN) {
      throw new Error(`Client 连接已关闭: ${clientId}`);
    }

    await new Promise<void>((resolve, reject) => {
      client.socket.send(JSON.stringify(message), (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  /** 统计信息（用于管理后台） */
  stats(): Array<{
    id: string;
    connectedAt: string;
    sessionCount: number;
    tokenId: string;
    remoteAddress: string;
  }> {
    return Array.from(this.clients.values()).map((h) => ({
      id: h.id,
      connectedAt: h.connectedAt.toISOString(),
      sessionCount: h.sessionIds.size,
      tokenId: h.tokenId,
      remoteAddress: h.remoteAddress,
    }));
  }

  private detachCacheKey(clientId: string): void {
    const cacheKey = this.cacheKeyOf(clientId);
    if (!cacheKey) {
      return;
    }
    const clientIds = this.clientsByCacheKey.get(cacheKey);
    if (!clientIds) {
      return;
    }
    clientIds.delete(clientId);
    if (clientIds.size === 0) {
      this.clientsByCacheKey.delete(cacheKey);
    }
  }
}
