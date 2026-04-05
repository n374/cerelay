package hand

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

type readInput struct {
	FilePath string `json:"file_path"`
	Offset   *int   `json:"offset,omitempty"`
	Limit    *int   `json:"limit,omitempty"`
}

type readOutput struct {
	Content string `json:"content"`
}

type writeInput struct {
	FilePath string `json:"file_path"`
	Content  string `json:"content"`
}

type pathOutput struct {
	Path string `json:"path"`
}

type editInput struct {
	FilePath   string `json:"file_path"`
	OldString  string `json:"old_string"`
	NewString  string `json:"new_string"`
	ReplaceAll bool   `json:"replace_all,omitempty"`
}

type multiEditInput struct {
	FilePath string          `json:"file_path"`
	Edits    []multiEditItem `json:"edits"`
}

type multiEditItem struct {
	OldString string `json:"old_string"`
	NewString string `json:"new_string"`
}

// read 读取文件内容，并按 offset/limit 截取。
func (e *Executor) read(raw json.RawMessage) (*readOutput, error) {
	var input readInput
	if err := json.Unmarshal(raw, &input); err != nil {
		return nil, fmt.Errorf("解析 Read 参数失败: %w", err)
	}
	if input.FilePath == "" {
		return nil, fmt.Errorf("Read 缺少 file_path")
	}

	data, err := os.ReadFile(input.FilePath)
	if err != nil {
		return nil, fmt.Errorf("读取文件 %q 失败: %w", input.FilePath, err)
	}

	content := string(data)
	runes := []rune(content)
	start := 0
	if input.Offset != nil {
		if *input.Offset < 0 {
			return nil, fmt.Errorf("Read 的 offset 不能为负数")
		}
		if *input.Offset > len(runes) {
			start = len(runes)
		} else {
			start = *input.Offset
		}
	}

	end := len(runes)
	if input.Limit != nil {
		if *input.Limit < 0 {
			return nil, fmt.Errorf("Read 的 limit 不能为负数")
		}
		if start+*input.Limit < end {
			end = start + *input.Limit
		}
	}

	return &readOutput{Content: string(runes[start:end])}, nil
}

// write 将完整内容写入目标文件。
func (e *Executor) write(raw json.RawMessage) (*pathOutput, error) {
	var input writeInput
	if err := json.Unmarshal(raw, &input); err != nil {
		return nil, fmt.Errorf("解析 Write 参数失败: %w", err)
	}
	if input.FilePath == "" {
		return nil, fmt.Errorf("Write 缺少 file_path")
	}
	if err := os.WriteFile(input.FilePath, []byte(input.Content), 0644); err != nil {
		return nil, fmt.Errorf("写入文件 %q 失败: %w", input.FilePath, err)
	}
	return &pathOutput{Path: input.FilePath}, nil
}

// edit 对文件做单次或全量字符串替换。
func (e *Executor) edit(raw json.RawMessage) (*pathOutput, error) {
	var input editInput
	if err := json.Unmarshal(raw, &input); err != nil {
		return nil, fmt.Errorf("解析 Edit 参数失败: %w", err)
	}
	if input.FilePath == "" {
		return nil, fmt.Errorf("Edit 缺少 file_path")
	}

	content, err := os.ReadFile(input.FilePath)
	if err != nil {
		return nil, fmt.Errorf("读取文件 %q 失败: %w", input.FilePath, err)
	}

	updated, replaced, err := replaceContent(string(content), input.OldString, input.NewString, input.ReplaceAll)
	if err != nil {
		return nil, fmt.Errorf("编辑文件 %q 失败: %w", input.FilePath, err)
	}
	if !replaced {
		return nil, fmt.Errorf("编辑文件 %q 失败: old_string 不存在", input.FilePath)
	}

	if err := os.WriteFile(input.FilePath, []byte(updated), 0644); err != nil {
		return nil, fmt.Errorf("写回文件 %q 失败: %w", input.FilePath, err)
	}
	return &pathOutput{Path: input.FilePath}, nil
}

// multiEdit 按顺序应用多组字符串替换。
func (e *Executor) multiEdit(raw json.RawMessage) (*pathOutput, error) {
	var input multiEditInput
	if err := json.Unmarshal(raw, &input); err != nil {
		return nil, fmt.Errorf("解析 MultiEdit 参数失败: %w", err)
	}
	if input.FilePath == "" {
		return nil, fmt.Errorf("MultiEdit 缺少 file_path")
	}

	content, err := os.ReadFile(input.FilePath)
	if err != nil {
		return nil, fmt.Errorf("读取文件 %q 失败: %w", input.FilePath, err)
	}

	updated := string(content)
	for i, edit := range input.Edits {
		var replaced bool
		updated, replaced, err = replaceContent(updated, edit.OldString, edit.NewString, false)
		if err != nil {
			return nil, fmt.Errorf("应用 MultiEdit 第 %d 项失败: %w", i, err)
		}
		if !replaced {
			return nil, fmt.Errorf("应用 MultiEdit 第 %d 项失败: old_string 不存在", i)
		}
	}

	if err := os.WriteFile(input.FilePath, []byte(updated), 0644); err != nil {
		return nil, fmt.Errorf("写回文件 %q 失败: %w", input.FilePath, err)
	}
	return &pathOutput{Path: input.FilePath}, nil
}

// replaceContent 统一处理单次或全量替换，并显式检查 old_string 是否存在。
func replaceContent(content, oldString, newString string, replaceAll bool) (string, bool, error) {
	if oldString == "" {
		return "", false, fmt.Errorf("old_string 不能为空")
	}
	if !strings.Contains(content, oldString) {
		return content, false, nil
	}
	if replaceAll {
		return strings.ReplaceAll(content, oldString, newString), true, nil
	}
	return strings.Replace(content, oldString, newString, 1), true, nil
}
