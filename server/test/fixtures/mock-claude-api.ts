import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface MockClaudeApiRequest {
  requestNumber: number;
  payload: Record<string, unknown>;
}

export interface MockClaudeApiHandle {
  baseUrl: string;
  promptRequestCount(): number;
  observedToolResult(): string | null;
  observedStdout(): string | null;
  observedRequests(): readonly MockClaudeApiRequest[];
  observedTaskToolInput(): Record<string, unknown> | null;
  observedTaskToolSchema(): Record<string, unknown> | null;
  close(): Promise<void>;
}

export type MockClaudeApiScenario =
  | {
      type?: "direct_bash";
      command?: string;
    }
  | {
      type: "task_subagent_bash";
      command?: string;
    };

export async function startMockClaudeApiServer(
  scenarioOrCommand: string | MockClaudeApiScenario = "pwd"
): Promise<MockClaudeApiHandle> {
  const scenario = normalizeScenario(scenarioOrCommand);
  let promptRequests = 0;
  let toolResultContent: string | null = null;
  let observedStdout: string | null = null;
  let observedTaskToolInput: Record<string, unknown> | null = null;
  let observedTaskToolSchema: Record<string, unknown> | null = null;
  const observedRequests: MockClaudeApiRequest[] = [];
  let taskScenarioStage: "initial" | "waiting_for_subagent" | "waiting_for_subagent_tool_result" | "done" = "initial";

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
    observedRequests: () => observedRequests,
    observedTaskToolInput: () => observedTaskToolInput,
    observedTaskToolSchema: () => observedTaskToolSchema,
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
      const payload = JSON.parse(body) as Record<string, unknown>;
      promptRequests += 1;
      observedRequests.push({
        requestNumber: promptRequests,
        payload,
      });

      const messages = Array.isArray(payload.messages) ? payload.messages : [];

      if (scenario.type === "task_subagent_bash") {
        const taskTool = findRequestTool(payload.tools, "Task");
        if (!observedTaskToolSchema && taskTool) {
          observedTaskToolSchema = taskTool;
          observedTaskToolInput = buildTaskToolInput(taskTool, scenario.command);
        }

        switch (taskScenarioStage) {
          case "initial": {
            taskScenarioStage = "waiting_for_subagent";
            const taskInput = observedTaskToolInput ?? {
              description: "Explore the current directory",
              prompt: `Use Bash to run \`${scenario.command}\` and return the result.`,
            };
            observedTaskToolInput = taskInput;
            writeToolUseSse(res, {
              messageId: "msg_mock_parent_1",
              toolUseId: "toolu_mock_task_1",
              toolName: "Task",
              input: taskInput,
            });
            return;
          }
          case "waiting_for_subagent": {
            taskScenarioStage = "waiting_for_subagent_tool_result";
            writeToolUseSse(res, {
              messageId: "msg_mock_child_1",
              toolUseId: "toolu_mock_bash_child_1",
              toolName: "Bash",
              input: { command: scenario.command },
            });
            return;
          }
          case "waiting_for_subagent_tool_result": {
            const toolResult = findToolResultBlock(messages);
            if (!toolResult) {
              sendInvalidRequest(res, "missing child tool_result in follow-up request");
              return;
            }

            toolResultContent = normalizeToolResultContent(toolResult.content);
            observedStdout = findFirstStdout(messages);
            taskScenarioStage = "done";
            writeTextSse(
              res,
              "msg_mock_parent_2",
              `mock api final: child agent final: ${toolResultContent ?? "<missing>"}`
            );
            return;
          }
          case "done": {
            writeTextSse(
              res,
              "msg_mock_parent_3",
              `mock api final: child agent final: ${toolResultContent ?? "<missing>"}`
            );
            return;
          }
        }
      }

      if (promptRequests === 1) {
        writeToolUseSse(res, {
          messageId: "msg_mock_1",
          toolUseId: "toolu_mock_bash_1",
          toolName: "Bash",
          input: { command: scenario.command },
        });
        return;
      }

      const toolResult = findToolResultBlock(messages);
      if (!toolResult) {
        sendInvalidRequest(res, "missing tool_result in follow-up request");
        return;
      }

      toolResultContent = normalizeToolResultContent(toolResult.content);
      observedStdout = findFirstStdout(messages);
      const finalText = `mock api final: ${toolResultContent ?? "<missing>"}`;
      writeTextSse(res, "msg_mock_2", finalText);
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  }
}

