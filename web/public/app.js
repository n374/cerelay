// ============================================================
// Axon Web UI — 浏览器端 JavaScript
// 通过 WebSocket 连接到 Axon Web Server（代理到 Brain）
// 实现：会话管理、流式消息展示、工具调用状态跟踪
// ============================================================

/* ---- 配置默认值 ---- */
const DEFAULT_BRAIN_URL = `ws://${location.host}/ws`;
const DEFAULT_CWD = "/";
const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const STORAGE_KEY = "axon-web-config";
const SESSION_STORAGE_KEY = "axon-web-session";

// ============================================================
// 状态
// ============================================================

const state = {
  ws: /** @type {WebSocket|null} */ (null),
  sessionId: /** @type {string|null} */ (null),
  resumableSessionId: /** @type {string|null} */ (null),
  restorePending: false,
  brainUrl: DEFAULT_BRAIN_URL,
  cwd: DEFAULT_CWD,
  model: DEFAULT_MODEL,
  adminToken: "",
  handToolNames: [],
  handToolPrefixes: [],
  isWaiting: false, // 等待 session_end
  shouldReconnect: false,
  reconnectAttempts: 0,
  reconnectTimer: /** @type {number|null} */ (null),
  /** @type {Map<string, HTMLElement>} */
  toolItems: new Map(),
  /** 当前正在累积的 assistant 消息元素 */
  currentAssistantEl: /** @type {HTMLElement|null} */ (null),
  /** 当前正在累积的 thought 消息元素 */
  currentThoughtEl: /** @type {HTMLElement|null} */ (null),
};

// ============================================================
// DOM 引用
// ============================================================

const dom = {
  status: /** @type {HTMLElement} */ (document.getElementById("connection-status")),
  sessionLabel: /** @type {HTMLElement} */ (document.getElementById("session-label")),
  sessionIdEl: /** @type {HTMLElement} */ (document.getElementById("session-id")),
  btnNewSession: /** @type {HTMLButtonElement} */ (document.getElementById("btn-new-session")),
  btnSettings: /** @type {HTMLButtonElement} */ (document.getElementById("btn-settings")),
  btnSend: /** @type {HTMLButtonElement} */ (document.getElementById("btn-send")),
  promptInput: /** @type {HTMLTextAreaElement} */ (document.getElementById("prompt-input")),
  messages: /** @type {HTMLElement} */ (document.getElementById("messages")),
  toolCalls: /** @type {HTMLElement} */ (document.getElementById("tool-calls")),
  modal: /** @type {HTMLElement} */ (document.getElementById("settings-modal")),
  brainUrlInput: /** @type {HTMLInputElement} */ (document.getElementById("brain-url")),
  cwdInput: /** @type {HTMLInputElement} */ (document.getElementById("brain-cwd")),
  modelInput: /** @type {HTMLInputElement} */ (document.getElementById("brain-model")),
  adminTokenInput: /** @type {HTMLInputElement} */ (document.getElementById("admin-token")),
  handToolNamesInput: /** @type {HTMLTextAreaElement} */ (document.getElementById("hand-tool-names")),
  handToolPrefixesInput: /** @type {HTMLTextAreaElement} */ (document.getElementById("hand-tool-prefixes")),
  btnConnect: /** @type {HTMLButtonElement} */ (document.getElementById("btn-connect")),
  btnCancelSettings: /** @type {HTMLButtonElement} */ (document.getElementById("btn-cancel-settings")),
};

// ============================================================
// 初始化
// ============================================================

function init() {
  loadConfig();
  loadSessionSnapshot();
  bindEvents();
  openSettingsModal();
}

function loadConfig() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const cfg = JSON.parse(saved);
      state.brainUrl = cfg.brainUrl ?? DEFAULT_BRAIN_URL;
      state.cwd = cfg.cwd ?? DEFAULT_CWD;
      state.model = cfg.model ?? DEFAULT_MODEL;
      state.handToolNames = Array.isArray(cfg.handToolNames) ? cfg.handToolNames : [];
      state.handToolPrefixes = Array.isArray(cfg.handToolPrefixes) ? cfg.handToolPrefixes : [];
    }
  } catch {
    // 忽略 localStorage 错误
  }

  dom.brainUrlInput.value = state.brainUrl;
  dom.cwdInput.value = state.cwd;
  dom.modelInput.value = state.model;
  dom.adminTokenInput.value = "";
  dom.handToolNamesInput.value = formatListForTextarea(state.handToolNames);
  dom.handToolPrefixesInput.value = formatListForTextarea(state.handToolPrefixes);
}

