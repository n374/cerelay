package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/anthropics/axon/internal/protocol"
	"github.com/gorilla/websocket"
)

// Server 是 Axon 的核心服务器
//
// 职责：
//   - 监听 HTTP/WebSocket，接受 Hand 连接
//   - 管理 BrainSession（每个 Session 对应一个 claude CLI 子进程）
//   - 路由 Hand 消息到对应 Session
type Server struct {
	port       int
	model      string
	claudePath string // claude CLI 路径，空字符串表示使用默认值 "claude"
	sessions   map[string]*BrainSession
	upgrader   websocket.Upgrader
	mu         sync.RWMutex

	httpServer *http.Server
}

// NewServer 创建 Server 实例
func NewServer(port int, model string) *Server {
	return &Server{
		port:  port,
		model: model,
		sessions: make(map[string]*BrainSession),
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool { return true },
		},
	}
}

// Start 启动 HTTP 服务器（阻塞）
func (s *Server) Start() error {
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", s.handleWS)
	mux.HandleFunc("/health", s.handleHealth)

	s.httpServer = &http.Server{
		Addr:    fmt.Sprintf(":%d", s.port),
		Handler: mux,
	}

	log.Printf("[Server] 启动在 :%d，默认模型: %s", s.port, s.model)
	return s.httpServer.ListenAndServe()
}

// Shutdown 优雅关闭服务器
func (s *Server) Shutdown(ctx context.Context) error {
	s.mu.Lock()
	for id, sess := range s.sessions {
		log.Printf("[Server] 关闭会话 %s", id)
		sess.Close()
		delete(s.sessions, id)
	}
	s.mu.Unlock()

	if s.httpServer != nil {
		return s.httpServer.Shutdown(ctx)
	}
	return nil
}

// handleHealth 健康检查
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{
		"status": "ok",
		"time":   time.Now().Format(time.RFC3339),
	})
}

// handleWS 升级 HTTP 连接到 WebSocket，进入消息处理循环
func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[Server] WebSocket 升级失败: %v", err)
		return
	}
	log.Printf("[Server] Hand 已连接: %s", conn.RemoteAddr())

	hc := newHandConn(conn)

	// 发送 connected 确认
	_ = hc.SendMessage(protocol.Connected{Type: "connected"})

	s.serveConn(r.Context(), hc)

	log.Printf("[Server] Hand 已断开: %s", conn.RemoteAddr())
}

// serveConn 处理单个 Hand 连接的消息循环
func (s *Server) serveConn(ctx context.Context, hc *handConn) {
	for {
		_, data, err := hc.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				log.Printf("[Server] WebSocket 读取错误: %v", err)
			}
			return
		}

		var env protocol.Envelope
		if err := json.Unmarshal(data, &env); err != nil {
			log.Printf("[Server] 消息解析错误: %v", err)
			continue
		}

		if err := s.dispatch(ctx, hc, env.Type, data); err != nil {
			log.Printf("[Server] 消息处理错误 (type=%s): %v", env.Type, err)
			_ = hc.SendMessage(protocol.ServerError{
				Type:    "error",
				Message: err.Error(),
			})
		}
	}
}

// dispatch 根据消息类型路由到对应处理函数
func (s *Server) dispatch(ctx context.Context, hc *handConn, msgType string, data []byte) error {
	switch msgType {
	case "create_session":
		var msg protocol.CreateSession
		if err := json.Unmarshal(data, &msg); err != nil {
			return fmt.Errorf("解析 create_session 失败: %w", err)
		}
		return s.handleCreateSession(ctx, hc, msg)

	case "prompt":
		var msg protocol.Prompt
		if err := json.Unmarshal(data, &msg); err != nil {
			return fmt.Errorf("解析 prompt 失败: %w", err)
		}
		return s.handlePrompt(ctx, hc, msg)

	case "tool_result":
		var msg protocol.ToolResult
		if err := json.Unmarshal(data, &msg); err != nil {
			return fmt.Errorf("解析 tool_result 失败: %w", err)
		}
		return s.handleToolResult(msg)

	case "list_sessions":
		return s.handleListSessions(hc)

	case "close_session":
		var msg protocol.CloseSession
		if err := json.Unmarshal(data, &msg); err != nil {
			return fmt.Errorf("解析 close_session 失败: %w", err)
		}
		return s.handleCloseSession(msg)

	default:
		return fmt.Errorf("未知消息类型: %s", msgType)
	}
}

