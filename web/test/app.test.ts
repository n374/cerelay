import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const APP_PATH = "/Users/n374/Documents/Code/axon/web/public/app.js";
const STORAGE_KEY = "axon-web-config";
const SESSION_STORAGE_KEY = "axon-web-session";

test("web app restores a saved session and falls back to create_session on restore failure", async () => {
  const runtime = await createAppRuntime({
    storage: {
      [STORAGE_KEY]: JSON.stringify({
        brainUrl: "ws://app.test/ws",
        cwd: "/workspace",
        model: "claude-test",
      }),
      [SESSION_STORAGE_KEY]: JSON.stringify({
        sessionId: "sess-old",
        brainUrl: "ws://app.test/ws",
        cwd: "/workspace",
        model: "claude-test",
      }),
    },
  });
  runtime.document.fireDOMContentLoaded();
  const hooks = runtime.hooks();

  await hooks.connectWebSocket();
  const ws = runtime.lastSocket();
  ws.open();

  assert.deepEqual(JSON.parse(ws.sent[0]), {
    type: "restore_session",
    sessionId: "sess-old",
  });

  ws.message({ type: "error", message: "restore failed" });

  assert.equal(runtime.localStorage.getItem(SESSION_STORAGE_KEY), null);
  assert.deepEqual(JSON.parse(ws.sent[1]), {
    type: "create_session",
    cwd: "/workspace",
    model: "claude-test",
  });
});

test("web app aggregates streamed messages and updates tool status in place", async () => {
  const runtime = await createAppRuntime();
  runtime.document.fireDOMContentLoaded();
  const hooks = runtime.hooks();

  hooks.handleServerMessage({ type: "session_created", sessionId: "sess-1" });
  hooks.handleServerMessage({ type: "thought_chunk", sessionId: "sess-1", text: "思考" });
  hooks.handleServerMessage({ type: "thought_chunk", sessionId: "sess-1", text: "过程" });
  hooks.handleServerMessage({ type: "text_chunk", sessionId: "sess-1", text: "回答" });
  hooks.handleServerMessage({ type: "text_chunk", sessionId: "sess-1", text: "完成" });
  hooks.handleServerMessage({
    type: "tool_call",
    sessionId: "sess-1",
    requestId: "req-1",
    toolName: "Read",
  });
  hooks.handleServerMessage({
    type: "tool_call_complete",
    sessionId: "sess-1",
    requestId: "req-1",
  });

  const messageTexts = runtime.dom.messages.children.map((child) => child.textContent);
  assert.deepEqual(messageTexts, ["Session 已就绪", "思考过程", "回答完成"]);
  assert.equal(runtime.dom.promptInput.disabled, false);
  assert.equal(runtime.dom.btnSend.disabled, false);

  const toolItem = runtime.dom.toolCalls.children[0];
  assert.match(toolItem.className, /tool-item-done/);
  assert.equal(toolItem.querySelector(".tool-status")?.textContent, "完成");
});

test("web app sends prompt once per turn and re-enables input after session_end", async () => {
  const runtime = await createAppRuntime();
  runtime.document.fireDOMContentLoaded();
  const hooks = runtime.hooks();

  const ws = new runtime.FakeWebSocket("ws://app.test/ws");
  ws.readyState = runtime.FakeWebSocket.OPEN;
  hooks.state.ws = ws;
  hooks.state.sessionId = "sess-2";

  runtime.dom.promptInput.value = "hello";
  hooks.sendPrompt();
  hooks.sendPrompt();

  assert.equal(ws.sent.length, 1);
  assert.deepEqual(JSON.parse(ws.sent[0]), {
    type: "prompt",
    sessionId: "sess-2",
    text: "hello",
  });
  assert.equal(runtime.dom.promptInput.value, "");
  assert.equal(runtime.dom.promptInput.disabled, true);
  assert.equal(runtime.dom.btnSend.disabled, true);

  hooks.handleServerMessage({ type: "session_end", sessionId: "sess-2", result: "done" });
  assert.equal(runtime.dom.promptInput.disabled, false);
  assert.equal(runtime.dom.btnSend.disabled, false);
});

