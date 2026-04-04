package acp

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os/exec"
	"sync"
)

// Handler 处理 Claude Code 发来的 RPC 请求（文件操作、终端、权限等）
type Handler interface {
	// HandleReadTextFile 处理 fs/read_text_file
	HandleReadTextFile(ctx context.Context, params ReadTextFileParams) (*ReadTextFileResult, error)
	// HandleWriteTextFile 处理 fs/write_text_file
	HandleWriteTextFile(ctx context.Context, params WriteTextFileParams) (*WriteTextFileResult, error)
	// HandleCreateTerminal 处理 terminal/create
	HandleCreateTerminal(ctx context.Context, params CreateTerminalParams) (*CreateTerminalResult, error)
	// HandleTerminalOutput 处理 terminal/output
	HandleTerminalOutput(ctx context.Context, params TerminalOutputParams) (*TerminalOutputResult, error)
	// HandleWaitForTerminalExit 处理 terminal/wait_for_exit
	HandleWaitForTerminalExit(ctx context.Context, params WaitForTerminalExitParams) (*WaitForTerminalExitResult, error)
	// HandleKillTerminal 处理 terminal/kill
	HandleKillTerminal(ctx context.Context, params KillTerminalParams) error
	// HandleReleaseTerminal 处理 terminal/release
	HandleReleaseTerminal(ctx context.Context, params ReleaseTerminalParams) error
	// HandleRequestPermission 处理 session/request_permission
	HandleRequestPermission(ctx context.Context, params RequestPermissionParams) (*RequestPermissionResult, error)
	// HandleSessionUpdate 处理 session/update 通知
	HandleSessionUpdate(ctx context.Context, params SessionUpdateParams)
}

// Client 管理 claude CLI 子进程和 ACP 通信
type Client struct {
	cmd        *exec.Cmd
	transport  *Transport
	handler    Handler
	stderrPipe io.ReadCloser

	// 等待响应的 pending requests
	pending   map[int64]chan *Response
	pendingMu sync.Mutex

	ctx    context.Context
	cancel context.CancelFunc
	done   chan struct{}
}

// ClientConfig 客户端配置
type ClientConfig struct {
	// ClaudePath claude CLI 的路径（默认 "claude"）
	ClaudePath string
	// Model 默认模型
	Model string
}

// NewClient 创建并启动 claude CLI 子进程
func NewClient(ctx context.Context, handler Handler, cfg ClientConfig) (*Client, error) {
	claudePath := cfg.ClaudePath
	if claudePath == "" {
		claudePath = "claude"
	}

	args := []string{
		"--input-format", "stream-json",
		"--output-format", "stream-json",
	}
	if cfg.Model != "" {
		args = append(args, "--model", cfg.Model)
	}

	cmd := exec.CommandContext(ctx, claudePath, args...)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("stdout pipe: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, fmt.Errorf("stderr pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start claude: %w", err)
	}

	clientCtx, cancel := context.WithCancel(ctx)

	c := &Client{
		cmd:        cmd,
		transport:  NewTransport(stdout, stdin),
		handler:    handler,
		stderrPipe: stderr,
		pending:    make(map[int64]chan *Response),
		ctx:        clientCtx,
		cancel:     cancel,
		done:       make(chan struct{}),
	}

	// 启动消息读取循环
	go c.readLoop()
	// 启动 stderr 日志输出
	go c.logStderr()

	return c, nil
}

// Initialize 执行 ACP 协议握手
func (c *Client) Initialize() (*InitializeResult, error) {
	params := InitializeParams{
		ProtocolVersion: ProtocolVersion,
		ClientCapabilities: ClientCapabilities{
			TextFiles:   true,
			Terminals:   true,
			Permissions: true,
		},
	}

	resp, err := c.call("initialize", params)
	if err != nil {
		return nil, err
	}

	var result InitializeResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		return nil, fmt.Errorf("unmarshal initialize result: %w", err)
	}
	return &result, nil
}

// NewSession 创建新会话
func (c *Client) NewSession(cwd string) (*NewSessionResult, error) {
	params := NewSessionParams{
		CWD: cwd,
	}

	resp, err := c.call("session/new", params)
	if err != nil {
		return nil, err
	}

	var result NewSessionResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		return nil, fmt.Errorf("unmarshal session/new result: %w", err)
	}
	return &result, nil
}

