package protocol

// ============================================================================
// Hand <-> Server WebSocket 消息协议
//
// 所有消息使用 JSON 编码，通过 WebSocket 传输。
// type 字段区分消息类型。
// ============================================================================

// --- Server -> Hand 消息 ---

// TextChunk LLM 文本输出（流式）
type TextChunk struct {
	Type      string `json:"type"` // "text_chunk"
	SessionID string `json:"sessionId"`
	Text      string `json:"text"`
}

// ThoughtChunk LLM 思考过程
type ThoughtChunk struct {
	Type      string `json:"type"` // "thought_chunk"
	SessionID string `json:"sessionId"`
	Text      string `json:"text"`
}

// ToolCall 工具调用请求（需要 Hand 执行）
type ToolCall struct {
	Type      string `json:"type"` // "tool_call"
	SessionID string `json:"sessionId"`
	RequestID string `json:"requestId"`
	Method    string `json:"method"` // ACP 方法名，如 "fs/read_text_file", "terminal/create"
	Params    any    `json:"params"` // 原始 ACP 参数
}

// ToolCallComplete 工具调用完成通知
type ToolCallComplete struct {
	Type      string `json:"type"` // "tool_call_complete"
	SessionID string `json:"sessionId"`
	RequestID string `json:"requestId"`
	Method    string `json:"method"`
}

// SessionEnd 会话结束
type SessionEnd struct {
	Type      string `json:"type"` // "session_end"
	SessionID string `json:"sessionId"`
	Result    string `json:"result,omitempty"`
	Error     string `json:"error,omitempty"`
}

// ServerError 错误
type ServerError struct {
	Type      string `json:"type"` // "error"
	SessionID string `json:"sessionId,omitempty"`
	Message   string `json:"message"`
}

// Connected 连接确认
type Connected struct {
	Type      string `json:"type"` // "connected"
	SessionID string `json:"sessionId,omitempty"`
}

// --- Hand -> Server 消息 ---

// CreateSession 创建会话请求
type CreateSession struct {
	Type  string `json:"type"` // "create_session"
	CWD   string `json:"cwd"`
	Model string `json:"model,omitempty"`
}

// CreateSessionResponse 创建会话响应
type CreateSessionResponse struct {
	Type      string `json:"type"` // "session_created"
	SessionID string `json:"sessionId"`
}

// Prompt 发送 prompt
type Prompt struct {
	Type      string `json:"type"` // "prompt"
	SessionID string `json:"sessionId"`
	Text      string `json:"text"`
}

// ToolResult 工具执行结果（Hand -> Server）
type ToolResult struct {
	Type      string `json:"type"` // "tool_result"
	SessionID string `json:"sessionId"`
	RequestID string `json:"requestId"`
	Result    any    `json:"result"`         // ACP 方法的返回值
	Error     string `json:"error,omitempty"` // 错误信息（如果执行失败）
}

// ListSessions 列出会话请求
type ListSessions struct {
	Type string `json:"type"` // "list_sessions"
}

// SessionInfo 会话信息
type SessionInfo struct {
	SessionID string `json:"sessionId"`
	CWD       string `json:"cwd"`
	Model     string `json:"model,omitempty"`
	Status    string `json:"status"` // "idle", "active", "ended"
	CreatedAt string `json:"createdAt"`
}

// SessionList 会话列表响应
type SessionList struct {
	Type     string        `json:"type"` // "session_list"
	Sessions []SessionInfo `json:"sessions"`
}

// CloseSession 关闭会话请求
type CloseSession struct {
	Type      string `json:"type"` // "close_session"
	SessionID string `json:"sessionId"`
}

// Envelope 通用消息信封，用于初步解析 type 字段
type Envelope struct {
	Type string `json:"type"`
}