test("web app saves and pushes configurable Hand tool routing from settings", async () => {
  const fetchCalls: Array<{
    url: string;
    init?: RequestInit;
  }> = [];
  const runtime = await createAppRuntime({
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          builtinToolNames: ["Read", "Bash"],
          handToolNames: ["WebFetch", "WebSearch"],
          handToolPrefixes: ["mcp__", "connector__"],
        }),
      };
    },
  });
  runtime.document.fireDOMContentLoaded();
  const hooks = runtime.hooks();

  runtime.dom.brainUrlInput.value = "ws://app.test/ws";
  runtime.dom.cwdInput.value = "/workspace";
  runtime.dom.modelInput.value = "claude-test";
  runtime.dom.adminTokenInput.value = "axon_admin";
  runtime.dom.handToolNamesInput.value = "WebFetch\nWebSearch";
  runtime.dom.handToolPrefixesInput.value = "mcp__\nconnector__";

  await hooks.onConnectClick();

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0]?.url, "/admin/tool-routing");
  assert.equal(fetchCalls[0]?.init?.method, "PUT");
  assert.equal((fetchCalls[0]?.init?.headers ?? {})["Authorization"], "Bearer axon_admin");
  assert.deepEqual(JSON.parse(String(fetchCalls[0]?.init?.body)), {
    handToolNames: ["WebFetch", "WebSearch"],
    handToolPrefixes: ["mcp__", "connector__"],
  });

  const savedConfig = JSON.parse(runtime.localStorage.getItem(STORAGE_KEY) ?? "{}");
  assert.deepEqual(savedConfig.handToolNames, ["WebFetch", "WebSearch"]);
  assert.deepEqual(savedConfig.handToolPrefixes, ["mcp__", "connector__"]);

  const ws = runtime.lastSocket();
  assert.equal(ws?.url, "ws://app.test/ws");
});

async function createAppRuntime(
  options: {
    storage?: Record<string, string>;
    fetchImpl?: (url: string, init?: RequestInit) => Promise<{
      ok: boolean;
      status: number;
      json(): Promise<unknown>;
    }>;
  } = {}
) {
  const script = await fs.readFile(APP_PATH, "utf8");
  const document = new FakeDocument();
  const localStorage = new FakeStorage(options.storage ?? {});
  const timers = new Map<number, () => void>();
  let timerId = 0;

  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static instances: FakeWebSocket[] = [];

    readonly url: string;
    readyState = FakeWebSocket.CONNECTING;
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;

    constructor(url: string) {
      this.url = url;
      FakeWebSocket.instances.push(this);
    }

    send(payload: string): void {
      this.sent.push(payload);
    }

    close(): void {
      this.readyState = FakeWebSocket.CLOSED;
      this.onclose?.();
    }

    open(): void {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    }

    message(payload: unknown): void {
      this.onmessage?.({ data: JSON.stringify(payload) });
    }

    fail(): void {
      this.onerror?.();
    }
  }

  const window = {
    __AXON_WEB_ENABLE_TEST_HOOKS__: true,
    setTimeout: (fn: () => void) => {
      timerId += 1;
      timers.set(timerId, fn);
      return timerId;
    },
    clearTimeout: (id: number) => {
      timers.delete(id);
    },
  };

  const context = vm.createContext({
    window,
    document,
    localStorage,
    location: { host: "app.test" },
    console,
    WebSocket: FakeWebSocket,
    fetch: options.fetchImpl ?? (async () => {
      throw new Error("unexpected fetch");
    }),
  });

  vm.runInContext(script, context, { filename: path.basename(APP_PATH) });

  const dom = document.exportElements();
  return {
    document,
    localStorage,
    dom: {
      status: dom["connection-status"],
      sessionLabel: dom["session-label"],
      sessionId: dom["session-id"],
      btnNewSession: dom["btn-new-session"],
      btnSettings: dom["btn-settings"],
      btnSend: dom["btn-send"],
      promptInput: dom["prompt-input"],
      messages: dom.messages,
      toolCalls: dom["tool-calls"],
      modal: dom["settings-modal"],
      brainUrlInput: dom["brain-url"],
      cwdInput: dom["brain-cwd"],
      modelInput: dom["brain-model"],
      adminTokenInput: dom["admin-token"],
      handToolNamesInput: dom["hand-tool-names"],
      handToolPrefixesInput: dom["hand-tool-prefixes"],
      btnConnect: dom["btn-connect"],
      btnCancelSettings: dom["btn-cancel-settings"],
    },
    FakeWebSocket,
    hooks: () => (window as { __AXON_WEB_TEST_HOOKS__?: Record<string, unknown> }).__AXON_WEB_TEST_HOOKS__ as Record<string, any>,
    lastSocket: () => FakeWebSocket.instances.at(-1),
    runReconnectTimer: () => {
      const pending = timers.entries().next();
      if (!pending.done) {
        const [id, fn] = pending.value;
        timers.delete(id);
        fn();
      }
    },
  };
}

