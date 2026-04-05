package server

import (
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/anthropics/axon/internal/protocol"
)

const defaultToolTimeout = 120 * time.Second

var errToolCallTimeout = errors.New("等待工具结果超时")

// callResult 保存工具调用结果
type callResult struct {
	toolResult protocol.RemoteToolResult
	err        error
}

// pendingCall 表示一个等待 Hand 回复的工具调用
type pendingCall struct {
	ch       chan callResult
	done     chan struct{} // 通知超时 goroutine 已被 Resolve/Reject
	toolName string
	created  time.Time
}

// ToolRelay 管理 pending 的工具调用：
// Hook 回调 → CreatePending → 等 Hand WS 返回 → Resolve/Reject
type ToolRelay struct {
	pending map[string]*pendingCall
	mu      sync.Mutex
}

// NewToolRelay 创建一个新的 ToolRelay
func NewToolRelay() *ToolRelay {
	return &ToolRelay{
		pending: make(map[string]*pendingCall),
	}
}

// CreatePending 注册一个 pending 调用，返回接收结果的 channel
func (r *ToolRelay) CreatePending(requestID, toolName string) chan callResult {
	ch := make(chan callResult, 1)
	done := make(chan struct{})
	r.mu.Lock()
	r.pending[requestID] = &pendingCall{
		ch:       ch,
		done:     done,
		toolName: toolName,
		created:  time.Now(),
	}
	r.mu.Unlock()

	// 启动超时 goroutine
	go func() {
		timer := time.NewTimer(defaultToolTimeout)
		defer timer.Stop()
		select {
		case <-timer.C:
			r.Reject(requestID, fmt.Errorf("%w（requestID=%s, toolName=%s）", errToolCallTimeout, requestID, toolName))
		case <-done:
			// 已被 Resolve/Reject 处理
		}
	}()

	return ch
}

// Resolve 用成功结果完成一个 pending 调用
func (r *ToolRelay) Resolve(requestID string, result protocol.RemoteToolResult) {
	r.mu.Lock()
	call, ok := r.pending[requestID]
	if ok {
		delete(r.pending, requestID)
	}
	r.mu.Unlock()

	if ok {
		call.ch <- callResult{toolResult: result}
		close(call.done)
	}
}

// Reject 用错误完成一个 pending 调用
func (r *ToolRelay) Reject(requestID string, err error) {
	r.mu.Lock()
	call, ok := r.pending[requestID]
	if ok {
		delete(r.pending, requestID)
	}
	r.mu.Unlock()

	if ok {
		call.ch <- callResult{err: err}
		close(call.done)
	}
}

// Cleanup 关闭时 reject 所有 pending 调用
func (r *ToolRelay) Cleanup() {
	r.mu.Lock()
	calls := make(map[string]*pendingCall, len(r.pending))
	for k, v := range r.pending {
		calls[k] = v
	}
	r.pending = make(map[string]*pendingCall)
	r.mu.Unlock()

	for _, call := range calls {
		call.ch <- callResult{err: fmt.Errorf("会话已关闭")}
		close(call.done)
	}
}
