package hand

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// mustMarshal 将任意值序列化为 json.RawMessage，测试中 panic on error。
func mustMarshal(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

func TestRead(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "read.txt")
	content := "hello axon\n中文内容\n"
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("写入测试文件失败: %v", err)
	}

	ex := NewExecutor()
	result, err := ex.Execute("Read", mustMarshal(map[string]any{
		"file_path": path,
	}))
	if err != nil {
		t.Fatalf("Read 返回错误: %v", err)
	}

	got, ok := result.(*readOutput)
	if !ok {
		t.Fatalf("返回类型不匹配，got %T", result)
	}
	if got.Content != content {
		t.Fatalf("内容不匹配，期望 %q，实际 %q", content, got.Content)
	}
}

func TestReadNotFound(t *testing.T) {
	ex := NewExecutor()
	_, err := ex.Execute("Read", mustMarshal(map[string]any{
		"file_path": filepath.Join(t.TempDir(), "missing.txt"),
	}))
	if err == nil {
		t.Fatal("期望 Read 返回错误，实际 err == nil")
	}
}

func TestReadWithOffsetLimit(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "slice.txt")
	if err := os.WriteFile(path, []byte("abcdef"), 0644); err != nil {
		t.Fatalf("写入测试文件失败: %v", err)
	}

	ex := NewExecutor()
	result, err := ex.Execute("Read", mustMarshal(map[string]any{
		"file_path": path,
		"offset":    2,
		"limit":     3,
	}))
	if err != nil {
		t.Fatalf("Read 返回错误: %v", err)
	}

	got := result.(*readOutput)
	if got.Content != "cde" {
		t.Fatalf("切片内容不匹配，期望 %q，实际 %q", "cde", got.Content)
	}
}

func TestWrite(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "write.txt")
	content := "written by executor\n"

	ex := NewExecutor()
	result, err := ex.Execute("Write", mustMarshal(map[string]any{
		"file_path": path,
		"content":   content,
	}))
	if err != nil {
		t.Fatalf("Write 返回错误: %v", err)
	}

	got, ok := result.(*pathOutput)
	if !ok {
		t.Fatalf("返回类型不匹配，got %T", result)
	}
	if got.Path != path {
		t.Fatalf("返回路径不匹配，期望 %q，实际 %q", path, got.Path)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读取写入结果失败: %v", err)
	}
	if string(data) != content {
		t.Fatalf("写入内容不匹配，期望 %q，实际 %q", content, string(data))
	}
}

func TestEdit(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "edit.txt")
	if err := os.WriteFile(path, []byte("hello axon"), 0644); err != nil {
		t.Fatalf("写入测试文件失败: %v", err)
	}

	ex := NewExecutor()
	_, err := ex.Execute("Edit", mustMarshal(map[string]any{
		"file_path":  path,
		"old_string": "axon",
		"new_string": "claude",
	}))
	if err != nil {
		t.Fatalf("Edit 返回错误: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读取编辑结果失败: %v", err)
	}
	if string(data) != "hello claude" {
		t.Fatalf("编辑结果不匹配，期望 %q，实际 %q", "hello claude", string(data))
	}
}

func TestEditOldStringNotFound(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "edit-miss.txt")
	if err := os.WriteFile(path, []byte("hello axon"), 0644); err != nil {
		t.Fatalf("写入测试文件失败: %v", err)
	}

	ex := NewExecutor()
	_, err := ex.Execute("Edit", mustMarshal(map[string]any{
		"file_path":  path,
		"old_string": "missing",
		"new_string": "claude",
	}))
	if err == nil {
		t.Fatal("期望 Edit 返回错误，实际 err == nil")
	}
}

func TestMultiEdit(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "multi-edit.txt")
	if err := os.WriteFile(path, []byte("alpha beta gamma"), 0644); err != nil {
		t.Fatalf("写入测试文件失败: %v", err)
	}

	ex := NewExecutor()
	_, err := ex.Execute("MultiEdit", mustMarshal(map[string]any{
		"file_path": path,
		"edits": []map[string]string{
			{"old_string": "alpha", "new_string": "one"},
			{"old_string": "gamma", "new_string": "three"},
		},
	}))
	if err != nil {
		t.Fatalf("MultiEdit 返回错误: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读取编辑结果失败: %v", err)
	}
	if string(data) != "one beta three" {
		t.Fatalf("MultiEdit 结果不匹配，期望 %q，实际 %q", "one beta three", string(data))
	}
}

