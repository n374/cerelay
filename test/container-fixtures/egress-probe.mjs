import http from "node:http";

const host = process.env.EGRESS_PROBE_HOST || "0.0.0.0";
const port = Number(process.env.EGRESS_PROBE_PORT || "8080");
const body = process.env.EGRESS_PROBE_BODY || "pong from egress-probe";

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  res.writeHead(200, { "content-type": "text/plain" });
  res.end(body);
});

server.listen(port, host, () => {
  console.log(`egress-probe listening on ${host}:${port}`);
});
