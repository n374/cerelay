import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";

// FIXTURE_ROOT 是一个 docker volume，挂在 orchestrator + 所有 client 容器的同一路径。
// 测试在 orchestrator 写，client 在自己的容器内同路径读。
const FIXTURE_ROOT = process.env.FIXTURE_ROOT || "/workspace/fixtures";

export async function writeFixture(
  caseId: string,
  files: Record<string, string>
): Promise<string> {
  const root = path.join(FIXTURE_ROOT, caseId);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  return root;
}

export function fixturePath(caseId: string, sub = ""): string {
  return path.join(FIXTURE_ROOT, caseId, sub);
}

export async function cleanupFixture(caseId: string): Promise<void> {
  await rm(path.join(FIXTURE_ROOT, caseId), { recursive: true, force: true });
}