func TestBash(t *testing.T) {
	ex := NewExecutor()
	result, err := ex.Execute("Bash", mustMarshal(map[string]any{
		"command": "printf 'hello'",
	}))
	if err != nil {
		t.Fatalf("Bash 返回错误: %v", err)
	}

	got, ok := result.(*bashOutput)
	if !ok {
		t.Fatalf("返回类型不匹配，got %T", result)
	}
	if got.ExitCode != 0 {
		t.Fatalf("exit_code 不匹配，期望 0，实际 %d", got.ExitCode)
	}
	if got.Stdout != "hello" {
		t.Fatalf("stdout 不匹配，期望 %q，实际 %q", "hello", got.Stdout)
	}
}

func TestBashNonZeroExitCode(t *testing.T) {
	ex := NewExecutor()
	result, err := ex.Execute("Bash", mustMarshal(map[string]any{
		"command": "echo fail >&2; exit 7",
	}))
	if err != nil {
		t.Fatalf("非零退出码不应作为错误返回，实际: %v", err)
	}

	got := result.(*bashOutput)
	if got.ExitCode != 7 {
		t.Fatalf("exit_code 不匹配，期望 7，实际 %d", got.ExitCode)
	}
	if !strings.Contains(got.Stderr, "fail") {
		t.Fatalf("stderr 应包含 fail，实际 %q", got.Stderr)
	}
}

func TestGrep(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "grep.txt")
	if err := os.WriteFile(path, []byte("first line\nneedle here\nlast line\n"), 0644); err != nil {
		t.Fatalf("写入测试文件失败: %v", err)
	}

	ex := NewExecutor()
	result, err := ex.Execute("Grep", mustMarshal(map[string]any{
		"pattern": "needle",
		"path":    dir,
		"glob":    "*.txt",
	}))
	if err != nil {
		t.Fatalf("Grep 返回错误: %v", err)
	}

	got, ok := result.(*grepOutput)
	if !ok {
		t.Fatalf("返回类型不匹配，got %T", result)
	}
	if len(got.Matches) != 1 {
		t.Fatalf("匹配数量不正确，期望 1，实际 %d", len(got.Matches))
	}
	if got.Matches[0].File != path {
		t.Fatalf("匹配文件不正确，期望 %q，实际 %q", path, got.Matches[0].File)
	}
	if got.Matches[0].Line != 2 {
		t.Fatalf("匹配行号不正确，期望 2，实际 %d", got.Matches[0].Line)
	}
}

func TestGlob(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "match.go")
	if err := os.WriteFile(target, []byte("package test"), 0644); err != nil {
		t.Fatalf("写入测试文件失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "skip.txt"), []byte("ignore"), 0644); err != nil {
		t.Fatalf("写入测试文件失败: %v", err)
	}

	ex := NewExecutor()
	result, err := ex.Execute("Glob", mustMarshal(map[string]any{
		"pattern": "*.go",
		"path":    dir,
	}))
	if err != nil {
		t.Fatalf("Glob 返回错误: %v", err)
	}

	got, ok := result.(*globOutput)
	if !ok {
		t.Fatalf("返回类型不匹配，got %T", result)
	}
	if len(got.Files) != 1 || got.Files[0] != target {
		t.Fatalf("Glob 结果不正确，实际 %#v", got.Files)
	}
}

func TestUnknownTool(t *testing.T) {
	ex := NewExecutor()
	_, err := ex.Execute("UnknownTool", mustMarshal(map[string]any{}))
	if err == nil {
		t.Fatal("期望未知工具返回错误，实际 err == nil")
	}

	toolErr, ok := err.(*ToolError)
	if !ok {
		t.Fatalf("错误类型不匹配，got %T", err)
	}
	if toolErr.Code != "unknown_tool" {
		t.Fatalf("错误码不匹配，期望 %q，实际 %q", "unknown_tool", toolErr.Code)
	}
}
