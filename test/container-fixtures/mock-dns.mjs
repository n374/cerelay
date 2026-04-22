import http from "node:http";
import net from "node:net";

const dnsHost = process.env.MOCK_DNS_HOST || "0.0.0.0";
const dnsPort = Number(process.env.MOCK_DNS_PORT || "53");
const adminHost = process.env.MOCK_DNS_ADMIN_HOST || "0.0.0.0";
const adminPort = Number(process.env.MOCK_DNS_ADMIN_PORT || "18081");
const answerIp = process.env.MOCK_DNS_A_RECORD || "203.0.113.10";
const answerSuffix = (process.env.MOCK_DNS_NAME_SUFFIX || ".test").toLowerCase();

const stats = {
  queries: [],
};

const dnsServer = net.createServer((socket) => {
  let buffer = Buffer.alloc(0);

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const packetLength = buffer.readUInt16BE(0);
      if (buffer.length < packetLength + 2) {
        return;
      }

      const packet = buffer.subarray(2, packetLength + 2);
      buffer = buffer.subarray(packetLength + 2);
      const response = buildResponse(packet);
      if (response) {
        const frame = Buffer.alloc(2 + response.length);
        frame.writeUInt16BE(response.length, 0);
        response.copy(frame, 2);
        socket.write(frame);
      }
    }
  });

  socket.on("error", () => undefined);
});

dnsServer.listen(dnsPort, dnsHost, () => {
  console.log(`mock-dns listening on ${dnsHost}:${dnsPort}`);
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
    stats.queries = [];
    writeJson(res, { ok: true });
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

adminServer.listen(adminPort, adminHost, () => {
  console.log(`mock-dns admin listening on ${adminHost}:${adminPort}`);
});

function buildResponse(packet) {
  if (packet.length < 12) {
    return null;
  }

  const id = packet.readUInt16BE(0);
  const qdCount = packet.readUInt16BE(4);
  if (qdCount < 1) {
    return null;
  }

  const question = parseQuestion(packet);
  if (!question) {
    return null;
  }

  stats.queries.push({
    name: question.name,
    type: question.type,
  });

  const isMatch = question.type === 1 && question.name.endsWith(answerSuffix);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(isMatch ? 0x8180 : 0x8183, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(isMatch ? 1 : 0, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);

  if (!isMatch) {
    return Buffer.concat([header, question.rawQuestion]);
  }

  const answer = Buffer.alloc(16);
  answer.writeUInt16BE(0xc00c, 0);
  answer.writeUInt16BE(1, 2);
  answer.writeUInt16BE(1, 4);
  answer.writeUInt32BE(60, 6);
  answer.writeUInt16BE(4, 10);
  for (const [index, part] of answerIp.split(".").entries()) {
    answer[12 + index] = Number(part);
  }

  return Buffer.concat([header, question.rawQuestion, answer]);
}

function parseQuestion(packet) {
  let offset = 12;
  const labels = [];
  while (offset < packet.length) {
    const length = packet[offset];
    offset += 1;
    if (length === 0) {
      break;
    }
    if (offset + length > packet.length) {
      return null;
    }
    labels.push(packet.subarray(offset, offset + length).toString("utf8"));
    offset += length;
  }

  if (offset + 4 > packet.length) {
    return null;
  }

  const type = packet.readUInt16BE(offset);
  offset += 2;
  offset += 2;

  return {
    name: labels.join(".").toLowerCase(),
    type,
    rawQuestion: packet.subarray(12, offset),
  };
}

function writeJson(res, value) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}
