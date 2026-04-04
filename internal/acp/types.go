package acp

// ============================================================================
// ACP 协议常量和类型
// ============================================================================

const ProtocolVersion = 1

// --- Initialize ---

type InitializeParams struct {
	ProtocolVersion    int                `json:"protocolVersion"`
	ClientCapabilities ClientCapabilities `json:"clientCapabilities"`
}

type ClientCapabilities struct {
	// 声明 Client 支持的能力
	TextFiles   bool `json:"textFiles,omitempty"`
	Terminals   bool `json:"terminals,omitempty"`
	Permissions bool `json:"permissions,omitempty"`
}

type InitializeResult struct {
	ProtocolVersion   int               `json:"protocolVersion"`
	AgentCapabilities AgentCapabilities `json:"agentCapabilities"`
}

type AgentCapabilities struct {
	// Agent 声明的能力
}

// --- Session ---

type NewSessionParams struct {
	CWD        string      `json:"cwd"`
	MCPServers []MCPServer `json:"mcpServers,omitempty"`
}

type MCPServer struct {
	Name string `json:"name"`
	// ... 其他字段按需扩展
}

type NewSessionResult struct {
	SessionID string `json:"sessionId"`
}

type PromptParams struct {
	SessionID string       `json:"sessionId"`
	Prompt    []PromptPart `json:"prompt"`
}

type PromptPart struct {
	Type string `json:"type"` // "text"
	Text string `json:"text,omitempty"`
}

type PromptResult struct {
	StopReason string `json:"stopReason"`
}

type CancelParams struct {
	SessionID string `json:"sessionId"`
}

// --- Session Update (Agent -> Client 通知) ---

type SessionUpdateParams struct {
	SessionID string       `json:"sessionId"`
	Update    SessionEvent `json:"update"`
}

// SessionEvent 是 session/update 中的事件
type SessionEvent struct {
	// 公共字段
	SessionUpdate string `json:"sessionUpdate"` // 事件类型

	// agent_message_chunk
	Content *MessageContent `json:"content,omitempty"`

	// agent_thought_chunk
	Thinking string `json:"thinking,omitempty"`

	// tool_call
	ToolCall *ToolCallInfo `json:"toolCall,omitempty"`

	// tool_call_update
	ToolCallUpdate *ToolCallUpdateInfo `json:"toolCallUpdate,omitempty"`
}

type MessageContent struct {
	Type string `json:"type"` // "text", "image"
	Text string `json:"text,omitempty"`
}

type ToolCallInfo struct {
	ToolUseID string `json:"toolUseId"`
	ToolName  string `json:"toolName"`
	Status    string `json:"status"` // "pending", "completed", "error"
	Input     any    `json:"input,omitempty"`
	Output    string `json:"output,omitempty"`
}

type ToolCallUpdateInfo struct {
	ToolUseID string `json:"toolUseId"`
	Status    string `json:"status"`
	Output    string `json:"output,omitempty"`
}

// --- Client-side methods (Agent -> Client requests) ---

// fs/read_text_file
type ReadTextFileParams struct {
	Path string `json:"path"`
}

type ReadTextFileResult struct {
	Content string `json:"content"`
}

// fs/write_text_file
type WriteTextFileParams struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

type WriteTextFileResult struct {
	Success bool `json:"success"`
}

// terminal/create
type CreateTerminalParams struct {
	Command string   `json:"command"`
	Args    []string `json:"args,omitempty"`
	CWD     string   `json:"cwd,omitempty"`
}

type CreateTerminalResult struct {
	TerminalID string `json:"terminalId"`
}

// terminal/output
type TerminalOutputParams struct {
	TerminalID string `json:"terminalId"`
}

type TerminalOutputResult struct {
	Output string `json:"output"`
}

// terminal/wait_for_exit
type WaitForTerminalExitParams struct {
	TerminalID string `json:"terminalId"`
}

type WaitForTerminalExitResult struct {
	ExitCode int    `json:"exitCode"`
	Output   string `json:"output,omitempty"`
}

// terminal/kill
type KillTerminalParams struct {
	TerminalID string `json:"terminalId"`
}

// terminal/release
type ReleaseTerminalParams struct {
	TerminalID string `json:"terminalId"`
}

// session/request_permission
type RequestPermissionParams struct {
	SessionID string             `json:"sessionId"`
	ToolName  string             `json:"toolName"`
	Input     any                `json:"input,omitempty"`
	Options   []PermissionOption `json:"options"`
}

type PermissionOption struct {
	OptionID string `json:"optionId"`
	Label    string `json:"label"`
}

type RequestPermissionResult struct {
	Outcome PermissionOutcome `json:"outcome"`
}

type PermissionOutcome struct {
	Outcome  string `json:"outcome"` // "selected", "dismissed"
	OptionID string `json:"optionId,omitempty"`
}
