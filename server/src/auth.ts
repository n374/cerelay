// ============================================================
// 认证模块：Token 生命周期管理
// 策略：Bearer Token，存储在内存（生产可换 Redis/DB）
// 设计：
//   - Token 由 Server 启动时或管理 API 生成
//   - Hand/Web 连接时在 Upgrade 请求头中携带 token
//   - 支持 token 过期、吊销
// ============================================================

import {
  createHash,
  randomBytes,
  timingSafeEqual as nodeTimingSafeEqual,
} from "node:crypto";

export interface TokenRecord {
  /** token 的哈希值（存储哈希，原始 token 不持久化）*/
  hash: string;
  /** 显示名称，便于管理员识别 */
  label: string;
  /** 创建时间 */
  createdAt: Date;
  /** 过期时间（null 表示永不过期）*/
  expiresAt: Date | null;
  /** 最后使用时间 */
  lastUsedAt: Date | null;
  /** 是否已吊销 */
  revoked: boolean;
}

// ============================================================
// TokenStore：Token 存储与校验
// ============================================================

export class TokenStore {
  // key：token ID（token 的前缀，用于 O(1) 查找），value：记录
  private readonly tokens = new Map<string, TokenRecord>();

  // 是否启用认证（false 则跳过所有认证检查）
  private readonly enabled: boolean;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  /** 认证是否开启 */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * 生成新 token
   * 格式：cerelay_<随机32字节hex>
   * 返回原始 token（仅此一次，之后只存哈希）
   */
  create(label: string, ttlSeconds?: number): { tokenId: string; token: string } {
    const raw = `cerelay_${randomBytes(32).toString("hex")}`;
    return this.storeToken(raw, label, ttlSeconds);
  }

  createFixed(label: string, rawToken: string, ttlSeconds?: number): { tokenId: string; token: string } {
    if (!rawToken.startsWith("cerelay_")) {
      throw new Error("Token 必须以 cerelay_ 开头");
    }

    return this.storeToken(rawToken, label, ttlSeconds);
  }

  private storeToken(raw: string, label: string, ttlSeconds?: number): { tokenId: string; token: string } {
    const tokenId = raw.substring(0, 16); // 前16字符作为 ID
    const hash = this.hashToken(raw);

    const record: TokenRecord = {
      hash,
      label,
      createdAt: new Date(),
      expiresAt: ttlSeconds ? new Date(Date.now() + ttlSeconds * 1000) : null,
      lastUsedAt: null,
      revoked: false,
    };

    this.tokens.set(tokenId, record);
    return { tokenId, token: raw };
  }

  /**
   * 校验 token
   * 返回 null 表示无效，否则返回对应的 tokenId
   */
  verify(rawToken: string): string | null {
    if (!rawToken || !rawToken.startsWith("cerelay_")) {
      return null;
    }

    const tokenId = rawToken.substring(0, 16);
    const record = this.tokens.get(tokenId);

    if (!record) {
      return null;
    }

    if (record.revoked) {
      return null;
    }

    if (record.expiresAt && record.expiresAt < new Date()) {
      return null;
    }

    // 时间常数比较，防止时序攻击
    const expectedHash = this.hashToken(rawToken);
    if (!timingSafeEqual(record.hash, expectedHash)) {
      return null;
    }

    // 更新最后使用时间
    record.lastUsedAt = new Date();
    return tokenId;
  }

  /** 吊销 token */
  revoke(tokenId: string): boolean {
    const record = this.tokens.get(tokenId);
    if (!record) {
      return false;
    }
    record.revoked = true;
    return true;
  }

  /** 列出所有 token（不包含哈希值） */
  list(): Array<{ tokenId: string } & Omit<TokenRecord, "hash">> {
    return Array.from(this.tokens.entries()).map(([tokenId, record]) => ({
      tokenId,
      label: record.label,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      lastUsedAt: record.lastUsedAt,
      revoked: record.revoked,
    }));
  }

  /** 删除已过期和已吊销的 token（GC）*/
  cleanup(): number {
    const now = new Date();
    let removed = 0;

    for (const [tokenId, record] of this.tokens.entries()) {
      if (record.revoked || (record.expiresAt && record.expiresAt < now)) {
        this.tokens.delete(tokenId);
        removed++;
      }
    }

    return removed;
  }

  private hashToken(raw: string): string {
    return createHash("sha256").update(raw).digest("hex");
  }
}

// 时序安全的字符串比较（防 timing attack）
function timingSafeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return nodeTimingSafeEqual(left, right);
}

/**
 * 从 HTTP 请求头中提取 Bearer token
 * Authorization: Bearer <token>
 */
export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) {
    return null;
  }

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") {
    return null;
  }

  return parts[1] ?? null;
}

/**
 * 从 WebSocket 升级请求的 URL query string 中提取 token
 * ?token=<token>
 */
export function extractQueryToken(requestUrl: string | undefined): string | null {
  if (!requestUrl) {
    return null;
  }

  try {
    const url = new URL(requestUrl, "http://localhost");
    return url.searchParams.get("token");
  } catch {
    return null;
  }
}
