package protocol

import "encoding/json"

// RemoteToolCall 是 Server -> Hand 的工具调用请求载荷。
type RemoteToolCall struct {
	ToolName  string          `json:"toolName"`
	ToolUseID string          `json:"toolUseId,omitempty"`
	Input     json.RawMessage `json:"input"`
}

// RemoteToolResult 是 Hand -> Server 的工具执行结果载荷。
type RemoteToolResult struct {
	Output  json.RawMessage `json:"output,omitempty"`  // 工具原始输出
	Summary string          `json:"summary,omitempty"` // 可读摘要，供 additionalContext 使用
	Error   string          `json:"error,omitempty"`
}