class FakeStorage {
  private readonly values = new Map<string, string>();

  constructor(seed: Record<string, string>) {
    for (const [key, value] of Object.entries(seed)) {
      this.values.set(key, value);
    }
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

class FakeClassList {
  constructor(private readonly owner: FakeElement) {}

  add(...tokens: string[]): void {
    const next = this.tokens();
    for (const token of tokens) {
      next.add(token);
    }
    this.owner.className = Array.from(next).join(" ");
  }

  remove(...tokens: string[]): void {
    const next = this.tokens();
    for (const token of tokens) {
      next.delete(token);
    }
    this.owner.className = Array.from(next).join(" ");
  }

  contains(token: string): boolean {
    return this.tokens().has(token);
  }

  private tokens(): Set<string> {
    return new Set(this.owner.className.split(/\s+/).filter(Boolean));
  }
}

class FakeElement {
  className = "";
  textContent = "";
  title = "";
  value = "";
  disabled = false;
  scrollTop = 0;
  scrollHeight = 0;
  readonly children: FakeElement[] = [];
  readonly classList = new FakeClassList(this);
  private readonly listeners = new Map<string, Array<(event: { target: FakeElement; key?: string; shiftKey?: boolean; preventDefault(): void }) => void>>();

  constructor(readonly id: string | null = null) {}

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    this.scrollHeight = this.children.length;
    return child;
  }

  prepend(child: FakeElement): void {
    this.children.unshift(child);
    this.scrollHeight = this.children.length;
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      this.appendChild(node);
    }
  }

  addEventListener(type: string, listener: (event: { target: FakeElement; key?: string; shiftKey?: boolean; preventDefault(): void }) => void): void {
    const items = this.listeners.get(type) ?? [];
    items.push(listener);
    this.listeners.set(type, items);
  }

  dispatch(type: string, event: Partial<{ target: FakeElement; key: string; shiftKey: boolean; preventDefault(): void }> = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({
        target: this,
        preventDefault: () => undefined,
        ...event,
      });
    }
  }

  focus(): void {}

  querySelector(selector: string): FakeElement | null {
    if (!selector.startsWith(".")) {
      return null;
    }

    const className = selector.slice(1);
    return findByClass(this, className);
  }

  set innerHTML(value: string) {
    if (value === "") {
      this.children.length = 0;
      this.textContent = "";
      this.scrollHeight = 0;
    }
  }
}

class FakeDocument {
  private readonly elements = new Map<string, FakeElement>();
  private domContentLoaded: (() => void) | null = null;

  constructor() {
    for (const id of [
      "connection-status",
      "session-label",
      "session-id",
      "btn-new-session",
      "btn-settings",
      "btn-send",
      "prompt-input",
      "messages",
      "tool-calls",
      "settings-modal",
      "brain-url",
      "brain-cwd",
      "brain-model",
      "admin-token",
      "hand-tool-names",
      "hand-tool-prefixes",
      "btn-connect",
      "btn-cancel-settings",
    ]) {
      this.elements.set(id, new FakeElement(id));
    }

    this.elements.get("session-label")?.classList.add("hidden");
    this.elements.get("session-id")?.classList.add("hidden");
    this.elements.get("btn-new-session")?.classList.add("hidden");
  }

  getElementById(id: string): FakeElement {
    const element = this.elements.get(id);
    if (!element) {
      throw new Error(`missing fake element: ${id}`);
    }
    return element;
  }

  createElement(): FakeElement {
    return new FakeElement();
  }

  addEventListener(type: string, listener: () => void): void {
    if (type === "DOMContentLoaded") {
      this.domContentLoaded = listener;
    }
  }

  fireDOMContentLoaded(): void {
    this.domContentLoaded?.();
  }

  exportElements(): Record<string, FakeElement> {
    return Object.fromEntries(this.elements.entries());
  }
}

function findByClass(root: FakeElement, className: string): FakeElement | null {
  for (const child of root.children) {
    if (child.classList.contains(className)) {
      return child;
    }
    const nested = findByClass(child, className);
    if (nested) {
      return nested;
    }
  }
  return null;
}
