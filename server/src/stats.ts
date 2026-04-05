// ============================================================
// 统计收集模块
// 跟踪：session 数量、工具调用次数、连接数、消息量
// 设计为纯内存计数器，供管理后台 /admin/stats 接口消费
// ============================================================

export interface StatsSnapshot {
  /** Server 启动时间 */
  startedAt: string;
  /** 当前在线 Hand 数 */
  handsOnline: number;
  /** 历史总连接数 */
  totalConnections: number;
  /** 当前活跃 Session 数 */
  sessionsActive: number;
  /** 历史总 Session 数 */
  sessionsTotal: number;
  /** 已完成 Session 数 */
  sessionsCompleted: number;
  /** 工具调用总次数 */
  toolCallsTotal: number;
  /** 各工具调用次数 */
  toolCallsByName: Record<string, number>;
  /** 错误总次数 */
  errorsTotal: number;
  /** 处理的消息总数 */
  messagesTotal: number;
}

export class StatsCollector {
  private readonly startedAt = new Date();

  private handsOnline = 0;
  private totalConnections = 0;
  private sessionsActive = 0;
  private sessionsTotal = 0;
  private sessionsCompleted = 0;
  private toolCallsTotal = 0;
  private toolCallsByName: Record<string, number> = {};
  private errorsTotal = 0;
  private messagesTotal = 0;

  // ---- Hand 连接事件 ----

  onHandConnected(): void {
    this.handsOnline++;
    this.totalConnections++;
  }

  onHandDisconnected(): void {
    if (this.handsOnline > 0) {
      this.handsOnline--;
    }
  }

  // ---- Session 事件 ----

  onSessionCreated(): void {
    this.sessionsActive++;
    this.sessionsTotal++;
  }

  onSessionEnded(): void {
    if (this.sessionsActive > 0) {
      this.sessionsActive--;
    }
    this.sessionsCompleted++;
  }

  // ---- 工具调用事件 ----

  onToolCall(toolName: string): void {
    this.toolCallsTotal++;
    this.toolCallsByName[toolName] = (this.toolCallsByName[toolName] ?? 0) + 1;
  }

  // ---- 消息事件 ----

  onMessageReceived(): void {
    this.messagesTotal++;
  }

  // ---- 错误事件 ----

  onError(): void {
    this.errorsTotal++;
  }

  // ---- 快照 ----

  snapshot(handsOnline?: number): StatsSnapshot {
    return {
      startedAt: this.startedAt.toISOString(),
      handsOnline: handsOnline ?? this.handsOnline,
      totalConnections: this.totalConnections,
      sessionsActive: this.sessionsActive,
      sessionsTotal: this.sessionsTotal,
      sessionsCompleted: this.sessionsCompleted,
      toolCallsTotal: this.toolCallsTotal,
      toolCallsByName: { ...this.toolCallsByName },
      errorsTotal: this.errorsTotal,
      messagesTotal: this.messagesTotal,
    };
  }
}
