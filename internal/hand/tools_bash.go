package hand

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"time"
)

const defaultBashTimeout = 120

type bashInput struct {
	Command string `json:"command"`
	Timeout *int   `json:"timeout,omitempty"`
}

type bashOutput struct {
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	ExitCode int    `json:"exit_code"`
}

// bash 通过系统 shell 执行命令并返回 stdout/stderr/exit_code。
func (e *Executor) bash(raw json.RawMessage) (*bashOutput, error) {
	var input bashInput
	if err := json.Unmarshal(raw, &input); err != nil {
		return nil, fmt.Errorf("解析 Bash 参数失败: %w", err)
	}
	if input.Command == "" {
		return nil, fmt.Errorf("Bash 缺少 command")
	}

	timeoutSeconds := defaultBashTimeout
	if input.Timeout != nil {
		if *input.Timeout <= 0 {
			return nil, fmt.Errorf("Bash 的 timeout 必须大于 0")
		}
		timeoutSeconds = *input.Timeout
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutSeconds)*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "sh", "-c", input.Command)
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	exitCode := 0
	if ctx.Err() == context.DeadlineExceeded {
		return &bashOutput{
			Stdout:   stdout.String(),
			Stderr:   stderr.String(),
			ExitCode: -1,
		}, fmt.Errorf("Bash 执行超时: %d 秒", timeoutSeconds)
	}
	if err != nil {
		var exitErr *exec.ExitError
		if ok := errors.As(err, &exitErr); ok {
			exitCode = exitErr.ExitCode()
		} else {
			return nil, fmt.Errorf("执行 Bash 命令失败: %w", err)
		}
	}

	return &bashOutput{
		Stdout:   stdout.String(),
		Stderr:   stderr.String(),
		ExitCode: exitCode,
	}, nil
}
