package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"syscall"

	"github.com/alireza-anari/madar-vpn/speed-enforcer/internal/config"
	"github.com/alireza-anari/madar-vpn/speed-enforcer/internal/health"
	"github.com/alireza-anari/madar-vpn/speed-enforcer/internal/limit"
	"github.com/alireza-anari/madar-vpn/speed-enforcer/internal/socks"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	os.Exit(runContext(ctx, os.Args[1:], os.Stdout, os.Stderr))
}

func runContext(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("madar-speed-enforcer", flag.ContinueOnError)
	fs.SetOutput(stderr)
	configPath := fs.String("config", "", "path to speed enforcer config")
	testOnly := fs.Bool("test", false, "validate config and exit")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *configPath == "" {
		fmt.Fprintln(stderr, "--config is required")
		return 2
	}
	cfg, err := config.Load(*configPath)
	if err != nil {
		fmt.Fprintln(stderr, "config validation failed")
		return 1
	}
	if *testOnly {
		fmt.Fprintln(stdout, "config valid")
		return 0
	}
	registry, err := limit.NewRegistry(cfg, nil)
	if err != nil {
		fmt.Fprintln(stderr, "limiter initialization failed")
		return 1
	}
	tcpListener, err := net.Listen("tcp", cfg.Listener)
	if err != nil {
		fmt.Fprintln(stderr, "SOCKS listener initialization failed")
		return 1
	}
	defer tcpListener.Close()
	healthServer := health.New(cfg.HealthSocket, cfg.Generation)
	healthListener, err := healthServer.Listen()
	if err != nil {
		fmt.Fprintln(stderr, "health listener initialization failed")
		return 1
	}
	defer func() { _ = healthListener.Close(); _ = os.Remove(cfg.HealthSocket) }()
	socksServer := socks.NewServer(cfg, registry, nil, nil)
	defer socksServer.Close()
	errCh := make(chan error, 2)
	go func() { errCh <- socksServer.Serve(tcpListener) }()
	go func() { errCh <- healthServer.Serve(ctx, healthListener) }()
	fmt.Fprintf(stdout, "ready generation=%d clients=%d\n", cfg.Generation, len(cfg.Clients))
	select {
	case <-ctx.Done():
		_ = tcpListener.Close()
		socksServer.Close()
		_ = healthListener.Close()
		return 0
	case err := <-errCh:
		if err != nil {
			fmt.Fprintln(stderr, "runtime component failed")
			return 1
		}
		return 0
	}
}
