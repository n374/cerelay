import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const execFileAsync = promisify(execFile);
const WORKDIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = resolve(WORKDIR, "docker/socks-proxy-config.mjs");

test("socks config helper parses compact format and emits fail-closed config", async () => {
  const { stdout } = await execFileAsync(process.execPath, [SCRIPT, "config", "127.0.0.1:1080:user:pass"], {
    cwd: WORKDIR,
  });

  const config = JSON.parse(stdout);
  assert.equal(config.outbounds[0].type, "socks");
  assert.equal(config.outbounds[0].server, "127.0.0.1");
  assert.equal(config.outbounds[0].server_port, 1080);
  assert.equal(config.outbounds[0].username, "user");
  assert.equal(config.outbounds[0].password, "pass");
  assert.equal(config.route.final, "proxy");
  assert.deepEqual(
    config.route.rules.map((rule) => rule.protocol ?? rule.action),
    ["sniff", "dns"]
  );
});

test("socks config helper parses socks5 URI endpoint", async () => {
  const { stdout } = await execFileAsync(process.execPath, [SCRIPT, "endpoint", "socks5://alice:secret@proxy.example.com:2080"], {
    cwd: WORKDIR,
  });

  assert.equal(stdout.trim(), "proxy.example.com 2080");
});
