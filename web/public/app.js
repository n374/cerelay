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

// ============================================================
// 状态
// ============================================================

const state = {
  ws: /** @type {WebSocket|null} */ (null),
  sessionId: /** @type {string|null} */ (null),
  brainUrl: DEFAULT_BRAIN_URL,
  cwd: DEFAULT_CWD,
  model: DEFAULT_MODEL,
  isWaiting: false, // 等待 session_end
  /** @type {Map<string, HTMLElement>} */
  toolItems: new Map(),
  /** 当前正在累积的 assistant 消息元素 */
  currentAssistantEl: /** @type {HTMLElement|null} */ (null),
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
  btnConnect: /** @type {HTMLButtonElement} */ (document.getElementById("btn-connect")),
  btnCancelSettings: /** @type {HTMLButtonElement} */ (document.getElementById("btn-cancel-settings")),
};

// ============================================================
// 初始化
// ============================================================

function init() {
  loadConfig();
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
    }
  } catch {
    // 忽略 localStorage 错误
  }

  dom.brainUrlInput.value = state.brainUrl;
  dom.cwdInput.value = state.cwd;
  dom.modelInput.value = state.model;
}

function saveConfig() {
  state.brainUrl = dom.brainUrlInput.value.trim() || DEFAULT_BRAIN_URL;
  state.cwd = dom.cwdInput.value.trim() || DEFAULT_CWD;
  state.model = dom.modelInput.value.trim() || DEFAULT_MODEL;

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      brainUrl: state.brainUrl,
      cwd: state.cwd,
      model: state.model,
    }));
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
  closeSettingsModal();
  await connectWebSocket();
}

// ============================================================
// WebSocket 连接
// ============================================================

async function connectWebSocket() {
  if (state.ws) {
    state.ws.close();
    state.ws = null;
  }

  setStatus("connecting");
  appendSystemMessage("正在连接 Brain...");

  const ws = new WebSocket(state.brainUrl);
  state.ws = ws;

  ws.onopen = () => {
    setStatus("connected");
    appendSystemMessage("已连接");
    dom.btnNewSession.classList.remove("hidden");
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
    setStatus("disconnected");
    state.sessionId = null;
    state.ws = null;
    setInputEnabled(false);
    dom.btnNewSession.classList.add("hidden");
    dom.sessionLabel.classList.add("hidden");
    dom.sessionIdEl.classList.add("hidden");
    appendSystemMessage("连接已断开");
  };

  ws.onerror = () => {
    appendSystemMessage("连接错误");
    setStatus("disconnected");
  };
}

// ============================================================
// Session 管理
// ============================================================

async function createNewSession() {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    return;
  }

  state.sessionId = null;
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
      state.sessionId = msg.sessionId;
      dom.sessionLabel.classList.remove("hidden");
      dom.sessionIdEl.classList.remove("hidden");
      dom.sessionIdEl.textContent = msg.sessionId.substring(0, 20) + "...";
      dom.sessionIdEl.title = msg.sessionId;
      setInputEnabled(true);
      appendSystemMessage(`Session 已就绪`);
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
        state.isWaiting = false;
        setInputEnabled(true);

        if (msg.error) {
          appendErrorMessage(msg.error);
        }
        // result 已通过 text_chunk 流式展示，无需重复
      }
      break;

    case "error":
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
  const el = document.createElement("div");
  el.className = "message message-user";
  el.textContent = text;
  dom.messages.appendChild(el);
  scrollToBottom();
}

function appendTextChunk(text) {
  if (!state.currentAssistantEl) {
    state.currentAssistantEl = document.createElement("div");
    state.currentAssistantEl.className = "message message-assistant";
    dom.messages.appendChild(state.currentAssistantEl);
  }
  state.currentAssistantEl.textContent += text;
  scrollToBottom();
}

function appendThoughtChunk(text) {
  // 思考内容独立展示，不合并
  const el = document.createElement("div");
  el.className = "message message-thought";
  el.textContent = text;
  dom.messages.appendChild(el);
  scrollToBottom();
}

function appendErrorMessage(message) {
  const el = document.createElement("div");
  el.className = "message message-error";
  el.textContent = `错误: ${message}`;
  dom.messages.appendChild(el);
  scrollToBottom();
}

function appendSystemMessage(text) {
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

// ============================================================
// 启动
// ============================================================

document.addEventListener("DOMContentLoaded", init);
