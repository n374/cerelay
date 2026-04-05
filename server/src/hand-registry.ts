// ============================================================
// Hand 注册表：Multi-Hand 连接管理
// 策略：
//   - 每个 Hand 连接有唯一 handId
//   - Session 与创建它的 Hand 绑定（Session Affinity）
//   - 发送消息时路由到对应 Hand；若 Hand 断线则报错
// ============================================================

import WebSocket from "ws";

export interface HandInfo {
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
}

export class HandRegistry {
  private readonly hands = new Map<string, HandInfo>();

  /** 注册一个新的 Hand 连接 */
  register(id: string, socket: WebSocket, tokenId: string, remoteAddress: string): HandInfo {
    const info: HandInfo = {
      id,
      connectedAt: new Date(),
      sessionIds: new Set(),
      tokenId,
      remoteAddress,
      socket,
    };
    this.hands.set(id, info);
    return info;
  }

  /** 移除 Hand 连接 */
  unregister(handId: string): void {
    this.hands.delete(handId);
  }

  /** 根据 handId 获取 HandInfo */
  get(handId: string): HandInfo | undefined {
    return this.hands.get(handId);
  }

  /** 获取所有在线 Hand */
  all(): HandInfo[] {
    return Array.from(this.hands.values());
  }

  /** 将 session 绑定到 hand */
  bindSession(handId: string, sessionId: string): void {
    const hand = this.hands.get(handId);
    if (hand) {
      hand.sessionIds.add(sessionId);
    }
  }

  /** 解绑 session */
  unbindSession(handId: string, sessionId: string): void {
    const hand = this.hands.get(handId);
    if (hand) {
      hand.sessionIds.delete(sessionId);
    }
  }

  /** 在线数量 */
  count(): number {
    return this.hands.size;
  }

  /**
   * 向指定 hand 发送消息
   * 如果 hand 不存在或已断开，抛出错误
   */
  async sendTo(handId: string, message: unknown): Promise<void> {
    const hand = this.hands.get(handId);
    if (!hand) {
      throw new Error(`Hand 不存在或已断开: ${handId}`);
    }

    if (hand.socket.readyState !== WebSocket.OPEN) {
      throw new Error(`Hand 连接已关闭: ${handId}`);
    }

    await new Promise<void>((resolve, reject) => {
      hand.socket.send(JSON.stringify(message), (error) => {
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
    return Array.from(this.hands.values()).map((h) => ({
      id: h.id,
      connectedAt: h.connectedAt.toISOString(),
      sessionCount: h.sessionIds.size,
      tokenId: h.tokenId,
      remoteAddress: h.remoteAddress,
    }));
  }
}
