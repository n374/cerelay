package hand

import (
	"encoding/json"
	"fmt"
	"sync"

	"github.com/anthropics/axon/internal/protocol"
	"github.com/gorilla/websocket"
)

// Client 连接 Axon Server 并处理消息
type Client struct {
	serverURL string
	conn      *websocket.Conn
	writeMu   sync.Mutex
	executor  *Executor
	ui        *UI

	// 当前活跃的 session
	sessionID string
}

// NewClient 创建 Client
func NewClient(serverURL string) *Client {
	return &Client{
		serverURL: serverURL,
		executor:  NewExecutor(),
		ui:        &UI{},
	}
}

// Connect 连接到 Server
func (c *Client) Connect() error {
	conn, _, err := websocket.DefaultDialer.Dial(c.serverURL, nil)
	if err != nil {
		return fmt.Errorf("连接 %s 失败: %w", c.serverURL, err)
	}
	c.conn = conn
	return nil
}

// Close 关闭连接
func (c *Client) Close() error {
	if c.conn != nil {
		return c.conn.Close()
	}
	return nil
}

// SendCreateSession 发送 create_session 并等待 session_created 响应
func (c *Client) SendCreateSession(cwd string) error {
	msg := protocol.CreateSession{
		Type: "create_session",
		CWD:  cwd,
	}
	if err := c.writeJSON(msg); err != nil {
		return fmt.Errorf("发送 create_session: %w", err)
	}

	// 等待 session_created
	for {
		raw, err := c.readRaw()
		if err != nil {
			return fmt.Errorf("等待 session_created: %w", err)
		}
		var env protocol.Envelope
		if err := json.Unmarshal(raw, &env); err != nil {
			continue
		}
		switch env.Type {
		case "session_created":
			var resp protocol.CreateSessionResponse
			if err := json.Unmarshal(raw, &resp); err != nil {
				return fmt.Errorf("解析 session_created: %w", err)
			}
			c.sessionID = resp.SessionID
			fmt.Printf("\033[36m[已连接] Session: %s\033[0m\n", c.sessionID)
			return nil
		case "connected":
			// 忽略 connected 通知，继续等待
		case "error":
			var e protocol.ServerError
			_ = json.Unmarshal(raw, &e)
			return fmt.Errorf("服务器错误: %s", e.Message)
		}
	}
}

// SendPrompt 发送用户 prompt
func (c *Client) SendPrompt(text string) error {
	msg := protocol.Prompt{
		Type:      "prompt",
		SessionID: c.sessionID,
		Text:      text,
	}
	return c.writeJSON(msg)
}

// Run 主消息循环（阻塞）
// 一个 goroutine 读 WS 消息并处理/显示；外部通过 promptCh 发送新 prompt。
func (c *Client) Run() error {
	errCh := make(chan error, 1)

	go func() {
		for {
			raw, err := c.readRaw()
			if err != nil {
				errCh <- err
				return
			}
			if done := c.handleMessage(raw); done {
				errCh <- nil
				return
			}
		}
	}()

	return <-errCh
}

// handleMessage 处理单条消息，返回 true 表示会话结束
func (c *Client) handleMessage(raw []byte) bool {
	var env protocol.Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		c.ui.PrintError(fmt.Sprintf("解析消息失败: %v", err))
		return false
	}

	switch env.Type {
	case "text_chunk":
		var msg protocol.TextChunk
		if err := json.Unmarshal(raw, &msg); err == nil {
			c.ui.PrintText(msg.Text)
		}

	case "thought_chunk":
		var msg protocol.ThoughtChunk
		if err := json.Unmarshal(raw, &msg); err == nil {
			c.ui.PrintThought(msg.Text)
		}

	case "tool_call":
		var msg protocol.ToolCall
		if err := json.Unmarshal(raw, &msg); err != nil {
			c.ui.PrintError(fmt.Sprintf("解析 tool_call 失败: %v", err))
			return false
		}
		c.ui.PrintToolCall(msg.ToolName, nil)
		go c.executeToolCall(msg)

	case "session_end":
		var msg protocol.SessionEnd
		if err := json.Unmarshal(raw, &msg); err == nil {
			c.ui.PrintSessionEnd(msg.Result, msg.Error)
		}
		return true

	case "error":
		var msg protocol.ServerError
		if err := json.Unmarshal(raw, &msg); err == nil {
			c.ui.PrintError(msg.Message)
		}
	}
	return false
}

// executeToolCall 在 goroutine 中执行工具调用并发回结果
func (c *Client) executeToolCall(msg protocol.ToolCall) {
	result, err := c.executor.Execute(msg.ToolName, msg.Input)
	if err != nil {
		c.ui.PrintToolResult(msg.ToolName, false)
		c.sendToolError(msg, err)
		return
	}

	output, err := json.Marshal(result)
	if err != nil {
		c.ui.PrintToolResult(msg.ToolName, false)
		c.sendToolError(msg, fmt.Errorf("序列化 output 失败: %w", err))
		return
	}

	c.ui.PrintToolResult(msg.ToolName, true)
	resp := protocol.ToolResult{
		Type:      "tool_result",
		SessionID: msg.SessionID,
		RequestID: msg.RequestID,
		Output:    output,
		Summary:   summarizeToolResult(msg.ToolName, result),
	}
	if writeErr := c.writeJSON(resp); writeErr != nil {
		c.ui.PrintError(fmt.Sprintf("发送 tool_result 失败: %v", writeErr))
	}
}

func (c *Client) sendToolError(msg protocol.ToolCall, err error) {
	resp := protocol.ToolResult{
		Type:      "tool_result",
		SessionID: msg.SessionID,
		RequestID: msg.RequestID,
		Error:     formatToolError(err),
	}
	if writeErr := c.writeJSON(resp); writeErr != nil {
		c.ui.PrintError(fmt.Sprintf("发送 tool_result(error) 失败: %v", writeErr))
	}
}

// summarizeToolResult 生成给 Hook additionalContext 使用的简短摘要。
func summarizeToolResult(toolName string, result any) string {
	switch v := result.(type) {
	case *readOutput:
		return fmt.Sprintf("Read 成功，返回 %d 字符", len([]rune(v.Content)))
	case *pathOutput:
		return fmt.Sprintf("%s 成功: %s", toolName, v.Path)
	case *bashOutput:
		return fmt.Sprintf("Bash 完成，exit_code=%d, stdout=%dB, stderr=%dB", v.ExitCode, len(v.Stdout), len(v.Stderr))
	case *grepOutput:
		return fmt.Sprintf("Grep 完成，匹配 %d 项", len(v.Matches))
	case *globOutput:
		return fmt.Sprintf("Glob 完成，匹配 %d 个路径", len(v.Files))
	default:
		return toolName + " 执行成功"
	}
}

// formatToolError 将结构化错误压平成字符串，便于跨进程传输。
func formatToolError(err error) string {
	if err == nil {
		return ""
	}
	if toolErr, ok := err.(*ToolError); ok {
		data, marshalErr := json.Marshal(toolErr)
		if marshalErr == nil {
			return string(data)
		}
	}
	return err.Error()
}

// --- 底层 IO（线程安全） ---

func (c *Client) writeJSON(v any) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return c.conn.WriteJSON(v)
}

func (c *Client) readRaw() ([]byte, error) {
	_, data, err := c.conn.ReadMessage()
	return data, err
}
