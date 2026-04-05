package hand

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/anthropics/axon/internal/acp"
)

// mustMarshal 将任意值序列化为 json.RawMessage，测试中 panic on error
func mustMarshal(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

// TestFsReadTextFile 创建临时文件，通过 Execute 读取，验证内容正确
func TestFsReadTextFile(t *testing.T) {
	f, err := os.CreateTemp("", "axon-read-*.txt")
	if err != nil {
		t.Fatalf("创建临时文件失败: %v", err)
	}
	defer os.Remove(f.Name())

	content := "hello axon\n中文内容\n"
	if _, err := f.WriteString(content); err != nil {
		t.Fatalf("写入临时文件失败: %v", err)
	}
	f.Close()

	ex := NewExecutor()
	raw := mustMarshal(acp.ReadTextFileParams{Path: f.Name()})
	result, err := ex.Execute("fs/read_text_file", raw)
	if err != nil {
		t.Fatalf("Execute 返回错误: %v", err)
	}

	got, ok := result.(*acp.ReadTextFileResult)
	if !ok {
		t.Fatalf("返回类型不匹配，got %T", result)
	}
	if got.Content != content {
		t.Errorf("内容不匹配\n期望: %q\n实际: %q", content, got.Content)
	}
}

// TestFsReadTextFile_NotFound 读取不存在的文件，验证返回错误
func TestFsReadTextFile_NotFound(t *testing.T) {
	ex := NewExecutor()
	raw := mustMarshal(acp.ReadTextFileParams{Path: "/tmp/axon-nonexistent-file-xyz.txt"})
	_, err := ex.Execute("fs/read_text_file", raw)
	if err == nil {
		t.Fatal("期望返回错误，实际 err == nil")
	}
}

// TestFsWriteTextFile 通过 Execute 写入临时文件，再读取验证内容
func TestFsWriteTextFile(t *testing.T) {
	f, err := os.CreateTemp("", "axon-write-*.txt")
	if err != nil {
		t.Fatalf("创建临时文件失败: %v", err)
	}
	f.Close()
	defer os.Remove(f.Name())

	content := "written by executor\n写入测试\n"
	ex := NewExecutor()
	raw := mustMarshal(acp.WriteTextFileParams{Path: f.Name(), Content: content})
	result, err := ex.Execute("fs/write_text_file", raw)
	if err != nil {
		t.Fatalf("Execute 返回错误: %v", err)
	}

	got, ok := result.(*acp.WriteTextFileResult)
	if !ok {
		t.Fatalf("返回类型不匹配，got %T", result)
	}
	if !got.Success {
		t.Error("WriteTextFileResult.Success 应为 true")
	}

	// 直接读文件验证内容
	data, err := os.ReadFile(f.Name())
	if err != nil {
		t.Fatalf("读取写入后的文件失败: %v", err)
	}
	if string(data) != content {
		t.Errorf("写入内容不匹配\n期望: %q\n实际: %q", content, string(data))
	}
}

// TestTerminalCreateAndWait 启动 echo hello，等待退出，验证 exitCode=0 且输出包含 "hello"
func TestTerminalCreateAndWait(t *testing.T) {
	ex := NewExecutor()

	// 创建 terminal
	createRaw := mustMarshal(acp.CreateTerminalParams{
		Command: "echo",
		Args:    []string{"hello"},
	})
	createRes, err := ex.Execute("terminal/create", createRaw)
	if err != nil {
		t.Fatalf("terminal/create 返回错误: %v", err)
	}
	created, ok := createRes.(*acp.CreateTerminalResult)
	if !ok {
		t.Fatalf("返回类型不匹配，got %T", createRes)
	}
	termID := created.TerminalID
	if termID == "" {
		t.Fatal("TerminalID 为空")
	}

	// 等待退出
	waitRaw := mustMarshal(acp.WaitForTerminalExitParams{TerminalID: termID})
	waitRes, err := ex.Execute("terminal/wait_for_exit", waitRaw)
	if err != nil {
		t.Fatalf("terminal/wait_for_exit 返回错误: %v", err)
	}
	waited, ok := waitRes.(*acp.WaitForTerminalExitResult)
	if !ok {
		t.Fatalf("返回类型不匹配，got %T", waitRes)
	}
	if waited.ExitCode != 0 {
		t.Errorf("exitCode 应为 0，实际 %d", waited.ExitCode)
	}
	if !strings.Contains(waited.Output, "hello") {
		t.Errorf("输出应包含 \"hello\"，实际: %q", waited.Output)
	}
}

// TestTerminalOutput 启动稍慢命令，在执行期间轮询 terminal/output，
// 最终通过 wait_for_exit 验证完整输出包含两行
func TestTerminalOutput(t *testing.T) {
	ex := NewExecutor()

	createRaw := mustMarshal(acp.CreateTerminalParams{
		Command: "sh",
		Args:    []string{"-c", "echo line1; sleep 0.1; echo line2"},
	})
	createRes, err := ex.Execute("terminal/create", createRaw)
	if err != nil {
		t.Fatalf("terminal/create 返回错误: %v", err)
	}
	created := createRes.(*acp.CreateTerminalResult)
	termID := created.TerminalID

	// 短暂等待第一行输出就绪
	time.Sleep(30 * time.Millisecond)

	// 获取当前输出（进程可能还在运行）
	outRaw := mustMarshal(acp.TerminalOutputParams{TerminalID: termID})
	outRes, err := ex.Execute("terminal/output", outRaw)
	if err != nil {
		t.Fatalf("terminal/output 返回错误: %v", err)
	}
	outResult, ok := outRes.(*acp.TerminalOutputResult)
	if !ok {
		t.Fatalf("返回类型不匹配，got %T", outRes)
	}
	// 不强断言 line1 已出现，避免时序抖动；只验证调用不出错
	_ = outResult.Output

	// 等待完成，获取完整输出
	waitRaw := mustMarshal(acp.WaitForTerminalExitParams{TerminalID: termID})
	waitRes, err := ex.Execute("terminal/wait_for_exit", waitRaw)
	if err != nil {
		t.Fatalf("terminal/wait_for_exit 返回错误: %v", err)
	}
	waited := waitRes.(*acp.WaitForTerminalExitResult)
	if !strings.Contains(waited.Output, "line1") {
		t.Errorf("完整输出应包含 \"line1\"，实际: %q", waited.Output)
	}
	if !strings.Contains(waited.Output, "line2") {
		t.Errorf("完整输出应包含 \"line2\"，实际: %q", waited.Output)
	}
}

// TestTerminalKillAndRelease 启动 sleep 60，kill 后 release，验证 terminal 不再存在
func TestTerminalKillAndRelease(t *testing.T) {
	ex := NewExecutor()

	createRaw := mustMarshal(acp.CreateTerminalParams{
		Command: "sleep",
		Args:    []string{"60"},
	})
	createRes, err := ex.Execute("terminal/create", createRaw)
	if err != nil {
		t.Fatalf("terminal/create 返回错误: %v", err)
	}
	created := createRes.(*acp.CreateTerminalResult)
	termID := created.TerminalID

	// Kill
	killRaw := mustMarshal(acp.KillTerminalParams{TerminalID: termID})
	_, err = ex.Execute("terminal/kill", killRaw)
	if err != nil {
		t.Fatalf("terminal/kill 返回错误: %v", err)
	}

	// Release
	releaseRaw := mustMarshal(acp.ReleaseTerminalParams{TerminalID: termID})
	_, err = ex.Execute("terminal/release", releaseRaw)
	if err != nil {
		t.Fatalf("terminal/release 返回错误: %v", err)
	}

	// 验证 terminal 已被删除：再次调用 terminal/output 应返回错误
	outRaw := mustMarshal(acp.TerminalOutputParams{TerminalID: termID})
	_, err = ex.Execute("terminal/output", outRaw)
	if err == nil {
		t.Fatal("release 后应无法获取 terminal，期望错误，实际 err == nil")
	}
}

// TestUnknownMethod 调用未知方法，验证返回错误
func TestUnknownMethod(t *testing.T) {
	ex := NewExecutor()
	_, err := ex.Execute("unknown/method", mustMarshal(struct{}{}))
	if err == nil {
		t.Fatal("期望未知方法返回错误，实际 err == nil")
	}
}