function saveConfig() {
  state.brainUrl = dom.brainUrlInput.value.trim() || DEFAULT_BRAIN_URL;
  state.cwd = dom.cwdInput.value.trim() || DEFAULT_CWD;
  state.model = dom.modelInput.value.trim() || DEFAULT_MODEL;
  state.adminToken = dom.adminTokenInput.value.trim();
  state.handToolNames = parseTextareaList(dom.handToolNamesInput.value);
  state.handToolPrefixes = parseTextareaList(dom.handToolPrefixesInput.value);

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      brainUrl: state.brainUrl,
      cwd: state.cwd,
      model: state.model,
      handToolNames: state.handToolNames,
      handToolPrefixes: state.handToolPrefixes,
    }));
  } catch {
    // 忽略
  }
}

function loadSessionSnapshot() {
  try {
    const saved = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!saved) {
      return;
    }

    const snapshot = JSON.parse(saved);
    if (
      snapshot &&
      snapshot.brainUrl === state.brainUrl &&
      snapshot.cwd === state.cwd &&
      snapshot.model === state.model &&
      typeof snapshot.sessionId === "string"
    ) {
      state.resumableSessionId = snapshot.sessionId;
    }
  } catch {
    // 忽略 localStorage 错误
  }
}

function saveSessionSnapshot() {
  if (!state.resumableSessionId) {
    clearSessionSnapshot();
    return;
  }

  try {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
      sessionId: state.resumableSessionId,
      brainUrl: state.brainUrl,
      cwd: state.cwd,
      model: state.model,
    }));
  } catch {
    // 忽略
  }
}

function clearSessionSnapshot() {
  state.resumableSessionId = null;
  state.restorePending = false;
  try {
    localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // 忽略
  }
}

// ============================================================
// 事件绑定
// ============================================================

function bindEvents() {
  dom.btnSettings.addEventListener("click", openSettingsModal);
  dom.btnCancelSettings.addEventListener("click", closeSettingsModal);
  dom.btnConnect.addEventListener("click", onConnectClick);

  dom.btnSend.addEventListener("click", sendPrompt);
  dom.promptInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendPrompt();
    }
  });

  dom.btnNewSession.addEventListener("click", createNewSession);

  // 点击蒙层关闭设置
  dom.modal.addEventListener("click", (e) => {
    if (e.target === dom.modal) {
      closeSettingsModal();
    }
  });
}

// ============================================================
// 设置弹层
// ============================================================

function openSettingsModal() {
  dom.modal.classList.remove("hidden");
  dom.brainUrlInput.focus();
}

function closeSettingsModal() {
  dom.modal.classList.add("hidden");
}

async function onConnectClick() {
  saveConfig();
  const synced = await syncToolRoutingConfig();
  if (!synced) {
    return;
  }
  clearSessionSnapshot();
  closeSettingsModal();
  await connectWebSocket();
}

async function syncToolRoutingConfig() {
  if (!state.adminToken) {
    if (state.handToolNames.length > 0 || state.handToolPrefixes.length > 0) {
      appendErrorMessage("要写入 Hand 工具路由，请先填写管理 Token");
      return false;
    }
    return true;
  }

  try {
    const response = await fetch("/admin/tool-routing", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${state.adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        handToolNames: state.handToolNames,
        handToolPrefixes: state.handToolPrefixes,
      }),
    });

    if (!response.ok) {
      throw new Error(`写入失败（HTTP ${response.status}）`);
    }

    const updated = await response.json();
    state.handToolNames = Array.isArray(updated.handToolNames) ? updated.handToolNames : [];
    state.handToolPrefixes = Array.isArray(updated.handToolPrefixes) ? updated.handToolPrefixes : [];
    dom.handToolNamesInput.value = formatListForTextarea(state.handToolNames);
    dom.handToolPrefixesInput.value = formatListForTextarea(state.handToolPrefixes);
    appendSystemMessage("Hand 工具路由已更新");
    return true;
  } catch (error) {
    appendErrorMessage(error instanceof Error ? error.message : String(error));
    return false;
  }
}

// ============================================================
// WebSocket 连接
// ============================================================

