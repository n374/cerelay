import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const execFileAsync = promisify(execFile);
const WORKDIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = resolve(WORKDIR, "docker/socks-proxy-config.mjs");

test("config defaults to TCP DNS over proxy and keeps UDP forward", async () => {
  const config = await runConfig("127.0.0.1:1080:user:pass");

  assert.equal(config.outbounds[0].type, "socks");
  assert.equal(config.outbounds[0].server, "127.0.0.1");
  assert.equal(config.outbounds[0].server_port, 1080);
  assert.equal(config.outbounds[0].username, "user");
  assert.equal(config.outbounds[0].password, "pass");
  assert.equal(config.dns.servers[0].address, "tcp://1.1.1.1");
  assert.equal(config.dns.servers[0].detour, "proxy");
  assert.equal(config.route.final, "proxy");
  assert.deepEqual(config.route.rules, [{ action: "sniff" }, { protocol: "dns", action: "hijack-dns" }]);
});

test("config injects UDP reject after dns hijack when CERELAY_SOCKS_UDP=block", async () => {
  const config = await runConfig("127.0.0.1:1080", { CERELAY_SOCKS_UDP: "block" });

  assert.deepEqual(config.route.rules, [
    { action: "sniff" },
    { protocol: "dns", action: "hijack-dns" },
    { network: "udp", action: "reject" },
  ]);
});

test("config preserves explicit DNS scheme (tcp/tls/https)", async () => {
  for (const dnsServer of ["tcp://9.9.9.9", "tls://dns.example.com", "https://dns.example.com/dns-query"]) {
    const config = await runConfig("127.0.0.1:1080", { CERELAY_SOCKS_DNS_SERVER: dnsServer });
    assert.equal(config.dns.servers[0].address, dnsServer);
  }
});

test("config wraps bare DNS host into tcp:// scheme", async () => {
  const config = await runConfig("127.0.0.1:1080", { CERELAY_SOCKS_DNS_SERVER: "8.8.4.4:5353" });
  assert.equal(config.dns.servers[0].address, "tcp://8.8.4.4:5353");
});

test("config rejects invalid CERELAY_SOCKS_UDP value", async () => {
  await assert.rejects(
    runConfig("127.0.0.1:1080", { CERELAY_SOCKS_UDP: "drop" }),
    (error) => {
      assert.match(error.stderr, /Invalid CERELAY_SOCKS_UDP value/);
      return true;
    }
  );
});

test("config respects CERELAY_SOCKS_TUN_ADDRESS / TUN_MTU env overrides", async () => {
  const config = await runConfig("127.0.0.1:1080", {
    CERELAY_SOCKS_TUN_ADDRESS: "172.20.0.1/30",
    CERELAY_SOCKS_TUN_MTU: "1400",
  });

  assert.deepEqual(config.inbounds[0].address, ["172.20.0.1/30"]);
  assert.equal(config.inbounds[0].mtu, 1400);
});

test("config helper rejects unsupported proxy scheme http://", async () => {
  await assert.rejects(
    runScript("config", "http://proxy.example.com:8080"),
    (error) => {
      assert.match(error.stderr, /Unsupported proxy protocol: http:/);
      return true;
    }
  );
});

test("config helper rejects out-of-range proxy port", async () => {
  await assert.rejects(
    runScript("config", "127.0.0.1:65536"),
    (error) => {
      assert.match(error.stderr, /Invalid SOCKS proxy port/);
      return true;
    }
  );
});

test("socks config helper parses socks5 URI endpoint", async () => {
  const { stdout } = await runScript("endpoint", "socks5://alice:secret@proxy.example.com:2080");
  assert.equal(stdout.trim(), "proxy.example.com 2080");
});

function runConfig(proxy, env = {}) {
  return runScript("config", proxy, env).then(({ stdout }) => JSON.parse(stdout));
}

function runScript(mode, proxy, env = {}) {
  return execFileAsync(process.execPath, [SCRIPT, mode, proxy], {
    cwd: WORKDIR,
    env: {
      ...process.env,
      ...env,
    },
  });
}
