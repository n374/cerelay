package hand

import (
	"bufio"
	"fmt"
	"os"
	"strings"
)

// ANSI 颜色码
const (
	colorReset  = "\033[0m"
	colorBold   = "\033[1m"
	colorGray   = "\033[90m"
	colorYellow = "\033[33m"
	colorGreen  = "\033[32m"
	colorRed    = "\033[31m"
	colorCyan   = "\033[36m"
)

// UI 终端交互
type UI struct{}

// PrintText 打印 LLM 文本输出（默认颜色）
func (u *UI) PrintText(text string) {
	fmt.Print(text)
}

// PrintThought 打印思考过程（灰色）
func (u *UI) PrintThought(text string) {
	fmt.Printf("%s%s%s", colorGray, text, colorReset)
}

// PrintToolCall 打印工具调用信息（黄色）
func (u *UI) PrintToolCall(method string, params any) {
	fmt.Printf("%s%s[工具调用] %s%s\n", colorBold, colorYellow, method, colorReset)
	if params != nil {
		fmt.Printf("%s  参数: %v%s\n", colorYellow, params, colorReset)
	}
}

// PrintToolResult 打印工具执行结果（绿色/红色）
func (u *UI) PrintToolResult(method string, success bool) {
	if success {
		fmt.Printf("%s[完成] %s%s\n", colorGreen, method, colorReset)
	} else {
		fmt.Printf("%s[失败] %s%s\n", colorRed, method, colorReset)
	}
}

// PrintError 打印错误（红色）
func (u *UI) PrintError(msg string) {
	fmt.Fprintf(os.Stderr, "%s%s错误: %s%s\n", colorBold, colorRed, msg, colorReset)
}

// PrintSessionEnd 打印会话结束
func (u *UI) PrintSessionEnd(result string, errMsg string) {
	fmt.Printf("\n%s%s--- 会话结束 ---%s\n", colorBold, colorCyan, colorReset)
	if result != "" {
		fmt.Printf("%s结果: %s%s\n", colorCyan, result, colorReset)
	}
	if errMsg != "" {
		fmt.Printf("%s错误: %s%s\n", colorRed, errMsg, colorReset)
	}
}

// ReadInput 从 stdin 读取用户输入
func (u *UI) ReadInput(prompt string) (string, error) {
	fmt.Printf("%s%s%s ", colorBold, prompt, colorReset)
	reader := bufio.NewReader(os.Stdin)
	line, err := reader.ReadString('\n')
	if err != nil {
		return "", err
	}
	return strings.TrimRight(line, "\r\n"), nil
}
