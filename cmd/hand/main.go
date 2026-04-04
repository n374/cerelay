package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/anthropics/axon/internal/hand"
)

func main() {
	// --- 参数解析 ---
	serverHost := flag.String("server", "localhost:8765", "Axon Server 地址（host:port）")
	cwd := flag.String("cwd", "", "工作目录（默认当前目录）")
	flag.Parse()

	if *cwd == "" {
		dir, err := os.Getwd()
		if err != nil {
			fmt.Fprintf(os.Stderr, "获取当前目录失败: %v\n", err)
			os.Exit(1)
		}
		*cwd = dir
	}

	serverURL := "ws://" + *serverHost + "/ws"

	// --- 建立连接 ---
	client := hand.NewClient(serverURL)
	if err := client.Connect(); err != nil {
		fmt.Fprintf(os.Stderr, "连接失败: %v\n", err)
		os.Exit(1)
	}
	defer client.Close()

	// --- 创建 Session ---
	if err := client.SendCreateSession(*cwd); err != nil {
		fmt.Fprintf(os.Stderr, "创建 Session 失败: %v\n", err)
		os.Exit(1)
	}

	// --- 捕获 Ctrl+C ---
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sigCh
		fmt.Println("\n\033[90m已退出\033[0m")
		client.Close()
		os.Exit(0)
	}()

	ui := &hand.UI{}
	fmt.Printf("\033[1m\033[36mAxon Hand CLI\033[0m — 输入 /quit 退出\n\n")

	// --- 交互循环 ---
	for {
		input, err := ui.ReadInput("你>")
		if err != nil {
			if err == io.EOF {
				fmt.Println()
				break
			}
			ui.PrintError(fmt.Sprintf("读取输入失败: %v", err))
			break
		}

		input = strings.TrimSpace(input)
		if input == "" {
			continue
		}
		if input == "/quit" || input == "/exit" {
			fmt.Println("\033[90m再见！\033[0m")
			break
		}

		// 发送 prompt
		if err := client.SendPrompt(input); err != nil {
			ui.PrintError(fmt.Sprintf("发送 prompt 失败: %v", err))
			break
		}

		// 运行消息循环直到 session_end（prompt 完成，session 仍存活可复用）
		fmt.Println()
		if err := client.Run(); err != nil {
			ui.PrintError(fmt.Sprintf("消息循环错误: %v", err))
			break
		}
		fmt.Println()
	}
}
