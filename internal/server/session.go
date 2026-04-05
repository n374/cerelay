package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/anthropics/axon/internal/acp"
	"github.com/anthropics/axon/internal/protocol"
)

// HandConn 是与 Hand 的 WebSocket 连接接口
type HandConn interface {
	SendMessage(msg any) error
}

// BrainSession 封装一个 Claude Code 会话
//
// 生命周期：
//  1. NewBrainSession → 创建会话，启动 ACP Client（claude CLI 子进程）
//  2. Prompt(text) → 异步调用，Claude Code 推理期间通过 ACP 回调发起工具调用
//  3. 工具调用通过 ToolRelay 中继给 Hand（WebSocket），等待 Hand 返回结果
//  4. Close → 关闭 ACP Client 子进程
//
// BrainSession 实现 acp.Handler，所有 ACP 回调都走 relayToHand 统一转发。
type BrainSession struct {
	id          string
	acpSessID   string // claude CLI 内部的 sessionId
	cwd         string
	model       string
	status      string // "idle", "active", "ended"
	createdAt   time.Time

	acpClient *acp.Client
	hand      HandConn
	relay     *ToolRelay

	mu sync.Mutex
}

// NewBrainSession 创建并初始化一个 BrainSession
// 会启动 claude CLI 子进程并完成 ACP 握手。
// claudePath 为空时使用默认值 "claude"。
func NewBrainSession(ctx context.Context, id, cwd, model, claudePath string, hand HandConn) (*BrainSession, error) {
	s := &BrainSession{
		id:        id,
		cwd:       cwd,
		model:     model,
		status:    "idle",
		createdAt: time.Now(),
		hand:      hand,
		relay:     NewToolRelay(),
	}

	cfg := acp.ClientConfig{
		Model:      model,
		ClaudePath: claudePath,
	}
	client, err := acp.NewClient(ctx, s, cfg)
	if err != nil {
		return nil, fmt.Errorf("启动 ACP Client 失败: %w", err)
	}

	// ACP 握手
	if _, err := client.Initialize(); err != nil {
		_ = client.Close()
		return nil, fmt.Errorf("ACP Initialize 失败: %w", err)
	}

	// 创建 claude CLI 内部会话
	sessResult, err := client.NewSession(cwd)
	if err != nil {
		_ = client.Close()
		return nil, fmt.Errorf("ACP NewSession 失败: %w", err)
	}

	s.acpClient = client
	s.acpSessID = sessResult.SessionID
	return s, nil
}

// ID 返回会话 ID
func (s *BrainSession) ID() string { return s.id }

// Status 返回当前状态
func (s *BrainSession) Status() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.status
}

// Info 返回会话信息（用于 session_list）
func (s *BrainSession) Info() protocol.SessionInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	return protocol.SessionInfo{
		SessionID: s.id,
		CWD:       s.cwd,
		Model:     s.model,
		Status:    s.status,
		CreatedAt: s.createdAt.Format(time.RFC3339),
	}
}

// Prompt 向 Claude Code 发送 prompt（阻塞直到推理完成）
// 调用方应在 goroutine 中执行
func (s *BrainSession) Prompt(text string) {
	s.mu.Lock()
	s.status = "active"
	s.mu.Unlock()

	result, err := s.acpClient.Prompt(s.acpSessID, text)

	s.mu.Lock()
	s.status = "idle"
	s.mu.Unlock()

	if err != nil {
		_ = s.hand.SendMessage(protocol.SessionEnd{
			Type:      "session_end",
			SessionID: s.id,
			Error:     err.Error(),
		})
		return
	}

	_ = s.hand.SendMessage(protocol.SessionEnd{
		Type:      "session_end",
		SessionID: s.id,
		Result:    result.StopReason,
	})
}

// Close 关闭会话（关闭 ACP Client 子进程）
func (s *BrainSession) Close() {
	s.mu.Lock()
	s.status = "ended"
	s.mu.Unlock()

	s.relay.Cleanup()
	if s.acpClient != nil {
		if err := s.acpClient.Close(); err != nil {
			log.Printf("[Session %s] 关闭 ACP Client 错误: %v", s.id, err)
		}
	}
}

// ============================================================================
// acp.Handler 实现 — 所有 ACP 回调统一通过 relayToHand 转发给 Hand
// ============================================================================

