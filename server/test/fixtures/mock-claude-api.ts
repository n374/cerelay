import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface MockClaudeApiHandle {
  baseUrl: string;
  promptRequestCount(): number;
  observedToolResult(): string | null;
  observedStdout(): string | null;
  close(): Promise<void>;
}

export async function startMockClaudeApiServer(command = "pwd"): Promise<MockClaudeApiHandle> {
  let promptRequests = 0;
  let toolResultContent: string | null = null;
  let observedStdout: string | null = null;

  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("mock Claude API server did not bind to a TCP port");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    promptRequestCount: () => promptRequests,
    observedToolResult: () => toolResultContent,
    observedStdout: () => observedStdout,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === "HEAD" && req.url === "/") {
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.method === "POST" && req.url?.startsWith("/v1/messages")) {
      const body = await readBody(req);
      const payload = JSON.parse(body) as { messages?: unknown[] };
      promptRequests += 1;

      if (promptRequests === 1) {
        writeSse(res, [
          [
            "message_start",
            {
              type: "message_start",
              message: {
                id: "msg_mock_1",
                type: "message",
                role: "assistant",
                model: "claude-sonnet-4-20250514",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            },
          ],
          [
            "content_block_start",
            {
              type: "content_block_start",
              index: 0,
              content_block: {
                type: "tool_use",
                id: "toolu_mock_bash_1",
                name: "Bash",
                input: {},
              },
            },
          ],
          [
            "content_block_delta",
            {
              type: "content_block_delta",
              index: 0,
              delta: {
                type: "input_json_delta",
                partial_json: JSON.stringify({ command }),
              },
            },
          ],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          [
            "message_delta",
            {
              type: "message_delta",
              delta: { stop_reason: "tool_use", stop_sequence: null },
              usage: { output_tokens: 8 },
            },
          ],
          ["message_stop", { type: "message_stop" }],
        ]);
        return;
      }

      const toolResult = findToolResultBlock(payload.messages ?? []);
      if (!toolResult) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "missing tool_result in follow-up request" } }));
        return;
      }

      toolResultContent = normalizeToolResultContent(toolResult.content);
      observedStdout = findFirstStdout(payload.messages ?? []);
      const finalText = `mock api final: ${toolResultContent ?? "<missing>"}`;
      writeSse(res, [
        [
          "message_start",
          {
            type: "message_start",
            message: {
              id: "msg_mock_2",
              type: "message",
              role: "assistant",
              model: "claude-sonnet-4-20250514",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          },
        ],
        [
          "content_block_start",
          {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "text",
              text: "",
            },
          },
        ],
        [
          "content_block_delta",
          {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "text_delta",
              text: finalText,
            },
          },
        ],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        [
          "message_delta",
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 4 },
          },
        ],
        ["message_stop", { type: "message_stop" }],
      ]);
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  }
}

function writeSse(
  res: ServerResponse,
  events: Array<[event: string, payload: Record<string, unknown>]>
): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    connection: "keep-alive",
    "cache-control": "no-cache",
  });
  for (const [event, payload] of events) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
  res.end();
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function findToolResultBlock(input: unknown): { content?: unknown } | null {
  if (Array.isArray(input)) {
    for (const item of input) {
      const found = findToolResultBlock(item);
      if (found) {
        return found;
      }
    }
    return null;
  }

  if (!input || typeof input !== "object") {
    return null;
  }

  const candidate = input as { type?: unknown; content?: unknown };
  if (candidate.type === "tool_result") {
    return candidate;
  }

  for (const value of Object.values(candidate)) {
    const found = findToolResultBlock(value);
    if (found) {
      return found;
    }
  }

  return null;
}

function normalizeToolResultContent(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const textBlock = content.find(
    (item): item is { type: "text"; text: string } =>
      Boolean(item) &&
      typeof item === "object" &&
      (item as { type?: unknown }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string"
  );
  return textBlock?.text ?? null;
}

function findFirstStdout(input: unknown): string | null {
  if (Array.isArray(input)) {
    for (const item of input) {
      const found = findFirstStdout(item);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }

  if (!input || typeof input !== "object") {
    return null;
  }

  const candidate = input as { stdout?: unknown };
  if (typeof candidate.stdout === "string") {
    return candidate.stdout;
  }

  for (const value of Object.values(candidate)) {
    const found = findFirstStdout(value);
    if (found !== null) {
      return found;
    }
  }

  return null;
}
