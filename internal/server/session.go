package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/anthropics/axon/internal/claude"
	"github.com/anthropics/axon/internal/protocol"
)

// HandConn 是与 Hand 的 WebSocket 连接接口。
type HandConn interface {
	SendMessage(msg any) error
}

// BrainSession 封装一个 Claude Code 会话。
type BrainSession struct {
	id           string
	cwd          string
	model        string
	internalAddr string
	status       string
	createdAt    time.Time

	claude       *claude.Client
	hand         HandConn
	relay        *ToolRelay
	settingsPath string

	mu       sync.Mutex
	promptMu sync.Mutex
}

// NewBrainSession 创建并初始化一个 BrainSession。
func NewBrainSession(ctx context.Context, id, cwd, model, claudePath, internalAddr string, hand HandConn) (*BrainSession, error) {
	s := &BrainSession{
		id:           id,
		cwd:          cwd,
		model:        model,
		internalAddr: internalAddr,
		status:       "idle",
		createdAt:    time.Now(),
		hand:         hand,
		relay:        NewToolRelay(),
	}

	settingsPath, err := s.writeSettingsFile()
	if err != nil {
		return nil, fmt.Errorf("生成 session hook 配置失败: %w", err)
	}
	s.settingsPath = settingsPath

	client, err := claude.NewClient(ctx, claude.Config{
		ClaudePath: claudePath,
		Model:      model,
		CWD:        cwd,
	})
	if err != nil {
		s.cleanupSettingsFile()
		return nil, fmt.Errorf("启动 Claude Client 失败: %w", err)
	}

	s.claude = client
	return s, nil
}

// ID 返回会话 ID。
func (s *BrainSession) ID() string { return s.id }

// Status 返回当前状态。
func (s *BrainSession) Status() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.status
}

// Info 返回会话信息。
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

// Prompt 向 Claude 发送 prompt 并消费 stream-json 输出。
func (s *BrainSession) Prompt(text string) {
	s.promptMu.Lock()
	defer s.promptMu.Unlock()

	s.mu.Lock()
	s.status = "active"
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		if s.status != "ended" {
			s.status = "idle"
		}
		s.mu.Unlock()
	}()

	if err := s.claude.SendUserMessage(text); err != nil {
		s.sendSessionEnd("", err)
		return
	}

	err := s.claude.ReadMessages(func(msg claude.SDKMessage) {
		switch msg.Type {
		case "assistant":
			s.handleAssistantMessage(msg)
		case "result":
			s.handleResultMessage(msg)
		}
	})
	if err != nil {
		s.sendSessionEnd("", err)
	}
}

// Close 关闭会话资源。
func (s *BrainSession) Close() {
	s.mu.Lock()
	s.status = "ended"
	s.mu.Unlock()

	s.relay.Cleanup()

	if s.claude != nil {
		if err := s.claude.Close(); err != nil {
			log.Printf("[Session %s] 关闭 Claude Client 错误: %v", s.id, err)
		}
	}

	s.cleanupSettingsFile()
}

// handleAssistantMessage 将 assistant 内容块转发给 Hand。
func (s *BrainSession) handleAssistantMessage(msg claude.SDKMessage) {
	if msg.Message == nil {
		return
	}

	for _, block := range msg.Message.Content {
		switch block.Type {
		case "text":
			if block.Text == "" {
				continue
			}
			if err := s.hand.SendMessage(protocol.TextChunk{
				Type:      "text_chunk",
				SessionID: s.id,
				Text:      block.Text,
			}); err != nil {
				log.Printf("[Session %s] 发送 TextChunk 失败: %v", s.id, err)
			}
		case "thinking":
			if block.Text == "" {
				continue
			}
			if err := s.hand.SendMessage(protocol.ThoughtChunk{
				Type:      "thought_chunk",
				SessionID: s.id,
				Text:      block.Text,
			}); err != nil {
				log.Printf("[Session %s] 发送 ThoughtChunk 失败: %v", s.id, err)
			}
		}
	}
}