// relayToHand 将 ACP 工具调用转发给 Hand，等待 Hand 返回结果
// method 是 ACP 方法名（如 "fs/read_text_file"），params 是 ACP 参数
// 返回的 json.RawMessage 是 Hand 返回的 result 字段原始 JSON
func (s *BrainSession) relayToHand(ctx context.Context, method string, params any) (json.RawMessage, error) {
	requestID := fmt.Sprintf("%s-%d", s.id, time.Now().UnixNano())

	ch := s.relay.CreatePending(requestID, method)

	toolCall := protocol.ToolCall{
		Type:      "tool_call",
		SessionID: s.id,
		RequestID: requestID,
		Method:    method,
		Params:    params,
	}
	if err := s.hand.SendMessage(toolCall); err != nil {
		s.relay.Reject(requestID, fmt.Errorf("发送 ToolCall 失败: %w", err))
		return nil, fmt.Errorf("发送 ToolCall 到 Hand 失败: %w", err)
	}

	select {
	case res := <-ch:
		if res.err != nil {
			return nil, res.err
		}
		// 发送 tool_call_complete 通知
		_ = s.hand.SendMessage(protocol.ToolCallComplete{
			Type:      "tool_call_complete",
			SessionID: s.id,
			RequestID: requestID,
			Method:    method,
		})
		return res.result, nil
	case <-ctx.Done():
		s.relay.Reject(requestID, ctx.Err())
		return nil, ctx.Err()
	}
}

// unmarshalResult 将 json.RawMessage 反序列化到目标类型
func unmarshalResult[T any](raw json.RawMessage) (*T, error) {
	var v T
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, fmt.Errorf("反序列化结果失败: %w", err)
	}
	return &v, nil
}

func (s *BrainSession) HandleReadTextFile(ctx context.Context, params acp.ReadTextFileParams) (*acp.ReadTextFileResult, error) {
	raw, err := s.relayToHand(ctx, "fs/read_text_file", params)
	if err != nil {
		return nil, err
	}
	return unmarshalResult[acp.ReadTextFileResult](raw)
}

func (s *BrainSession) HandleWriteTextFile(ctx context.Context, params acp.WriteTextFileParams) (*acp.WriteTextFileResult, error) {
	raw, err := s.relayToHand(ctx, "fs/write_text_file", params)
	if err != nil {
		return nil, err
	}
	return unmarshalResult[acp.WriteTextFileResult](raw)
}

func (s *BrainSession) HandleCreateTerminal(ctx context.Context, params acp.CreateTerminalParams) (*acp.CreateTerminalResult, error) {
	raw, err := s.relayToHand(ctx, "terminal/create", params)
	if err != nil {
		return nil, err
	}
	return unmarshalResult[acp.CreateTerminalResult](raw)
}

func (s *BrainSession) HandleTerminalOutput(ctx context.Context, params acp.TerminalOutputParams) (*acp.TerminalOutputResult, error) {
	raw, err := s.relayToHand(ctx, "terminal/output", params)
	if err != nil {
		return nil, err
	}
	return unmarshalResult[acp.TerminalOutputResult](raw)
}

func (s *BrainSession) HandleWaitForTerminalExit(ctx context.Context, params acp.WaitForTerminalExitParams) (*acp.WaitForTerminalExitResult, error) {
	raw, err := s.relayToHand(ctx, "terminal/wait_for_exit", params)
	if err != nil {
		return nil, err
	}
	return unmarshalResult[acp.WaitForTerminalExitResult](raw)
}

func (s *BrainSession) HandleKillTerminal(ctx context.Context, params acp.KillTerminalParams) error {
	_, err := s.relayToHand(ctx, "terminal/kill", params)
	return err
}

func (s *BrainSession) HandleReleaseTerminal(ctx context.Context, params acp.ReleaseTerminalParams) error {
	_, err := s.relayToHand(ctx, "terminal/release", params)
	return err
}

func (s *BrainSession) HandleRequestPermission(ctx context.Context, params acp.RequestPermissionParams) (*acp.RequestPermissionResult, error) {
	raw, err := s.relayToHand(ctx, "session/request_permission", params)
	if err != nil {
		return nil, err
	}
	return unmarshalResult[acp.RequestPermissionResult](raw)
}

// HandleSessionUpdate 处理 session/update 通知
// agent_message_chunk → 发 TextChunk 给 Hand
// agent_thought_chunk → 发 ThoughtChunk 给 Hand
func (s *BrainSession) HandleSessionUpdate(ctx context.Context, params acp.SessionUpdateParams) {
	switch params.Update.SessionUpdate {
	case "agent_message_chunk":
		if params.Update.Content != nil && params.Update.Content.Type == "text" {
			_ = s.hand.SendMessage(protocol.TextChunk{
				Type:      "text_chunk",
				SessionID: s.id,
				Text:      params.Update.Content.Text,
			})
		}
	case "agent_thought_chunk":
		if params.Update.Thinking != "" {
			_ = s.hand.SendMessage(protocol.ThoughtChunk{
				Type:      "thought_chunk",
				SessionID: s.id,
				Text:      params.Update.Thinking,
			})
		}
	default:
		// 其他事件类型暂不处理
	}
}
