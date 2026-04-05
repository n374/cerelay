package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/anthropics/axon/internal/protocol"
	"github.com/gorilla/websocket"
)

// ============================================================================
// 测试辅助函数
// ============================================================================

// startTestServer 使用 httptest.NewServer 启动测试用 Server，避免端口冲突。
// 返回 Server 实例和 HTTP base URL（http://...）。
func startTestServer(t *testing.T) (*Server, string) {
	t.Helper()
	return startTestServerWithClaudePath(t, "")
}

// startTestServerWithClaudePath 同 startTestServer，但允许指定 claudePath。
// claudePath 为空时使用默认 "claude"；传入不存在路径可模拟 CLI 不可用场景。
func startTestServerWithClaudePath(t *testing.T, claudePath string) (*Server, string) {
	t.Helper()

	defer func() {
		if r := recover(); r != nil {
			t.Skipf("当前环境不允许监听测试端口: %v", r)
		}
	}()

	s := NewServer(0, "claude-opus-4-5") // port 不实际使用
	s.claudePath = claudePath

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", s.handleWS)
	mux.HandleFunc("/health", s.handleHealth)

	ts := httptest.NewServer(mux)
	t.Cleanup(func() {
		ts.Close()
	})

	return s, ts.URL
}

// connectWS 将 HTTP URL 转为 ws:// 后建立 WebSocket 连接。
func connectWS(t *testing.T, baseURL string) *websocket.Conn {
	t.Helper()
	wsURL := "ws" + strings.TrimPrefix(baseURL, "http") + "/ws"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("WebSocket 连接失败: %v", err)
	}
	t.Cleanup(func() {
		_ = conn.Close()
	})
	return conn
}

// readMessage 读取下一条 WebSocket 消息并反序列化到类型 T。
func readMessage[T any](t *testing.T, conn *websocket.Conn) T {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatalf("SetReadDeadline 失败: %v", err)
	}
	_, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("读取 WebSocket 消息失败: %v", err)
	}
	var v T
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatalf("反序列化消息失败 (data=%s): %v", string(data), err)
	}
	return v
}

// readRaw 读取原始 JSON 消息（用于类型未知时先检查 type 字段）。
func readRaw(t *testing.T, conn *websocket.Conn) map[string]json.RawMessage {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatalf("SetReadDeadline 失败: %v", err)
	}
	_, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("读取 WebSocket 消息失败: %v", err)
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("反序列化消息失败 (data=%s): %v", string(data), err)
	}
	return m
}

// writeMessage 向 WebSocket 连接发送 JSON 消息。
func writeMessage(t *testing.T, conn *websocket.Conn, msg any) {
	t.Helper()
	data, err := json.Marshal(msg)
	if err != nil {
		t.Fatalf("序列化消息失败: %v", err)
	}
	if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
		t.Fatalf("发送 WebSocket 消息失败: %v", err)
	}
}

// ============================================================================
// TestHealthCheck
// ============================================================================

// TestHealthCheck 验证 GET /health 返回 200 和合法的 JSON 响应。
func TestHealthCheck(t *testing.T) {
	_, baseURL := startTestServer(t)

	resp, err := http.Get(baseURL + "/health")
	if err != nil {
		t.Fatalf("HTTP GET /health 失败: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("期望状态码 200，实际: %d", resp.StatusCode)
	}

	contentType := resp.Header.Get("Content-Type")
	if !strings.Contains(contentType, "application/json") {
		t.Errorf("期望 Content-Type 包含 application/json，实际: %s", contentType)
	}

	var body map[string]string
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("解析响应 JSON 失败: %v", err)
	}

	if body["status"] != "ok" {
		t.Errorf("期望 status=ok，实际: %q", body["status"])
	}
	if body["time"] == "" {
		t.Error("响应中缺少 time 字段")
	}
}

// ============================================================================
// TestWebSocketConnect
// ============================================================================

// TestWebSocketConnect 验证 WS 连接建立后立即收到 connected 消息。
func TestWebSocketConnect(t *testing.T) {
	_, baseURL := startTestServer(t)
	conn := connectWS(t, baseURL)

	msg := readMessage[protocol.Connected](t, conn)

	if msg.Type != "connected" {
		t.Errorf("期望 type=connected，实际: %q", msg.Type)
	}
}

// ============================================================================
// TestCreateSession_NoClaudeCLI
// ============================================================================