// handleCreateSession 处理 create_session 请求
func (s *Server) handleCreateSession(ctx context.Context, hc *handConn, msg protocol.CreateSession) error {
	model := msg.Model
	if model == "" {
		model = s.model
	}

	id := newSessionID()
	cwd := msg.CWD
	if cwd == "" {
		cwd = "."
	}

	sess, err := NewBrainSession(ctx, id, cwd, model, s.claudePath, hc)
	if err != nil {
		return fmt.Errorf("创建 BrainSession 失败: %w", err)
	}

	s.mu.Lock()
	s.sessions[id] = sess
	s.mu.Unlock()

	log.Printf("[Server] 创建会话 %s (cwd=%s, model=%s)", id, cwd, model)

	return hc.SendMessage(protocol.CreateSessionResponse{
		Type:      "session_created",
		SessionID: id,
	})
}

// handlePrompt 处理 prompt 请求（异步）
func (s *Server) handlePrompt(ctx context.Context, hc *handConn, msg protocol.Prompt) error {
	sess := s.getSession(msg.SessionID)
	if sess == nil {
		return fmt.Errorf("会话不存在: %s", msg.SessionID)
	}

	// 异步执行，避免阻塞 WebSocket 读取循环
	go sess.Prompt(msg.Text)
	return nil
}

// handleToolResult 处理 Hand 返回的工具执行结果
func (s *Server) handleToolResult(msg protocol.ToolResult) error {
	sess := s.getSession(msg.SessionID)
	if sess == nil {
		return fmt.Errorf("会话不存在: %s", msg.SessionID)
	}

	if msg.Error != "" {
		sess.relay.Reject(msg.RequestID, fmt.Errorf("%s", msg.Error))
		return nil
	}

	// 将 Result 序列化为 json.RawMessage
	raw, err := json.Marshal(msg.Result)
	if err != nil {
		return fmt.Errorf("序列化 tool_result 失败: %w", err)
	}
	sess.relay.Resolve(msg.RequestID, raw)
	return nil
}

// handleListSessions 返回当前所有会话列表
func (s *Server) handleListSessions(hc *handConn) error {
	s.mu.RLock()
	infos := make([]protocol.SessionInfo, 0, len(s.sessions))
	for _, sess := range s.sessions {
		infos = append(infos, sess.Info())
	}
	s.mu.RUnlock()

	return hc.SendMessage(protocol.SessionList{
		Type:     "session_list",
		Sessions: infos,
	})
}

// handleCloseSession 关闭指定会话
func (s *Server) handleCloseSession(msg protocol.CloseSession) error {
	s.mu.Lock()
	sess, ok := s.sessions[msg.SessionID]
	if ok {
		delete(s.sessions, msg.SessionID)
	}
	s.mu.Unlock()

	if !ok {
		return fmt.Errorf("会话不存在: %s", msg.SessionID)
	}

	sess.Close()
	log.Printf("[Server] 关闭会话 %s", msg.SessionID)
	return nil
}

// getSession 线程安全地获取会话
func (s *Server) getSession(id string) *BrainSession {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.sessions[id]
}

// ============================================================================
// handConn — WebSocket 连接封装
// ============================================================================

// handConn 封装 WebSocket 连接，实现 HandConn 接口
type handConn struct {
	conn    *websocket.Conn
	writeMu sync.Mutex
}

func newHandConn(conn *websocket.Conn) *handConn {
	return &handConn{conn: conn}
}

// SendMessage 线程安全地通过 WebSocket 发送 JSON 消息
func (h *handConn) SendMessage(msg any) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("序列化消息失败: %w", err)
	}
	h.writeMu.Lock()
	defer h.writeMu.Unlock()
	return h.conn.WriteMessage(websocket.TextMessage, data)
}

// ============================================================================
// 工具函数
// ============================================================================

var sessionCounter int64
var sessionCounterMu sync.Mutex

// newSessionID 生成唯一的会话 ID
func newSessionID() string {
	sessionCounterMu.Lock()
	sessionCounter++
	n := sessionCounter
	sessionCounterMu.Unlock()
	return fmt.Sprintf("sess-%d-%d", time.Now().UnixNano(), n)
}
