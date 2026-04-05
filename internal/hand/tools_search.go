package hand

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

type grepInput struct {
	Pattern string `json:"pattern"`
	Path    string `json:"path,omitempty"`
	Glob    string `json:"glob,omitempty"`
}

type grepOutput struct {
	Matches []grepMatch `json:"matches"`
}

type grepMatch struct {
	File string `json:"file"`
	Line int    `json:"line"`
	Text string `json:"text"`
}

type globInput struct {
	Pattern string `json:"pattern"`
	Path    string `json:"path,omitempty"`
}

type globOutput struct {
	Files []string `json:"files"`
}

// grep 优先调用系统 grep，不可用时回退到纯 Go 实现。
func (e *Executor) grep(raw json.RawMessage) (*grepOutput, error) {
	var input grepInput
	if err := json.Unmarshal(raw, &input); err != nil {
		return nil, fmt.Errorf("解析 Grep 参数失败: %w", err)
	}
	if input.Pattern == "" {
		return nil, fmt.Errorf("Grep 缺少 pattern")
	}

	searchRoot := input.Path
	if searchRoot == "" {
		searchRoot = "."
	}

	if grepPath, err := exec.LookPath("grep"); err == nil {
		return runSystemGrep(grepPath, searchRoot, input)
	}
	return runGoGrep(searchRoot, input)
}

// glob 搜索匹配的文件路径。
func (e *Executor) glob(raw json.RawMessage) (*globOutput, error) {
	var input globInput
	if err := json.Unmarshal(raw, &input); err != nil {
		return nil, fmt.Errorf("解析 Glob 参数失败: %w", err)
	}
	if input.Pattern == "" {
		return nil, fmt.Errorf("Glob 缺少 pattern")
	}

	searchRoot := input.Path
	if searchRoot == "" {
		searchRoot = "."
	}

	files := make([]string, 0)
	err := filepath.WalkDir(searchRoot, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if matched, err := filepath.Match(input.Pattern, filepath.Base(path)); err == nil && matched {
			files = append(files, path)
		}
		rel, err := filepath.Rel(searchRoot, path)
		if err == nil {
			if matched, matchErr := filepath.Match(input.Pattern, rel); matchErr == nil && matched {
				if len(files) == 0 || files[len(files)-1] != path {
					files = append(files, path)
				}
			}
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("执行 Glob 失败: %w", err)
	}

	return &globOutput{Files: files}, nil
}

func runSystemGrep(grepPath, searchRoot string, input grepInput) (*grepOutput, error) {
	args := []string{"-rn", input.Pattern, searchRoot}
	if input.Glob != "" {
		args = append(args, "--include", input.Glob)
	}

	cmd := exec.Command(grepPath, args...)
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	if err != nil {
		// grep 返回 1 表示未匹配，不算错误。
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
			return &grepOutput{Matches: []grepMatch{}}, nil
		}
		return nil, fmt.Errorf("执行系统 grep 失败: %w, stderr=%s", err, strings.TrimSpace(stderr.String()))
	}

	return parseGrepOutput(stdout.String()), nil
}

func runGoGrep(searchRoot string, input grepInput) (*grepOutput, error) {
	matches := make([]grepMatch, 0)
	err := filepath.WalkDir(searchRoot, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.IsDir() {
			return nil
		}
		if input.Glob != "" {
			matched, err := filepath.Match(input.Glob, filepath.Base(path))
			if err != nil {
				return err
			}
			if !matched {
				return nil
			}
		}

		file, err := os.Open(path)
		if err != nil {
			return err
		}
		defer file.Close()

		scanner := bufio.NewScanner(file)
		lineNo := 0
		for scanner.Scan() {
			lineNo++
			text := scanner.Text()
			if strings.Contains(text, input.Pattern) {
				matches = append(matches, grepMatch{
					File: path,
					Line: lineNo,
					Text: text,
				})
			}
		}
		return scanner.Err()
	})
	if err != nil {
		return nil, fmt.Errorf("执行 Go Grep 失败: %w", err)
	}

	return &grepOutput{Matches: matches}, nil
}

func parseGrepOutput(output string) *grepOutput {
	matches := make([]grepMatch, 0)
	for _, line := range strings.Split(strings.TrimSpace(output), "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, ":", 3)
		if len(parts) != 3 {
			continue
		}
		lineNo, err := strconv.Atoi(parts[1])
		if err != nil {
			continue
		}
		matches = append(matches, grepMatch{
			File: parts[0],
			Line: lineNo,
			Text: parts[2],
		})
	}
	return &grepOutput{Matches: matches}
}
