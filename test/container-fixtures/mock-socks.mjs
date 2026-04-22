import http from "node:http";
import net from "node:net";

const socksHost = process.env.MOCK_SOCKS_HOST || "0.0.0.0";
const socksPort = Number(process.env.MOCK_SOCKS_PORT || "1080");
const adminHost = process.env.MOCK_SOCKS_ADMIN_HOST || "0.0.0.0";
const adminPort = Number(process.env.MOCK_SOCKS_ADMIN_PORT || "18080");
const connectMap = parseConnectMap(process.env.MOCK_SOCKS_CONNECT_MAP || "");

const stats = {
  connects: [],
};

let socksServer = createSocksServer();
socksServer.listen(socksPort, socksHost, () => {
  console.log(`mock-socks listening on ${socksHost}:${socksPort}`);
});

const adminServer = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  if (req.method === "GET" && req.url === "/stats") {
    writeJson(res, stats);
    return;
  }

  if (req.method === "POST" && req.url === "/reset") {
    stats.connects = [];
    writeJson(res, { ok: true });
    return;
  }

  if (req.method === "POST" && req.url === "/control/stop-listener") {
    if (socksServer.listening) {
      socksServer.close(() => undefined);
    }
    writeJson(res, { ok: true });
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

adminServer.listen(adminPort, adminHost, () => {
  console.log(`mock-socks admin listening on ${adminHost}:${adminPort}`);
});

function createSocksServer() {
  return net.createServer((clientSocket) => {
    let buffer = Buffer.alloc(0);
    let stage = "greeting";
    let upstreamSocket;

    clientSocket.on("data", (chunk) => {
      if (stage === "proxy") {
        return;
      }

      buffer = Buffer.concat([buffer, chunk]);

      if (stage === "greeting") {
        if (buffer.length < 2) {
          return;
        }

        const version = buffer[0];
        const methodCount = buffer[1];
        if (buffer.length < 2 + methodCount) {
          return;
        }

        if (version !== 0x05) {
          clientSocket.destroy();
          return;
        }

        buffer = buffer.subarray(2 + methodCount);
        clientSocket.write(Buffer.from([0x05, 0x00]));
        stage = "request";
      }

      if (stage === "request") {
        if (buffer.length < 4) {
          return;
        }

        const version = buffer[0];
        const command = buffer[1];
        const addressType = buffer[3];
        if (version !== 0x05 || command !== 0x01) {
          clientSocket.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          clientSocket.destroy();
          return;
        }

        const parsed = parseAddress(buffer, addressType);
        if (!parsed) {
          return;
        }

        const { host, port, bytesConsumed } = parsed;
        buffer = buffer.subarray(bytesConsumed);
        stats.connects.push({ host, port });

        const target = connectMap.get(`${host}:${port}`) ?? { host, port };
        upstreamSocket = net.createConnection(target);
        upstreamSocket.once("connect", () => {
          const reply = Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
          clientSocket.write(reply);
          stage = "proxy";
          if (buffer.length > 0) {
            upstreamSocket.write(buffer);
            buffer = Buffer.alloc(0);
          }
          clientSocket.pipe(upstreamSocket);
          upstreamSocket.pipe(clientSocket);
        });

        upstreamSocket.on("error", () => {
          const reply = Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
          clientSocket.write(reply);
          clientSocket.destroy();
        });
      }
    });

    clientSocket.on("error", () => undefined);
    clientSocket.on("close", () => {
      upstreamSocket?.destroy();
    });
  });
}

function parseAddress(buffer, addressType) {
  let offset = 4;
  let host;

  if (addressType === 0x01) {
    if (buffer.length < offset + 4 + 2) {
      return null;
    }
    host = Array.from(buffer.subarray(offset, offset + 4)).join(".");
    offset += 4;
  } else if (addressType === 0x03) {
    if (buffer.length < offset + 1) {
      return null;
    }
    const nameLength = buffer[offset];
    offset += 1;
    if (buffer.length < offset + nameLength + 2) {
      return null;
    }
    host = buffer.subarray(offset, offset + nameLength).toString("utf8");
    offset += nameLength;
  } else {
    return null;
  }

  const port = buffer.readUInt16BE(offset);
  offset += 2;

  return {
    host,
    port,
    bytesConsumed: offset,
  };
}

function writeJson(res, value) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

function parseConnectMap(rawValue) {
  const map = new Map();
  for (const entry of rawValue.split(",")) {
    const value = entry.trim();
    if (!value) {
      continue;
    }
    const [from, to] = value.split("=");
    if (!from || !to) {
      continue;
    }
    const [host, port] = to.split(":");
    if (!host || !port) {
      continue;
    }
    map.set(from, { host, port: Number(port) });
  }
  return map;
}