async function connectWebSocket(options = {}) {
  const autoReconnect = options.autoReconnect === true;
  clearReconnectTimer();

  if (state.ws) {
    state.ws.onopen = null;
    state.ws.onmessage = null;
    state.ws.onclose = null;
    state.ws.onerror = null;
    state.ws.close();
    state.ws = null;
  }

  state.shouldReconnect = true;
  setStatus("connecting");
  appendSystemMessage(autoReconnect ? "正在重新连接 Brain..." : "正在连接 Brain...");

  const ws = new WebSocket(state.brainUrl);
  state.ws = ws;

  ws.onopen = () => {
    if (state.ws !== ws) {
      return;
    }

    state.reconnectAttempts = 0;
    setStatus("connected");
    appendSystemMessage(autoReconnect ? "已重新连接" : "已连接");
    dom.btnNewSession.classList.remove("hidden");
    if (state.resumableSessionId) {
      state.restorePending = true;
      appendSystemMessage(`正在恢复会话 ${state.resumableSessionId.substring(0, 12)}...`);
      ws.send(JSON.stringify({
        type: "restore_session",
        sessionId: state.resumableSessionId,
      }));
      return;
    }
    // 自动创建 session
    void createNewSession();
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleServerMessage(msg);
    } catch (err) {
      console.error("[axon-web] 解析消息失败:", err);
    }
  };

  ws.onclose = () => {
    if (state.ws === ws) {
      state.ws = null;
    }

    setStatus("disconnected");
    state.sessionId = null;
    state.isWaiting = false;
    state.restorePending = false;
    setInputEnabled(false);
    dom.btnNewSession.classList.add("hidden");
    dom.sessionLabel.classList.add("hidden");
    dom.sessionIdEl.classList.add("hidden");
    state.currentAssistantEl = null;
    state.currentThoughtEl = null;
    appendSystemMessage("连接已断开");

    if (state.shouldReconnect) {
      scheduleReconnect();
    }
  };

  ws.onerror = () => {
    appendSystemMessage("连接错误");
    setStatus("disconnected");
  };
}

function scheduleReconnect() {
  if (state.reconnectTimer !== null || !state.shouldReconnect) {
    return;
  }

  state.reconnectAttempts += 1;
  const delayMs = Math.min(1000 * 2 ** (state.reconnectAttempts - 1), 10000);
  appendSystemMessage(`连接断开，${Math.round(delayMs / 1000)} 秒后自动重连...`);

  state.reconnectTimer = window.setTimeout(() => {
    state.reconnectTimer = null;
    void connectWebSocket({ autoReconnect: true });
  }, delayMs);
}

function clearReconnectTimer() {
  if (state.reconnectTimer !== null) {
    window.clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
}

// ============================================================
// Session 管理
// ============================================================

async function createNewSession() {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    return;
  }

  state.sessionId = null;
  clearSessionSnapshot();
  state.currentAssistantEl = null;
  state.currentThoughtEl = null;
  setInputEnabled(false);
  clearToolCalls();

  const msg = {
    type: "create_session",
    cwd: state.cwd,
    model: state.model,
  };

  state.ws.send(JSON.stringify(msg));
  appendSystemMessage("正在创建会话...");
}

// ============================================================
// 消息处理
// ============================================================

function handleServerMessage(msg) {
  switch (msg.type) {
    case "connected":
      // Brain 连接确认，忽略（由 ws.onopen 处理）
      break;

    case "session_created":
    case "session_restored":
      state.sessionId = msg.sessionId;
      state.resumableSessionId = msg.sessionId;
      state.restorePending = false;
      saveSessionSnapshot();
      dom.sessionLabel.classList.remove("hidden");
      dom.sessionIdEl.classList.remove("hidden");
      dom.sessionIdEl.textContent = msg.sessionId.substring(0, 20) + "...";
      dom.sessionIdEl.title = msg.sessionId;
      setInputEnabled(true);
      appendSystemMessage(msg.type === "session_restored" ? "Session 已恢复" : "Session 已就绪");
      break;

    case "text_chunk":
      if (msg.sessionId === state.sessionId) {
        appendTextChunk(msg.text);
      }
      break;

    case "thought_chunk":
      if (msg.sessionId === state.sessionId) {
        appendThoughtChunk(msg.text);
      }
      break;

    case "tool_call":
      if (msg.sessionId === state.sessionId) {
        // 中断当前 assistant 消息，新工具调用从新行开始
        state.currentAssistantEl = null;
        state.currentThoughtEl = null;
        showToolCall(msg.requestId, msg.toolName, "running");
      }
      break;

    case "tool_call_complete":
      if (msg.sessionId === state.sessionId) {
        updateToolCall(msg.requestId, "done");
      }
      break;

    case "session_end":
      if (msg.sessionId === state.sessionId) {
        state.currentAssistantEl = null;
        state.currentThoughtEl = null;
        state.isWaiting = false;
        setInputEnabled(true);

        if (msg.error) {
          appendErrorMessage(msg.error);
        }
        // result 已通过 text_chunk 流式展示，无需重复
      }
      break;

    case "error":
      if (state.restorePending) {
        state.restorePending = false;
        clearSessionSnapshot();
        appendSystemMessage("恢复旧会话失败，正在创建新会话...");
        void createNewSession();
        return;
      }
      appendErrorMessage(msg.message ?? "未知错误");
      state.isWaiting = false;
      setInputEnabled(true);
      break;
  }
}

// ============================================================
// 发送 Prompt
// ============================================================

