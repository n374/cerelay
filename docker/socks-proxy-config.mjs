#!/usr/bin/env node

import process from "node:process";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseProxy(rawValue) {
  const value = (rawValue || "").trim();
  if (!value) {
    fail("CERELAY_SOCKS_PROXY is required");
  }

  if (value.includes("://")) {
    let url;
    try {
      url = new URL(value);
    } catch (error) {
      fail(`Invalid SOCKS proxy URI: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (url.protocol !== "socks5:") {
      fail(`Unsupported proxy protocol: ${url.protocol}. Only socks5:// is supported.`);
    }
    if (!url.hostname || !url.port) {
      fail("SOCKS proxy URI must include host and port.");
    }

    return {
      host: url.hostname,
      port: Number(url.port),
      username: decodeURIComponent(url.username || ""),
      password: decodeURIComponent(url.password || ""),
    };
  }

  const parts = value.split(":");
  if (parts.length !== 2 && parts.length !== 4) {
    fail("Unsupported SOCKS proxy format. Use socks5://user:pass@host:port or host:port[:user:pass].");
  }

  const [host, port, username = "", password = ""] = parts;
  if (!host || !port) {
    fail("Compact SOCKS proxy format must be host:port[:username:password].");
  }

  return {
    host,
    port: Number(port),
    username,
    password,
  };
}

function buildConfig(proxy) {
  const dnsServer = process.env.CERELAY_SOCKS_DNS_SERVER?.trim() || "1.1.1.1";
  const tunAddress = process.env.CERELAY_SOCKS_TUN_ADDRESS?.trim() || "172.19.0.1/30";
  const tunMtu = Number(process.env.CERELAY_SOCKS_TUN_MTU || "9000");

  const outbound = {
    type: "socks",
    tag: "proxy",
    server: proxy.host,
    server_port: proxy.port,
    version: "5",
  };

  if (proxy.username) {
    outbound.username = proxy.username;
  }
  if (proxy.password) {
    outbound.password = proxy.password;
  }

  return {
    log: { level: "warn" },
    dns: {
      servers: [{ tag: "remote-dns", address: dnsServer, detour: "proxy" }],
      final: "remote-dns",
      strategy: "ipv4_only",
    },
    inbounds: [
      {
        type: "tun",
        tag: "tun-in",
        interface_name: "tun0",
        address: [tunAddress],
        mtu: tunMtu,
        auto_route: true,
        strict_route: true,
        stack: "system",
        auto_redirect: true,
      },
    ],
    outbounds: [outbound],
    route: {
      rules: [
        { action: "sniff" },
        { protocol: "dns", action: "hijack-dns" },
      ],
      final: "proxy",
      auto_detect_interface: true,
    },
  };
}

const mode = process.argv[2] || "config";
const proxy = parseProxy(process.argv[3] || process.env.CERELAY_SOCKS_PROXY || "");

if (!Number.isInteger(proxy.port) || proxy.port < 1 || proxy.port > 65535) {
  fail(`Invalid SOCKS proxy port: ${proxy.port}`);
}

if (mode === "endpoint") {
  process.stdout.write(`${proxy.host} ${proxy.port}\n`);
} else if (mode === "config") {
  process.stdout.write(`${JSON.stringify(buildConfig(proxy), null, 2)}\n`);
} else {
  fail(`Unknown mode: ${mode}`);
}
