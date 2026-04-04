package acp

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"sync"
	"sync/atomic"
)

// Request 是 JSON-RPC 2.0 请求
type Request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      any             `json:"id,omitempty"` // number or string; nil for notifications
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

// Response 是 JSON-RPC 2.0 响应
type Response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      any             `json:"id"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *RPCError       `json:"error,omitempty"`
}

// RPCError JSON-RPC 错误
type RPCError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *RPCError) Error() string {
	return fmt.Sprintf("RPC error %d: %s", e.Code, e.Message)
}

// Transport 处理 NDJSON 读写
type Transport struct {
	reader  *bufio.Scanner
	writer  io.Writer
	writeMu sync.Mutex
	nextID  atomic.Int64
}

// NewTransport 创建一个新的 NDJSON Transport
func NewTransport(r io.Reader, w io.Writer) *Transport {
	scanner := bufio.NewScanner(r)
	// 设置较大的 buffer（有些消息可能很大，如文件内容）
	scanner.Buffer(make([]byte, 0, 1024*1024), 10*1024*1024)
	return &Transport{
		reader: scanner,
		writer: w,
	}
}

// NextID 生成下一个请求 ID
func (t *Transport) NextID() int64 {
	return t.nextID.Add(1)
}

// ReadMessage 读取下一条消息（阻塞）
// 返回的 json.RawMessage 是完整的 JSON-RPC 消息
func (t *Transport) ReadMessage() (json.RawMessage, error) {
	if !t.reader.Scan() {
		if err := t.reader.Err(); err != nil {
			return nil, fmt.Errorf("read error: %w", err)
		}
		return nil, io.EOF
	}
	line := t.reader.Bytes()
	if len(line) == 0 {
		// 跳过空行，递归读取下一条
		return t.ReadMessage()
	}
	// 复制一份，因为 scanner 的 buffer 会被复用
	msg := make(json.RawMessage, len(line))
	copy(msg, line)
	return msg, nil
}

// WriteMessage 发送一条 JSON 消息（线程安全）
func (t *Transport) WriteMessage(msg any) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("marshal error: %w", err)
	}
	t.writeMu.Lock()
	defer t.writeMu.Unlock()
	_, err = fmt.Fprintf(t.writer, "%s\n", data)
	return err
}

// SendRequest 发送 JSON-RPC 请求
func (t *Transport) SendRequest(method string, params any) (int64, error) {
	id := t.NextID()
	var rawParams json.RawMessage
	if params != nil {
		var err error
		rawParams, err = json.Marshal(params)
		if err != nil {
			return 0, err
		}
	}
	req := Request{
		JSONRPC: "2.0",
		ID:      id,
		Method:  method,
		Params:  rawParams,
	}
	return id, t.WriteMessage(req)
}

// SendNotification 发送 JSON-RPC 通知（无 ID，不期望响应）
func (t *Transport) SendNotification(method string, params any) error {
	var rawParams json.RawMessage
	if params != nil {
		var err error
		rawParams, err = json.Marshal(params)
		if err != nil {
			return err
		}
	}
	req := Request{
		JSONRPC: "2.0",
		Method:  method,
		Params:  rawParams,
	}
	return t.WriteMessage(req)
}

// SendResponse 发送 JSON-RPC 响应
func (t *Transport) SendResponse(id any, result any) error {
	var rawResult json.RawMessage
	if result != nil {
		var err error
		rawResult, err = json.Marshal(result)
		if err != nil {
			return err
		}
	}
	resp := Response{
		JSONRPC: "2.0",
		ID:      id,
		Result:  rawResult,
	}
	return t.WriteMessage(resp)
}

// SendErrorResponse 发送 JSON-RPC 错误响应
func (t *Transport) SendErrorResponse(id any, code int, message string) error {
	resp := Response{
		JSONRPC: "2.0",
		ID:      id,
		Error: &RPCError{
			Code:    code,
			Message: message,
		},
	}
	return t.WriteMessage(resp)
}

// ClassifyMessage 判断消息类型
func ClassifyMessage(raw json.RawMessage) (isRequest bool, isResponse bool, err error) {
	var peek struct {
		Method string `json:"method"`
		ID     any    `json:"id"`
		Result any    `json:"result"`
		Error  any    `json:"error"`
	}
	if err := json.Unmarshal(raw, &peek); err != nil {
		return false, false, err
	}
	if peek.Method != "" {
		return true, false, nil // 请求或通知
	}
	if peek.Result != nil || peek.Error != nil {
		return false, true, nil // 响应
	}
	// 有 ID 但没有 method/result/error — 不合法，当作响应处理
	if peek.ID != nil {
		return false, true, nil
	}
	return false, false, fmt.Errorf("cannot classify message")
}
