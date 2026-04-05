package claude

import "encoding/json"

// SDKMessage 是 claude -p --output-format stream-json 输出的 NDJSON 消息。
type SDKMessage struct {
	Type    string       `json:"type"`              // "system" | "assistant" | "result"
	Subtype string       `json:"subtype,omitempty"` // "init" | "success" | "error"
	Message *ChatMessage `json:"message,omitempty"`
	Result  string       `json:"result,omitempty"`
	// system/init 附加字段。
	SessionID string     `json:"session_id,omitempty"`
	Tools     []ToolSpec `json:"tools,omitempty"`
	// result 附加字段。
	StopReason string `json:"stop_reason,omitempty"`
	IsError    bool   `json:"is_error,omitempty"`
	// 保留原始 JSON 便于调试。
	Raw json.RawMessage `json:"-"`
}

// ChatMessage 是 assistant 消息体。
type ChatMessage struct {
	Role    string         `json:"role"` // "assistant"
	Content []ContentBlock `json:"content"`
}

// ContentBlock 表示消息中的内容块。
type ContentBlock struct {
	Type string `json:"type"` // "text" | "thinking" | "tool_use" | "tool_result"
	Text string `json:"text,omitempty"`
	// tool_use 字段。
	ID    string          `json:"id,omitempty"`
	Name  string          `json:"name,omitempty"`
	Input json.RawMessage `json:"input,omitempty"`
}

// ToolSpec 描述 Claude 可用工具。
type ToolSpec struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	InputSchema json.RawMessage `json:"input_schema,omitempty"`
}

// UserInput 是 --input-format stream-json 的输入。
type UserInput struct {
	Type    string      `json:"type"` // "user"
	Message UserMessage `json:"message"`
}

// UserMessage 是用户输入消息。
type UserMessage struct {
	Role    string         `json:"role"` // "user"
	Content []ContentBlock `json:"content"`
}

// NewTextInput 创建只包含文本块的用户输入。
func NewTextInput(text string) UserInput {
	return UserInput{
		Type: "user",
		Message: UserMessage{
			Role: "user",
			Content: []ContentBlock{{
				Type: "text",
				Text: text,
			}},
		},
	}
}