// TestCreateSession_NoClaudeCLI 验证在 claude CLI 不可用的情况下，
// 发送 create_session 后收到 error 消息，且错误信息与 Claude Client 相关。
//
// 通过向 Server 注入一个不存在的 claudePath，使 exec.Command.Start()
// 直接返回 "executable file not found" 错误。
func TestCreateSession_NoClaudeCLI(t *testing.T) {
	// 使用必定不存在的路径，确保 cmd.Start() 立即失败
	_, baseURL := startTestServerWithClaudePath(t, "/nonexistent/claude-cli-does-not-exist")
	conn := connectWS(t, baseURL)

	// 消费 connected 消息
	_ = readMessage[protocol.Connected](t, conn)

	// 发送 create_session
	writeMessage(t, conn, protocol.CreateSession{
		Type:  "create_session",
		CWD:   "/tmp",
		Model: "claude-opus-4-5",
	})

	// cmd.Start() 失败时 NewClient 立即返回错误，Server 会同步返回 error 消息
	if err := conn.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatalf("SetReadDeadline 失败: %v", err)
	}
	_, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("读取 WebSocket 消息失败: %v", err)
	}

	var env protocol.Envelope
	if err := json.Unmarshal(data, &env); err != nil {
		t.Fatalf("反序列化 Envelope 失败: %v", err)
	}

	if env.Type != "error" {
		t.Fatalf("期望收到 error 消息，实际 type=%q (body=%s)", env.Type, string(data))
	}

	var errMsg protocol.ServerError
	if err := json.Unmarshal(data, &errMsg); err != nil {
		t.Fatalf("反序列化 ServerError 失败: %v", err)
	}

	if errMsg.Message == "" {
		t.Error("error 消息的 message 字段为空")
	}

	// 错误链：创建 BrainSession 失败 → 启动 Claude Client 失败 → start claude: exec: ...
	// 消息中应包含 "创建" 或 "Claude" 或 "BrainSession" 等关键字
	lowerMsg := strings.ToLower(errMsg.Message)
	claudeRelated := strings.Contains(lowerMsg, "claude") ||
		strings.Contains(lowerMsg, "brainsession") ||
		strings.Contains(lowerMsg, "创建") ||
		strings.Contains(lowerMsg, "启动") ||
		strings.Contains(errMsg.Message, "BrainSession")
	if !claudeRelated {
		t.Errorf("错误信息应包含 Claude/BrainSession 相关内容，实际: %q", errMsg.Message)
	}

	t.Logf("收到预期错误: %s", errMsg.Message)
}

// ============================================================================
// TestListSessions
// ============================================================================

// TestListSessions 验证新启动的 Server 中会话列表为空数组。
func TestListSessions(t *testing.T) {
	_, baseURL := startTestServer(t)
	conn := connectWS(t, baseURL)

	// 消费 connected 消息
	_ = readMessage[protocol.Connected](t, conn)

	// 发送 list_sessions
	writeMessage(t, conn, protocol.ListSessions{
		Type: "list_sessions",
	})

	msg := readMessage[protocol.SessionList](t, conn)

	if msg.Type != "session_list" {
		t.Errorf("期望 type=session_list，实际: %q", msg.Type)
	}
	if msg.Sessions == nil {
		t.Error("sessions 字段不应为 nil（期望空数组）")
	}
	if len(msg.Sessions) != 0 {
		t.Errorf("期望 sessions 为空，实际长度: %d", len(msg.Sessions))
	}
}

// ============================================================================
// TestToolRelay
// ============================================================================

// TestToolRelay 单元测试 ToolRelay 的核心功能。
func TestToolRelay(t *testing.T) {
	t.Run("Resolve", func(t *testing.T) {
		relay := NewToolRelay()
		ch := relay.CreatePending("req-1", "Read")

		resultJSON := json.RawMessage(`{"content":"hello"}`)
		go relay.Resolve("req-1", protocol.RemoteToolResult{Output: resultJSON})

		select {
		case res := <-ch:
			if res.err != nil {
				t.Fatalf("期望成功，实际错误: %v", res.err)
			}
			if string(res.toolResult.Output) != string(resultJSON) {
				t.Errorf("期望 result=%s，实际: %s", string(resultJSON), string(res.toolResult.Output))
			}
		case <-time.After(2 * time.Second):
			t.Fatal("等待 Resolve 超时")
		}
	})

	t.Run("Reject", func(t *testing.T) {
		relay := NewToolRelay()
		ch := relay.CreatePending("req-2", "Bash")

		go relay.Reject("req-2", errTest("模拟错误"))

		select {
		case res := <-ch:
			if res.err == nil {
				t.Fatal("期望收到错误，实际为 nil")
			}
			if res.err.Error() != "模拟错误" {
				t.Errorf("期望错误 '模拟错误'，实际: %q", res.err.Error())
			}
		case <-time.After(2 * time.Second):
			t.Fatal("等待 Reject 超时")
		}
	})

	t.Run("Cleanup", func(t *testing.T) {
		relay := NewToolRelay()
		ch1 := relay.CreatePending("req-3", "Read")
		ch2 := relay.CreatePending("req-4", "Bash")

		relay.Cleanup()

		for _, ch := range []chan callResult{ch1, ch2} {
			select {
			case res := <-ch:
				if res.err == nil {
					t.Error("Cleanup 后期望收到错误，实际为 nil")
				}
			case <-time.After(2 * time.Second):
				t.Fatal("等待 Cleanup 超时")
			}
		}

		// Cleanup 后 pending 应为空
		relay.mu.Lock()
		remaining := len(relay.pending)
		relay.mu.Unlock()
		if remaining != 0 {
			t.Errorf("Cleanup 后期望 pending 为空，实际: %d", remaining)
		}
	})

	t.Run("ResolveUnknownID", func(t *testing.T) {
		// Resolve 不存在的 requestID 不应 panic
		relay := NewToolRelay()
		relay.Resolve("nonexistent", protocol.RemoteToolResult{Output: json.RawMessage(`{}`)})
	})

	t.Run("RejectUnknownID", func(t *testing.T) {
		// Reject 不存在的 requestID 不应 panic
		relay := NewToolRelay()
		relay.Reject("nonexistent", errTest("no panic"))
	})
}

// errTest 是一个简单的 error 实现，用于测试。
type errTest string

func (e errTest) Error() string { return string(e) }
