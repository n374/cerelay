package hand

import (
	"encoding/json"
	"fmt"
)

// ToolError 是工具执行的结构化错误。
type ToolError struct {
	Code    string `json:"code"`
	Tool    string `json:"tool"`
	Message string `json:"message"`
}

func (e *ToolError) Error() string {
	return fmt.Sprintf("%s(%s): %s", e.Code, e.Tool, e.Message)
}

// Executor 在本地执行 Claude 原生工具调用。
type Executor struct{}

// NewExecutor 创建 Executor。
func NewExecutor() *Executor {
	return &Executor{}
}

// Execute 根据工具名分发到对应本地实现。
func (e *Executor) Execute(toolName string, input json.RawMessage) (any, error) {
	switch toolName {
	case "Read":
		return e.read(input)
	case "Write":
		return e.write(input)
	case "Edit":
		return e.edit(input)
	case "MultiEdit":
		return e.multiEdit(input)
	case "Bash":
		return e.bash(input)
	case "Grep":
		return e.grep(input)
	case "Glob":
		return e.glob(input)
	default:
		return nil, &ToolError{
			Code:    "unknown_tool",
			Tool:    toolName,
			Message: fmt.Sprintf("未知工具: %s", toolName),
		}
	}
}
