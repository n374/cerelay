package hand

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"

	"github.com/anthropics/axon/internal/acp"
)

// lockedBuffer 是线程安全的 bytes.Buffer，
// 同时实现 io.Writer（供 cmd.Stdout/Stderr）和 String()（供读取）
type lockedBuffer struct {
	buf bytes.Buffer
	mu  sync.Mutex
}

func (lb *lockedBuffer) Write(p []byte) (int, error) {
	lb.mu.Lock()
	defer lb.mu.Unlock()
	return lb.buf.Write(p)
}

func (lb *lockedBuffer) String() string {
	lb.mu.Lock()
	defer lb.mu.Unlock()
	return lb.buf.String()
}

// managedTerminal 管理单个子进程的生命周期
type managedTerminal struct {
	cmd      *exec.Cmd
	output   *lockedBuffer
	done     chan struct{}
	exitCode int
	mu       sync.Mutex // 保护 exitCode
	startErr error
}

// Executor 在本地执行 ACP 工具调用
type Executor struct {
	terminals   map[string]*managedTerminal
	terminalsMu sync.RWMutex
	nextTermID  atomic.Int64
}

// NewExecutor 创建 Executor
func NewExecutor() *Executor {
	return &Executor{
		terminals: make(map[string]*managedTerminal),
	}
}

// Execute 根据 ACP method 和 params 执行本地操作
func (e *Executor) Execute(method string, params json.RawMessage) (any, error) {
	switch method {
	case "fs/read_text_file":
		return e.fsReadTextFile(params)
	case "fs/write_text_file":
		return e.fsWriteTextFile(params)
	case "terminal/create":
		return e.terminalCreate(params)
	case "terminal/output":
		return e.terminalOutput(params)
	case "terminal/wait_for_exit":
		return e.terminalWaitForExit(params)
	case "terminal/kill":
		return e.terminalKill(params)
	case "terminal/release":
		return e.terminalRelease(params)
	case "session/request_permission":
		return e.sessionRequestPermission(params)
	default:
		return nil, fmt.Errorf("未知方法: %s", method)
	}
}

// --- fs ---

func (e *Executor) fsReadTextFile(raw json.RawMessage) (*acp.ReadTextFileResult, error) {
	var p acp.ReadTextFileParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("解析 fs/read_text_file 参数: %w", err)
	}
	data, err := os.ReadFile(p.Path)
	if err != nil {
		return nil, fmt.Errorf("读取文件 %q: %w", p.Path, err)
	}
	return &acp.ReadTextFileResult{Content: string(data)}, nil
}

func (e *Executor) fsWriteTextFile(raw json.RawMessage) (*acp.WriteTextFileResult, error) {
	var p acp.WriteTextFileParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("解析 fs/write_text_file 参数: %w", err)
	}
	if err := os.WriteFile(p.Path, []byte(p.Content), 0644); err != nil {
		return nil, fmt.Errorf("写入文件 %q: %w", p.Path, err)
	}
	return &acp.WriteTextFileResult{Success: true}, nil
}

// --- terminal ---

func (e *Executor) terminalCreate(raw json.RawMessage) (*acp.CreateTerminalResult, error) {
	var p acp.CreateTerminalParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("解析 terminal/create 参数: %w", err)
	}

	var cmd *exec.Cmd
	if len(p.Args) > 0 {
		cmd = exec.Command(p.Command, p.Args...)
	} else {
		cmd = exec.Command(p.Command)
	}
	if p.CWD != "" {
		cmd.Dir = p.CWD
	}

	buf := &lockedBuffer{}
	mt := &managedTerminal{
		cmd:      cmd,
		output:   buf,
		done:     make(chan struct{}),
		exitCode: -1,
	}

	// 合并 stdout+stderr 到线程安全的 buffer
	cmd.Stdout = buf
	cmd.Stderr = buf

	if err := cmd.Start(); err != nil {
		mt.startErr = err
		close(mt.done)
		return nil, fmt.Errorf("启动命令 %q: %w", p.Command, err)
	}

	// 等待进程退出
	go func() {
		err := cmd.Wait()
		mt.mu.Lock()
		if err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				mt.exitCode = exitErr.ExitCode()
			} else {
				mt.exitCode = -1
			}
		} else {
			mt.exitCode = 0
		}
		mt.mu.Unlock()
		close(mt.done)
	}()

	id := fmt.Sprintf("term-%d", e.nextTermID.Add(1))
	e.terminalsMu.Lock()
	e.terminals[id] = mt
	e.terminalsMu.Unlock()

	return &acp.CreateTerminalResult{TerminalID: id}, nil
}

func (e *Executor) getTerminal(id string) (*managedTerminal, error) {
	e.terminalsMu.RLock()
	mt, ok := e.terminals[id]
	e.terminalsMu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("terminal %q 不存在", id)
	}
	return mt, nil
}

func (e *Executor) terminalOutput(raw json.RawMessage) (*acp.TerminalOutputResult, error) {
	var p acp.TerminalOutputParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("解析 terminal/output 参数: %w", err)
	}
	mt, err := e.getTerminal(p.TerminalID)
	if err != nil {
		return nil, err
	}
	return &acp.TerminalOutputResult{Output: mt.output.String()}, nil
}

func (e *Executor) terminalWaitForExit(raw json.RawMessage) (*acp.WaitForTerminalExitResult, error) {
	var p acp.WaitForTerminalExitParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("解析 terminal/wait_for_exit 参数: %w", err)
	}
	mt, err := e.getTerminal(p.TerminalID)
	if err != nil {
		return nil, err
	}
	// 阻塞等待进程退出
	<-mt.done
	mt.mu.Lock()
	code := mt.exitCode
	mt.mu.Unlock()
	return &acp.WaitForTerminalExitResult{ExitCode: code, Output: mt.output.String()}, nil
}

func (e *Executor) terminalKill(raw json.RawMessage) (any, error) {
	var p acp.KillTerminalParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("解析 terminal/kill 参数: %w", err)
	}
	mt, err := e.getTerminal(p.TerminalID)
	if err != nil {
		return nil, err
	}
	if mt.cmd.Process != nil {
		if err := mt.cmd.Process.Kill(); err != nil {
			return nil, fmt.Errorf("杀死进程: %w", err)
		}
	}
	return struct{}{}, nil
}

func (e *Executor) terminalRelease(raw json.RawMessage) (any, error) {
	var p acp.ReleaseTerminalParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("解析 terminal/release 参数: %w", err)
	}
	e.terminalsMu.Lock()
	delete(e.terminals, p.TerminalID)
	e.terminalsMu.Unlock()
	return struct{}{}, nil
}

// --- session ---

func (e *Executor) sessionRequestPermission(raw json.RawMessage) (*acp.RequestPermissionResult, error) {
	var p acp.RequestPermissionParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("解析 session/request_permission 参数: %w", err)
	}

	// 打印权限请求，并自动允许第一个选项
	fmt.Printf("\033[33m[权限请求] 工具: %s\033[0m\n", p.ToolName)
	if len(p.Options) > 0 {
		fmt.Printf("\033[33m  自动选择: %s\033[0m\n", p.Options[0].Label)
		return &acp.RequestPermissionResult{
			Outcome: acp.PermissionOutcome{
				Outcome:  "selected",
				OptionID: p.Options[0].OptionID,
			},
		}, nil
	}
	return &acp.RequestPermissionResult{
		Outcome: acp.PermissionOutcome{
			Outcome: "dismissed",
		},
	}, nil
}
