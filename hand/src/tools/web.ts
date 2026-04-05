import { ToolError } from "../tool-error.js";

export interface WebFetchInput {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeout_ms?: number;
  max_bytes?: number;
}

export interface WebFetchOutput {
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

export async function webFetch(input: WebFetchInput): Promise<WebFetchOutput> {
  if (!input.url) {
    throw new ToolError("invalid_input", "WebFetch", "WebFetch 缺少 url");
  }

  const timeoutMs = input.timeout_ms ?? 15_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ToolError("invalid_input", "WebFetch", "timeout_ms 必须为正数");
  }

  const maxBytes = input.max_bytes ?? 1_000_000;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new ToolError("invalid_input", "WebFetch", "max_bytes 必须为正数");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(input.url, {
      method: input.method ?? "GET",
      headers: input.headers,
      body: input.body,
      signal: controller.signal,
      redirect: "follow",
    });

    const body = await readResponseBody(response, maxBytes);
    return {
      url: response.url,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ToolError("timeout", "WebFetch", `WebFetch 超时（${timeoutMs}ms）`);
    }
    throw new ToolError("web_fetch_failed", "WebFetch", error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
}

async function readResponseBody(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return response.text();
  }

  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      throw new ToolError("response_too_large", "WebFetch", `响应超过限制（>${maxBytes} bytes）`);
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(merged);
}