// Prompt 发送 prompt（阻塞直到完成）
func (c *Client) Prompt(sessionID string, text string) (*PromptResult, error) {
	params := PromptParams{
		SessionID: sessionID,
		Prompt: []PromptPart{
			{Type: "text", Text: text},
		},
	}

	resp, err := c.call("session/prompt", params)
	if err != nil {
		return nil, err
	}

	var result PromptResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		return nil, fmt.Errorf("unmarshal prompt result: %w", err)
	}
	return &result, nil
}

// Cancel 取消正在执行的 prompt
func (c *Client) Cancel(sessionID string) error {
	_, err := c.call("session/cancel", CancelParams{SessionID: sessionID})
	return err
}

// Close 关闭子进程
func (c *Client) Close() error {
	c.cancel()
	// 等待读取循环结束
	<-c.done
	return c.cmd.Wait()
}

// call 发送请求并等待响应
func (c *Client) call(method string, params any) (*Response, error) {
	// 先注册 pending channel，再发送请求
	// 防止 claude CLI 回复极快时 readLoop 找不到 pending channel
	id := c.transport.NextID()
	ch := make(chan *Response, 1)
	c.pendingMu.Lock()
	c.pending[id] = ch
	c.pendingMu.Unlock()

	var rawParams json.RawMessage
	if params != nil {
		var err error
		rawParams, err = json.Marshal(params)
		if err != nil {
			c.pendingMu.Lock()
			delete(c.pending, id)
			c.pendingMu.Unlock()
			return nil, fmt.Errorf("marshal %s params: %w", method, err)
		}
	}
	req := Request{
		JSONRPC: "2.0",
		ID:      id,
		Method:  method,
		Params:  rawParams,
	}
	if err := c.transport.WriteMessage(req); err != nil {
		c.pendingMu.Lock()
		delete(c.pending, id)
		c.pendingMu.Unlock()
		return nil, fmt.Errorf("send %s: %w", method, err)
	}

	select {
	case resp := <-ch:
		if resp.Error != nil {
			return nil, resp.Error
		}
		return resp, nil
	case <-c.ctx.Done():
		c.pendingMu.Lock()
		delete(c.pending, id)
		c.pendingMu.Unlock()
		return nil, c.ctx.Err()
	}
}

// readLoop 持续读取 claude CLI 的 stdout
func (c *Client) readLoop() {
	defer close(c.done)

	for {
		raw, err := c.transport.ReadMessage()
		if err != nil {
			if err == io.EOF || c.ctx.Err() != nil {
				return
			}
			log.Printf("[ACP] 读取消息错误: %v", err)
			return
		}

		isReq, isResp, err := ClassifyMessage(raw)
		if err != nil {
			log.Printf("[ACP] 消息分类错误: %v", err)
			continue
		}

		if isResp {
			c.handleResponse(raw)
		} else if isReq {
			c.handleIncomingRequest(raw)
		}
	}
}

// handleResponse 处理 Claude Code 返回的响应
func (c *Client) handleResponse(raw json.RawMessage) {
	var resp Response
	if err := json.Unmarshal(raw, &resp); err != nil {
		log.Printf("[ACP] 解析响应错误: %v", err)
		return
	}

	// 提取 numeric ID
	id, ok := extractNumericID(resp.ID)
	if !ok {
		log.Printf("[ACP] 响应 ID 非数字: %v", resp.ID)
		return
	}

	c.pendingMu.Lock()
	ch, exists := c.pending[id]
	if exists {
		delete(c.pending, id)
	}
	c.pendingMu.Unlock()

	if exists {
		ch <- &resp
	}
}

// handleIncomingRequest 处理 Claude Code 发来的请求
func (c *Client) handleIncomingRequest(raw json.RawMessage) {
	var req Request
	if err := json.Unmarshal(raw, &req); err != nil {
		log.Printf("[ACP] 解析请求错误: %v", err)
		return
	}

	// 通知（无 ID）不需要响应
	if req.ID == nil {
		c.handleNotification(req)
		return
	}

	// 需要响应的请求
	go c.dispatchRequest(req)
}

