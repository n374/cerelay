package claude

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

const maxScanTokenSize = 10 * 1024 * 1024

// Config 是 Claude CLI 客户端配置。
type Config struct {
	ClaudePath string // Claude CLI 路径，空字符串时默认 claude。
	Model      string // 模型名。
	CWD        string // Claude CLI 工作目录。
}

// Client 管理 claude CLI 子进程和 stream-json NDJSON 通信。
type Client struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout io.ReadCloser
	stderr io.ReadCloser

	scanner *bufio.Scanner

	ctx    context.Context
	cancel context.CancelFunc

	writeMu sync.Mutex
	readMu  sync.Mutex
	closeMu sync.Mutex
	closed  bool
}

// NewClient 创建并启动 Claude CLI 子进程。
func NewClient(ctx context.Context, cfg Config) (*Client, error) {
	claudePath := cfg.ClaudePath
	if claudePath == "" {
		claudePath = "claude"
	}

	args := []string{
		"-p",
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--dangerously-skip-permissions",
	}
	if cfg.Model != "" {
		args = append(args, "--model", cfg.Model)
	}

	clientCtx, cancel := context.WithCancel(ctx)
	cmd := exec.CommandContext(clientCtx, claudePath, args...)
	if cfg.CWD != "" {
		cmd.Dir = cfg.CWD
	}

	stdin, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return nil, fmt.Errorf("创建 stdin pipe 失败: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return nil, fmt.Errorf("创建 stdout pipe 失败: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		cancel()
		return nil, fmt.Errorf("创建 stderr pipe 失败: %w", err)
	}

	if err := cmd.Start(); err != nil {
		cancel()
		return nil, fmt.Errorf("启动 claude CLI 失败: %w", err)
	}

	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), maxScanTokenSize)

	c := &Client{
		cmd:     cmd,
		stdin:   stdin,
		stdout:  stdout,
		stderr:  stderr,
		scanner: scanner,
		ctx:     clientCtx,
		cancel:  cancel,
	}

	go c.logStderr()

	return c, nil
}

// SendUserMessage 发送一条用户文本消息。
func (c *Client) SendUserMessage(text string) error {
	input := NewTextInput(text)
	data, err := json.Marshal(input)
	if err != nil {
		return fmt.Errorf("序列化用户消息失败: %w", err)
	}

	c.writeMu.Lock()
	defer c.writeMu.Unlock()

	if _, err := c.stdin.Write(append(data, '\n')); err != nil {
		return fmt.Errorf("写入 Claude stdin 失败: %w", err)
	}
	return nil
}

// ReadMessages 持续读取 stdout NDJSON，直到收到 result 消息。
func (c *Client) ReadMessages(handler func(SDKMessage)) error {
	c.readMu.Lock()
	defer c.readMu.Unlock()

	for c.scanner.Scan() {
		line := append([]byte(nil), c.scanner.Bytes()...)

		var msg SDKMessage
		if err := json.Unmarshal(line, &msg); err != nil {
			return fmt.Errorf("解析 Claude 消息失败: %w", err)
		}
		msg.Raw = json.RawMessage(line)

		handler(msg)

		if msg.Type == "result" {
			return nil
		}
	}

	if err := c.scanner.Err(); err != nil {
		return fmt.Errorf("读取 Claude stdout 失败: %w", err)
	}
	if err := c.ctx.Err(); err != nil {
		return err
	}
	return io.EOF
}

// Close 关闭 Claude CLI 子进程和相关 pipe。
func (c *Client) Close() error {
	c.closeMu.Lock()
	if c.closed {
		c.closeMu.Unlock()
		return nil
	}
	c.closed = true
	c.closeMu.Unlock()

	c.cancel()

	if c.cmd.Process != nil {
		if err := c.cmd.Process.Kill(); err != nil && err.Error() != "os: process already finished" {
			log.Printf("[Claude] 杀死子进程失败: %v", err)
		}
	}

	if c.stdin != nil {
		_ = c.stdin.Close()
	}
	if c.stdout != nil {
		_ = c.stdout.Close()
	}
	if c.stderr != nil {
		_ = c.stderr.Close()
	}

	if err := c.cmd.Wait(); err != nil && c.ctx.Err() == nil {
		return fmt.Errorf("等待 Claude CLI 退出失败: %w", err)
	}
	return nil
}

// logStderr 将 Claude stderr 输出到日志。
func (c *Client) logStderr() {
	scanner := bufio.NewScanner(c.stderr)
	scanner.Buffer(make([]byte, 0, 64*1024), maxScanTokenSize)
	for scanner.Scan() {
		log.Printf("[Claude stderr] %s", scanner.Text())
	}
	if err := scanner.Err(); err != nil && c.ctx.Err() == nil {
		log.Printf("[Claude] 读取 stderr 失败: %v", err)
	}
}
