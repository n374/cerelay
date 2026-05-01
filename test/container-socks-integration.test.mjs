import test from "node:test";
import assert from "node:assert/strict";
import { lookup } from "node:dns/promises";
import WebSocket from "ws";

const RUN_CONTAINER_SOCKS_TESTS = process.env.CERELAY_RUN_CONTAINER_SOCKS_TESTS === "true";

const CERELAY_BASE_URL = process.env.CERELAY_SOCKS_TEST_BASE_URL || "http://cerelay-socks-test:8765";
const CERELAY_WS_URL = process.env.CERELAY_SOCKS_TEST_WS_URL || "ws://cerelay-socks-test:8765/ws";
const MOCK_SOCKS_ADMIN_URL = process.env.MOCK_SOCKS_ADMIN_URL || "http://mock-socks:18080";
const MOCK_DNS_HOST = process.env.MOCK_DNS_HOST || "mock-dns";
const EGRESS_PROBE_HOST = process.env.EGRESS_PROBE_HOST || "egress-probe";
const MOCK_DNS_A_RECORD = process.env.MOCK_DNS_A_RECORD || "203.0.113.10";

const testIfEnabled = RUN_CONTAINER_SOCKS_TESTS ? test : test.skip;

testIfEnabled("container SOCKS PTY egress is routed through upstream SOCKS5", async () => {
  await waitForService(`${CERELAY_BASE_URL}/health`);
  await postJson(`${MOCK_SOCKS_ADMIN_URL}/reset`);

  const result = await runPtySession();
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /pong from egress-probe/);

  const stats = await fetchJson(`${MOCK_SOCKS_ADMIN_URL}/stats`);
  const expectedHosts = new Set([EGRESS_PROBE_HOST, MOCK_DNS_A_RECORD]);
  assert.ok(
    stats.connects.some((entry) => expectedHosts.has(entry.host) && entry.port === 8080),
    `expected CONNECT to one of ${JSON.stringify([...expectedHosts])}:8080, got ${JSON.stringify(stats)}`
  );
});

testIfEnabled("container SOCKS UDP=block still resolves DNS via TCP", async () => {
  await waitForService(`${CERELAY_BASE_URL}/health`);
  await postJson(`${MOCK_SOCKS_ADMIN_URL}/reset`);

  const result = await runPtySession();
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /pong from egress-probe/);

  const stats = await fetchJson(`${MOCK_SOCKS_ADMIN_URL}/stats`);
  const expectedHosts = await resolveExpectedHosts(MOCK_DNS_HOST);
  assert.ok(
    stats.connects.some((entry) => expectedHosts.has(entry.host) && entry.port === 53),
    `expected TCP DNS CONNECT to one of ${JSON.stringify([...expectedHosts])}:53, got ${JSON.stringify(stats)}`
  );
});

testIfEnabled("container SOCKS fail-closes when upstream exits", async () => {
  await waitForService(`${CERELAY_BASE_URL}/health`);

  await postJson(`${MOCK_SOCKS_ADMIN_URL}/control/stop-listener`);

  await waitFor(async () => {
    try {
      const response = await fetchWithTimeout(`${CERELAY_BASE_URL}/health`);
      return response.status !== 200;
    } catch {
      return true;
    }
  }, 30_000, "cerelay-socks-test did not fail-close after SOCKS upstream disappeared");
});

async function runPtySession() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(CERELAY_WS_URL);
    let output = "";
    let sawExit = false;

    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());

      if (message.type === "connected") {
        ws.send(
          JSON.stringify({
            type: "create_pty_session",
            cwd: "/tmp",
            cols: 80,
            rows: 24,
            term: "xterm-256color",
          })
        );
        return;
      }

      if (message.type === "error") {
        reject(new Error(message.message));
        ws.close();
        return;
      }

      if (message.type === "tool_call") {
        reject(new Error(`unexpected tool call: ${JSON.stringify(message)}`));
        ws.close();
        return;
      }

      if (message.type === "pty_output") {
        output += Buffer.from(message.data, "base64").toString("utf8");
        return;
      }

      if (message.type === "pty_exit") {
        sawExit = true;
        resolve({
          exitCode: message.exitCode ?? 1,
          output,
        });
        ws.close();
      }
    });

    ws.on("error", reject);
    ws.on("close", () => {
      if (!sawExit) {
        reject(new Error("websocket closed before pty_exit"));
      }
    });
  });
}

async function waitForService(url) {
  await waitFor(async () => {
    try {
      const response = await fetchWithTimeout(url);
      return response.status === 200;
    } catch {
      return false;
    }
  }, 60_000, `service did not become ready: ${url}`);
}

async function waitFor(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(message);
}

async function fetchJson(url, options) {
  const response = await fetchWithTimeout(url, options);
  if (!response.ok) {
    throw new Error(`request failed: ${response.status} ${url}`);
  }
  return response.json();
}

async function postJson(url) {
  return fetchJson(url, { method: "POST" });
}

async function resolveExpectedHosts(host) {
  const hosts = new Set([host]);
  try {
    const resolved = await lookup(host);
    hosts.add(resolved.address);
  } catch {
    // The suite is skipped outside the compose network, where service DNS is unavailable.
  }
  return hosts;
}

function fetchWithTimeout(url, options) {
  return fetch(url, {
    ...options,
    signal: AbortSignal.timeout(5_000),
  });
}