function sendPrompt() {
  const text = dom.promptInput.value.trim();
  if (!text) return;
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    appendErrorMessage("未连接到 Brain");
    return;
  }
  if (!state.sessionId) {
    appendErrorMessage("Session 未就绪");
    return;
  }
  if (state.isWaiting) {
    return;
  }

  dom.promptInput.value = "";
  appendUserMessage(text);
  state.currentAssistantEl = null;
  state.currentThoughtEl = null;
  state.isWaiting = true;
  setInputEnabled(false);

  const msg = {
    type: "prompt",
    sessionId: state.sessionId,
    text,
  };
  state.ws.send(JSON.stringify(msg));
}

// ============================================================
// UI 更新
// ============================================================

function setStatus(status) {
  dom.status.textContent = {
    connected: "● 已连接",
    disconnected: "● 未连接",
    connecting: "● 连接中...",
  }[status] ?? "● 未知";

  dom.status.className = `status-${status}`;
}

function setInputEnabled(enabled) {
  dom.promptInput.disabled = !enabled;
  dom.btnSend.disabled = !enabled;
}

function appendUserMessage(text) {
  state.currentThoughtEl = null;
  const el = document.createElement("div");
  el.className = "message message-user";
  el.textContent = text;
  dom.messages.appendChild(el);
  scrollToBottom();
}

function appendTextChunk(text) {
  state.currentThoughtEl = null;
  if (!state.currentAssistantEl) {
    state.currentAssistantEl = document.createElement("div");
    state.currentAssistantEl.className = "message message-assistant";
    dom.messages.appendChild(state.currentAssistantEl);
  }
  state.currentAssistantEl.textContent += text;
  scrollToBottom();
}

function appendThoughtChunk(text) {
  state.currentAssistantEl = null;
  if (!state.currentThoughtEl) {
    state.currentThoughtEl = document.createElement("div");
    state.currentThoughtEl.className = "message message-thought";
    dom.messages.appendChild(state.currentThoughtEl);
  }
  state.currentThoughtEl.textContent += text;
  scrollToBottom();
}

function appendErrorMessage(message) {
  state.currentThoughtEl = null;
  const el = document.createElement("div");
  el.className = "message message-error";
  el.textContent = `错误: ${message}`;
  dom.messages.appendChild(el);
  scrollToBottom();
}

function appendSystemMessage(text) {
  state.currentThoughtEl = null;
  const el = document.createElement("div");
  el.className = "message message-system";
  el.textContent = text;
  dom.messages.appendChild(el);
  scrollToBottom();
}

function scrollToBottom() {
  dom.messages.scrollTop = dom.messages.scrollHeight;
}

// ---- 工具调用状态 ----

function showToolCall(requestId, toolName, status) {
  const el = document.createElement("div");
  el.className = `tool-item tool-item-${status}`;

  const nameEl = document.createElement("div");
  nameEl.className = "tool-name";
  nameEl.textContent = toolName;

  const statusEl = document.createElement("div");
  statusEl.className = `tool-status tool-status-${status}`;
  statusEl.textContent = statusLabel(status);

  el.append(nameEl, statusEl);
  dom.toolCalls.prepend(el);
  state.toolItems.set(requestId, el);
}

function updateToolCall(requestId, status) {
  const el = state.toolItems.get(requestId);
  if (!el) return;

  el.className = `tool-item tool-item-${status}`;
  const statusEl = el.querySelector(".tool-status");
  if (statusEl) {
    statusEl.className = `tool-status tool-status-${status}`;
    statusEl.textContent = statusLabel(status);
  }
}

function clearToolCalls() {
  dom.toolCalls.innerHTML = "";
  state.toolItems.clear();
}

function statusLabel(status) {
  return { running: "执行中...", done: "完成", error: "失败" }[status] ?? status;
}

function parseTextareaList(raw) {
  return raw
    .split(/\r?\n|,/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function formatListForTextarea(items) {
  return items.join("\n");
}

function registerTestHooks() {
  if (typeof window === "undefined" || window.__AXON_WEB_ENABLE_TEST_HOOKS__ !== true) {
    return;
  }

  window.__AXON_WEB_TEST_HOOKS__ = {
    state,
    dom,
    init,
    loadConfig,
    saveConfig,
    syncToolRoutingConfig,
    loadSessionSnapshot,
    saveSessionSnapshot,
    clearSessionSnapshot,
    connectWebSocket,
    createNewSession,
    handleServerMessage,
    sendPrompt,
    setStatus,
    setInputEnabled,
    appendTextChunk,
    appendThoughtChunk,
    appendErrorMessage,
    appendSystemMessage,
    showToolCall,
    updateToolCall,
    clearToolCalls,
    statusLabel,
    parseTextareaList,
    formatListForTextarea,
    scheduleReconnect,
    clearReconnectTimer,
    onConnectClick,
  };
}

// ============================================================
// 启动
// ============================================================

registerTestHooks();
document.addEventListener("DOMContentLoaded", init);
