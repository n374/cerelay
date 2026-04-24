// ============================================================
// Client 设备 ID
//
// 每台运行 Cerelay Client 的物理设备拥有一个稳定的 deviceId，存储在
// ~/.config/cerelay/device-id。Server 侧用 (deviceId, cwd) 作为缓存隔离 key，
// 确保同一台机器跨多个项目目录可以复用 blob，也避免 hostname 变化导致缓存失效。
//
// 首次启动时生成 UUIDv4；之后每次启动从文件读取。
// ============================================================

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const MAX_DEVICE_ID_LENGTH = 128;

export interface DeviceIdOptions {
  /** 默认 ~/.config/cerelay */
  configDir?: string;
}

/**
 * 返回本机持久化的 deviceId。
 *
 * - 文件不存在：生成新 UUIDv4 并写入
 * - 文件损坏（空、非法字符、超长）：覆盖为新 UUIDv4，保证下游协议可安全使用
 * - 文件正常：返回原值
 */
export function getOrCreateDeviceId(options: DeviceIdOptions = {}): string {
  const configDir = options.configDir ?? defaultConfigDir();
  const filePath = path.join(configDir, "device-id");

  const existing = readExisting(filePath);
  if (existing) {
    return existing;
  }

  mkdirSync(configDir, { recursive: true });
  const newId = randomUUID();
  writeFileSync(filePath, newId + "\n", { encoding: "utf8", mode: 0o600 });
  return newId;
}

function readExisting(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf8").trim();
    if (!raw || raw.length > MAX_DEVICE_ID_LENGTH) return null;
    if (!DEVICE_ID_PATTERN.test(raw)) return null;
    return raw;
  } catch {
    return null;
  }
}

function defaultConfigDir(): string {
  return path.join(os.homedir(), ".config", "cerelay");
}