function normalizeScenario(input: string | MockClaudeApiScenario): { type: "direct_bash" | "task_subagent_bash"; command: string } {
  if (typeof input === "string") {
    return {
      type: "direct_bash",
      command: input,
    };
  }

  return {
    type: input.type ?? "direct_bash",
    command: input.command ?? "pwd",
  };
}

function sendInvalidRequest(res: ServerResponse, message: string): void {
  res.writeHead(400, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }));
}

function writeToolUseSse(
  res: ServerResponse,
  options: {
    messageId: string;
    toolUseId: string;
    toolName: string;
    input: Record<string, unknown>;
  }
): void {
  writeSse(res, [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: options.messageId,
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
          id: options.toolUseId,
          name: options.toolName,
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
          partial_json: JSON.stringify(options.input),
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
}

function writeTextSse(res: ServerResponse, messageId: string, text: string): void {
  writeSse(res, [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: messageId,
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
          text,
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

function findRequestTool(input: unknown, toolName: string): Record<string, unknown> | null {
  if (!Array.isArray(input)) {
    return null;
  }

  for (const candidate of input) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const tool = candidate as { name?: unknown };
    if (tool.name === toolName) {
      return candidate as Record<string, unknown>;
    }
  }

  return null;
}

function buildTaskToolInput(taskTool: Record<string, unknown>, command: string): Record<string, unknown> {
  const schema = extractInputSchema(taskTool);
  const properties = schema && typeof schema.properties === "object" && schema.properties
    ? schema.properties as Record<string, unknown>
    : {};
  const required = Array.isArray(schema?.required)
    ? schema.required.filter((entry): entry is string => typeof entry === "string")
    : [];
  const keys = Array.from(new Set([...Object.keys(properties), ...required]));
  const result: Record<string, unknown> = {};

  for (const key of keys) {
    result[key] = buildValueForSchemaKey(key, properties[key], command);
  }

  if (keys.length === 0) {
    return {
      description: "Explore the current directory",
      prompt: `Use Bash to run \`${command}\` and return the result.`,
    };
  }

  return result;
}

function extractInputSchema(tool: Record<string, unknown>): { properties?: Record<string, unknown>; required?: unknown[] } | null {
  const candidate = tool.input_schema ?? tool.inputSchema;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }
  return candidate as { properties?: Record<string, unknown>; required?: unknown[] };
}

function buildValueForSchemaKey(key: string, schema: unknown, command: string): unknown {
  const property = schema && typeof schema === "object" && !Array.isArray(schema)
    ? schema as Record<string, unknown>
    : {};
  const enumValues = Array.isArray(property.enum)
    ? property.enum.filter((entry): entry is string => typeof entry === "string")
    : [];
  const normalizedKey = key.toLowerCase();

  if (enumValues.length > 0) {
    const preferred = pickPreferredEnumValue(normalizedKey, enumValues);
    if (preferred) {
      return preferred;
    }
    return enumValues[0];
  }

  const type = typeof property.type === "string" ? property.type : undefined;
  if (type === "boolean") {
    return false;
  }
  if (type === "number" || type === "integer") {
    return 0;
  }
  if (type === "array") {
    return [];
  }
  if (type === "object") {
    return {};
  }

  if (normalizedKey.includes("prompt")) {
    return `Use Bash to run \`${command}\` and return the result.`;
  }
  if (normalizedKey.includes("description")) {
    return "Explore the current directory and report the result.";
  }
  if (normalizedKey.includes("agent") || normalizedKey.includes("subagent")) {
    return "Explore";
  }
  if (normalizedKey.includes("model")) {
    return "claude-3-5-haiku-latest";
  }

  return `${key} value`;
}

function pickPreferredEnumValue(key: string, values: string[]): string | null {
  const exactPreferredPatterns =
    key.includes("agent") || key.includes("subagent")
      ? [/^explore$/i, /^general-purpose$/i, /^general$/i]
      : key.includes("model")
        ? [/haiku/i]
        : [];

  for (const pattern of exactPreferredPatterns) {
    const match = values.find((value) => pattern.test(value));
    if (match) {
      return match;
    }
  }

  return null;
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
