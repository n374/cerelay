package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/anthropics/axon/internal/server"
)

func main() {
	var (
		port  = flag.Int("port", 8765, "监听端口")
		model = flag.String("model", "", "默认模型（空则使用 claude CLI 默认值）")
	)
	flag.Parse()

	srv := server.NewServer(*port, *model)

	// 在后台启动服务器
	errCh := make(chan error, 1)
	go func() {
		if err := srv.Start(); err != nil && err != http.ErrServerClosed {
			errCh <- err
		}
	}()

	// 等待信号或启动失败
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	select {
	case err := <-errCh:
		log.Fatalf("[main] 服务器启动失败: %v", err)
	case sig := <-sigCh:
		log.Printf("[main] 收到信号 %s，开始优雅关闭...", sig)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		log.Printf("[main] 优雅关闭失败: %v", err)
		os.Exit(1)
	}
	log.Println("[main] 服务器已停止")
}
