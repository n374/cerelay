import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

let proc: ChildProcess | null = null;
let mockPort = 0;
let baseUrl = "";

async function startMock(): Promise<void> {
  proc = spawn("node", ["--import", "tsx", path.join(import.meta.dirname, "index.ts")], {
    env: { ...process.env, PORT: "0" },   // 0 = OS picks free port
    stdio: ["ignore", "pipe", "pipe"],
  });

  // 解析子进程 stdout 第一行 "[mock-anthropic] listening on :NNNNN"，拿到实际端口
  let timeoutHandle: NodeJS.Timeout | undefined;
  const portPromise = new Promise<number>((resolve, reject) => {
    const onData = (chunk: Buffer): void => {
      const m = chunk.toString("utf8").match(/listening on :(\d+)/);
      if (m) {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        proc?.stdout?.off("data", onData);
        resolve(Number.parseInt(m[1], 10));
      }
    };
    proc!.stdout?.on("data", onData);
    proc!.once("exit", (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      reject(new Error(`mock exited prematurely with code ${code}`));
    });
    timeoutHandle = setTimeout(() => reject(new Error("mock 启动 stdout 解析超时")), 5_000);
  });

  mockPort = await portPromise;
  baseUrl = `http://127.0.0.1:${mockPort}`;

  // 进一步握手：实际打 GET /admin/captured 确认能响应
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${baseUrl}/admin/captured`);
      if (r.ok) return;
    } catch {}
    await sleep(50);
  }
  throw new Error(`mock listening on :${mockPort} but /admin/captured not responding`);
}

test.before(startMock);

test.after(async () => {
  if (proc && !proc.killed) {
    proc.kill("SIGTERM");
    await new Promise<void>((r) => proc!.once("exit", () => r()));
  }
});

test("mock-anthropic: turnIndex 匹配 + captured 返回 + reset 清空", async () => {
  await fetch(`${baseUrl}/admin/reset`, { method: "POST" });

  await fetch(`${baseUrl}/admin/scripts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "test-1",
      match: { turnIndex: 1 },
      respond: { type: "stream", events: [{ kind: "message_stop" }] },
    }),
  });

  const r = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "x", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(r.status, 200);
  await r.text();   // 消费 SSE 流

  const cap = await (await fetch(`${baseUrl}/admin/captured`)).json() as Array<{ index: number; matchedScript: string | null }>;
  assert.equal(cap.length, 1);
  assert.equal(cap[0].index, 1);
  assert.equal(cap[0].matchedScript, "test-1");

  await fetch(`${baseUrl}/admin/reset`, { method: "POST" });
  const after = await (await fetch(`${baseUrl}/admin/captured`)).json() as unknown[];
  assert.equal(after.length, 0);
});

test("mock-anthropic: predicate 路径匹配（messages[0].content contains marker）", async () => {
  await fetch(`${baseUrl}/admin/reset`, { method: "POST" });
  await fetch(`${baseUrl}/admin/scripts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "marker-A",
      match: { predicate: { path: "messages[0].content", op: "contains", value: "MARKER-A" } },
      respond: { type: "stream", events: [{ kind: "message_stop" }] },
    }),
  });
  await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "x", messages: [{ role: "user", content: "hello MARKER-A please" }] }),
  }).then((r) => r.text());

  const cap = await (await fetch(`${baseUrl}/admin/captured`)).json() as Array<{ matchedScript: string | null }>;
  assert.equal(cap.at(-1)?.matchedScript, "marker-A");
});
