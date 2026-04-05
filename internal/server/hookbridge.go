package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/anthropics/axon/internal/protocol"
)

// HookBridge 处理 Hook 脚本的 HTTP 回调。
type HookBridge struct {
	server *Server
}

// HookRequest 是 Hook 脚本 POST 到 Server 的请求体。
type HookRequest struct {
	SessionID string          `json:"session_id"`
	ToolName  string          `json:"tool_name"`
	ToolUseID string          `json:"tool_use_id,omitempty"`
	ToolInput json.RawMessage `json:"tool_input"`
}

// HookResponse 是 Server 返回给 Hook 脚本的响应体。
type HookResponse struct {
	HookSpecificOutput *HookSpecificOutput `json:"hookSpecificOutput"`
}

// HookSpecificOutput 是官方 hookSpecificOutput 格式。
type HookSpecificOutput struct {
	HookEventName            string `json:"hookEventName"`
	PermissionDecision       string `json:"permissionDecision"`
	PermissionDecisionReason string `json:"permissionDecisionReason"`
	AdditionalContext        string `json:"additionalContext"`
}

// ServeHTTP 处理 POST /internal/tool-call。
func (hb *HookBridge) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req HookRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf("invalid hook request: %v", err), http.StatusBadRequest)
		return
	}

	sess := hb.server.getSession(req.SessionID)
	if sess == nil {
		http.Error(w, fmt.Sprintf("session not found: %s", req.SessionID), http.StatusNotFound)
		return
	}
	if sess.hand == nil {
		http.Error(w, fmt.Sprintf("hand not connected: %s", req.SessionID), http.StatusServiceUnavailable)
		return
	}

	requestID := fmt.Sprintf("hook-%s-%d", req.SessionID, time.Now().UnixNano())
	ch := sess.relay.CreatePending(requestID, req.ToolName)

	msg := protocol.ToolCall{
		Type:      "tool_call",
		SessionID: req.SessionID,
		RequestID: requestID,
		ToolName:  req.ToolName,
		ToolUseID: req.ToolUseID,
		Input:     req.ToolInput,
	}
	if err := sess.hand.SendMessage(msg); err != nil {
		sess.relay.Reject(requestID, fmt.Errorf("发送 ToolCall 失败: %w", err))
		http.Error(w, fmt.Sprintf("hand not connected: %v", err), http.StatusServiceUnavailable)
		return
	}

	res := <-ch
	if res.err != nil {
		status := http.StatusInternalServerError
		switch {
		case errors.Is(res.err, errToolCallTimeout):
			status = http.StatusGatewayTimeout
		case strings.Contains(res.err.Error(), "超时"):
			status = http.StatusGatewayTimeout
		}
		http.Error(w, res.err.Error(), status)
		return
	}

	additionalContext := res.toolResult.Summary
	if additionalContext == "" {
		additionalContext = res.toolResult.Error
	}
	if additionalContext == "" && len(res.toolResult.Output) > 0 {
		additionalContext = string(res.toolResult.Output)
	}

	_ = sess.hand.SendMessage(protocol.ToolCallComplete{
		Type:      "tool_call_complete",
		SessionID: req.SessionID,
		RequestID: requestID,
		ToolName:  req.ToolName,
	})

	resp := HookResponse{
		HookSpecificOutput: &HookSpecificOutput{
			HookEventName:            "PreToolUse",
			PermissionDecision:       "deny",
			PermissionDecisionReason: "工具已转交远端执行",
			AdditionalContext:        additionalContext,
		},
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		http.Error(w, fmt.Sprintf("encode hook response failed: %v", err), http.StatusInternalServerError)
	}
}
