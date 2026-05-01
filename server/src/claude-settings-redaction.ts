import type { CacheScope } from "./protocol.js";

/**
 * 删除 ~/.claude/settings.json 中的登录态字段，并用尾部空格补齐到原 size。
 *
 * 删除范围：
 *   - obj.env.ANTHROPIC_BASE_URL
 *   - obj.env.ANTHROPIC_API_KEY
 *   - obj.env.ANTHROPIC_AUTH_TOKEN
 *   - obj.apiKeyHelper
 *
 * 设计要点：
 *   - 非法 JSON：原样返回（CC 自己也读不了非法 JSON，影响零）
 *   - 原文无登录态字段：byte-equal 返回，避免重新序列化引入字段顺序/缩进漂移
 *   - 命中：JSON.stringify minify + trailing whitespace 补齐 size，让 stat 路径无需改动
 *
 * 详见 docs/superpowers/specs/2026-04-30-shadow-claude-settings-login-state-design.md
 *
 * 未尽事项（不在本次范围）：
 *   ~/.claude.json 也可能含 apiKeyHelper / oauthAccount 等登录态字段，
 *   本函数只负责 ~/.claude/settings.json，不处理 ~/.claude.json。
 *   后续若发现 .claude.json 路径也有泄漏再扩展。
 */
export function redactClaudeSettingsLoginState(buf: Buffer): Buffer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf.toString("utf8"));
  } catch {
    return buf;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return buf;
  }
  const obj = parsed as Record<string, unknown>;

  const env = obj.env;
  const envIsObject = !!env && typeof env === "object" && !Array.isArray(env);
  const envObj = envIsObject ? (env as Record<string, unknown>) : null;

  const hasField =
    (envObj !== null && (
      "ANTHROPIC_BASE_URL" in envObj ||
      "ANTHROPIC_API_KEY" in envObj ||
      "ANTHROPIC_AUTH_TOKEN" in envObj
    )) ||
    "apiKeyHelper" in obj;

  if (!hasField) return buf;

  if (envObj !== null) {
    delete envObj.ANTHROPIC_BASE_URL;
    delete envObj.ANTHROPIC_API_KEY;
    delete envObj.ANTHROPIC_AUTH_TOKEN;
  }
  delete obj.apiKeyHelper;

  const minified = Buffer.from(JSON.stringify(obj), "utf8");
  const diff = buf.byteLength - minified.byteLength;
  if (diff <= 0) return minified;
  return Buffer.concat([minified, Buffer.alloc(diff, 0x20)]);
}

/** 仅判断 scope+relPath 是否需要过滤。 */
export function isClaudeHomeSettingsJson(
  scope: CacheScope,
  relPath: string,
): boolean {
  return scope === "claude-home" && relPath === "settings.json";
}