// handleNotification 处理通知
func (c *Client) handleNotification(req Request) {
	switch req.Method {
	case "session/update":
		var params SessionUpdateParams
		if err := json.Unmarshal(req.Params, &params); err != nil {
			log.Printf("[ACP] 解析 session/update 参数错误: %v", err)
			return
		}
		c.handler.HandleSessionUpdate(c.ctx, params)
	default:
		log.Printf("[ACP] 未知通知: %s", req.Method)
	}
}

// dispatchRequest 分发请求到 handler
func (c *Client) dispatchRequest(req Request) {
	var result any
	var err error

	switch req.Method {
	case "fs/read_text_file":
		var params ReadTextFileParams
		if e := json.Unmarshal(req.Params, &params); e != nil {
			_ = c.transport.SendErrorResponse(req.ID, -32602, "invalid params")
			return
		}
		result, err = c.handler.HandleReadTextFile(c.ctx, params)

	case "fs/write_text_file":
		var params WriteTextFileParams
		if e := json.Unmarshal(req.Params, &params); e != nil {
			_ = c.transport.SendErrorResponse(req.ID, -32602, "invalid params")
			return
		}
		result, err = c.handler.HandleWriteTextFile(c.ctx, params)

	case "terminal/create":
		var params CreateTerminalParams
		if e := json.Unmarshal(req.Params, &params); e != nil {
			_ = c.transport.SendErrorResponse(req.ID, -32602, "invalid params")
			return
		}
		result, err = c.handler.HandleCreateTerminal(c.ctx, params)

	case "terminal/output":
		var params TerminalOutputParams
		if e := json.Unmarshal(req.Params, &params); e != nil {
			_ = c.transport.SendErrorResponse(req.ID, -32602, "invalid params")
			return
		}
		result, err = c.handler.HandleTerminalOutput(c.ctx, params)

	case "terminal/wait_for_exit":
		var params WaitForTerminalExitParams
		if e := json.Unmarshal(req.Params, &params); e != nil {
			_ = c.transport.SendErrorResponse(req.ID, -32602, "invalid params")
			return
		}
		result, err = c.handler.HandleWaitForTerminalExit(c.ctx, params)

	case "terminal/kill":
		var params KillTerminalParams
		if e := json.Unmarshal(req.Params, &params); e != nil {
			_ = c.transport.SendErrorResponse(req.ID, -32602, "invalid params")
			return
		}
		err = c.handler.HandleKillTerminal(c.ctx, params)
		if err == nil {
			result = struct{}{}
		}

	case "terminal/release":
		var params ReleaseTerminalParams
		if e := json.Unmarshal(req.Params, &params); e != nil {
			_ = c.transport.SendErrorResponse(req.ID, -32602, "invalid params")
			return
		}
		err = c.handler.HandleReleaseTerminal(c.ctx, params)
		if err == nil {
			result = struct{}{}
		}

	case "session/request_permission":
		var params RequestPermissionParams
		if e := json.Unmarshal(req.Params, &params); e != nil {
			_ = c.transport.SendErrorResponse(req.ID, -32602, "invalid params")
			return
		}
		result, err = c.handler.HandleRequestPermission(c.ctx, params)

	default:
		_ = c.transport.SendErrorResponse(req.ID, -32601, fmt.Sprintf("method not found: %s", req.Method))
		return
	}

	if err != nil {
		_ = c.transport.SendErrorResponse(req.ID, -32000, err.Error())
		return
	}
	_ = c.transport.SendResponse(req.ID, result)
}

// logStderr 将 Claude Code 的 stderr 输出到日志
func (c *Client) logStderr() {
	scanner := bufio.NewScanner(c.stderrPipe)
	scanner.Buffer(make([]byte, 0, 64*1024), 256*1024)
	for scanner.Scan() {
		log.Printf("[claude stderr] %s", scanner.Text())
	}
}

// extractNumericID 从 JSON-RPC ID 中提取数字
func extractNumericID(id any) (int64, bool) {
	switch v := id.(type) {
	case float64:
		return int64(v), true
	case int64:
		return v, true
	case json.Number:
		n, err := v.Int64()
		return n, err == nil
	default:
		return 0, false
	}
}