// handleResultMessage 处理 result 消息。
func (s *BrainSession) handleResultMessage(msg claude.SDKMessage) {
	if msg.IsError {
		errText := strings.TrimSpace(msg.Result)
		if errText == "" {
			errText = strings.TrimSpace(msg.StopReason)
		}
		s.sendSessionEnd("", fmt.Errorf("%s", errText))
		return
	}

	result := strings.TrimSpace(msg.StopReason)
	if result == "" {
		result = strings.TrimSpace(msg.Result)
	}
	s.sendSessionEnd(result, nil)
}

// sendSessionEnd 向 Hand 发送会话结束消息。
func (s *BrainSession) sendSessionEnd(result string, err error) {
	msg := protocol.SessionEnd{
		Type:      "session_end",
		SessionID: s.id,
		Result:    result,
	}
	if err != nil {
		msg.Error = err.Error()
		msg.Result = ""
	}
	if sendErr := s.hand.SendMessage(msg); sendErr != nil {
		log.Printf("[Session %s] 发送 SessionEnd 失败: %v", s.id, sendErr)
	}
}

// writeSettingsFile 为当前 session 生成 hook 配置。
func (s *BrainSession) writeSettingsFile() (string, error) {
	dispatchPath, err := resolveDispatchScriptPath()
	if err != nil {
		return "", err
	}

	settingsDir := filepath.Join(s.cwd, ".claude")
	if err := os.MkdirAll(settingsDir, 0o755); err != nil {
		return "", fmt.Errorf("创建 .claude 目录失败: %w", err)
	}

	settingsPath := filepath.Join(settingsDir, "settings.local.json")
	command := fmt.Sprintf(
		"AXON_CALLBACK_URL=%s AXON_SESSION_ID=%s %s",
		shellQuote("http://"+s.internalAddr+"/internal/tool-call"),
		shellQuote(s.id),
		shellQuote(dispatchPath),
	)

	payload := map[string]any{
		"hooks": map[string]any{
			"PreToolUse": []map[string]any{
				{
					"matcher": ".*",
					"hooks": []map[string]any{
						{
							"type":    "command",
							"command": command,
						},
					},
				},
			},
		},
	}

	data, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return "", fmt.Errorf("序列化 settings.local.json 失败: %w", err)
	}
	data = append(data, '\n')

	if err := os.WriteFile(settingsPath, data, 0o644); err != nil {
		return "", fmt.Errorf("写入 settings.local.json 失败: %w", err)
	}
	return settingsPath, nil
}

// cleanupSettingsFile 删除 session 生成的 settings 文件。
func (s *BrainSession) cleanupSettingsFile() {
	if s.settingsPath == "" {
		return
	}
	if err := os.Remove(s.settingsPath); err != nil && !os.IsNotExist(err) {
		log.Printf("[Session %s] 删除 settings.local.json 失败: %v", s.id, err)
	}
}

// resolveDispatchScriptPath 查找 proxy/dispatch.sh 的绝对路径。
func resolveDispatchScriptPath() (string, error) {
	candidates := make([]string, 0, 4)

	if exePath, err := os.Executable(); err == nil {
		exeDir := filepath.Dir(exePath)
		candidates = append(candidates,
			filepath.Join(exeDir, "proxy", "dispatch.sh"),
			filepath.Join(exeDir, "..", "proxy", "dispatch.sh"),
		)
	}
	if wd, err := os.Getwd(); err == nil {
		candidates = append(candidates, filepath.Join(wd, "proxy", "dispatch.sh"))
	}

	for _, candidate := range candidates {
		absPath, err := filepath.Abs(candidate)
		if err != nil {
			continue
		}
		info, err := os.Stat(absPath)
		if err == nil && !info.IsDir() {
			return absPath, nil
		}
	}

	return "", fmt.Errorf("未找到 proxy/dispatch.sh")
}

// shellQuote 生成可安全拼接到 shell 命令里的单引号字符串。
func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'"'"'`) + "'"
}
