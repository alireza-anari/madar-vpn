package socks

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alireza-anari/madar-vpn/speed-enforcer/internal/config"
	"github.com/alireza-anari/madar-vpn/speed-enforcer/internal/limit"
)

type instantClock struct {
	mu    sync.Mutex
	now   time.Time
	slept time.Duration
}

func newInstantClock() *instantClock { return &instantClock{now: time.Unix(0, 0)} }
func (c *instantClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}
func (c *instantClock) Sleep(ctx context.Context, d time.Duration) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.slept += d
	c.mu.Unlock()
	return nil
}
func (c *instantClock) Slept() time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.slept
}

type captureLogger struct {
	mu sync.Mutex
	b  strings.Builder
}

func (l *captureLogger) Printf(format string, args ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	fmt.Fprintf(&l.b, format, args...)
}
func (l *captureLogger) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

func verifier(alias, password string) string {
	sum := sha256.Sum256([]byte("verifier-v1\x00" + alias + "\x00" + password))
	return hex.EncodeToString(sum[:])
}

func serverConfig(alias, password string, burst int64) config.Config {
	return config.Config{Generation: 1, Listener: "127.0.0.1:10808", HealthSocket: "/tmp/health.sock", Clients: []config.Client{{
		Alias: alias, PasswordVerifier: verifier(alias, password),
		UploadBytesPerSecond: 1000, UploadBurstBytes: burst,
		DownloadBytesPerSecond: 1000, DownloadBurstBytes: burst,
	}}}
}

func startEcho(t *testing.T, network, address string) (net.Listener, string) {
	t.Helper()
	ln, err := net.Listen(network, address)
	if err != nil {
		t.Skipf("listen %s unavailable: %v", network, err)
	}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				_, _ = io.Copy(c, c)
			}(c)
		}
	}()
	return ln, ln.Addr().String()
}

func startServer(t *testing.T, cfg config.Config, clock limit.Clock, logger Logger) (net.Listener, string) {
	t.Helper()
	registry, err := limit.NewRegistry(cfg, clock)
	if err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := NewServer(cfg, registry, nil, logger)
	go func() { _ = s.Serve(ln) }()
	return ln, ln.Addr().String()
}

func authenticate(t *testing.T, conn net.Conn, alias, password string) byte {
	t.Helper()
	if _, err := conn.Write([]byte{5, 1, 2}); err != nil {
		t.Fatal(err)
	}
	resp := make([]byte, 2)
	if _, err := io.ReadFull(conn, resp); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(resp, []byte{5, 2}) {
		t.Fatalf("method response=%v", resp)
	}
	msg := []byte{1, byte(len(alias))}
	msg = append(msg, []byte(alias)...)
	msg = append(msg, byte(len(password)))
	msg = append(msg, []byte(password)...)
	if _, err := conn.Write(msg); err != nil {
		t.Fatal(err)
	}
	auth := make([]byte, 2)
	if _, err := io.ReadFull(conn, auth); err != nil {
		t.Fatal(err)
	}
	return auth[1]
}

func connectRequest(t *testing.T, conn net.Conn, cmd byte, host string, port int) byte {
	t.Helper()
	req := []byte{5, cmd, 0}
	ip := net.ParseIP(host)
	if ip4 := ip.To4(); ip4 != nil {
		req = append(req, 1)
		req = append(req, ip4...)
	} else if ip6 := ip.To16(); ip6 != nil {
		req = append(req, 4)
		req = append(req, ip6...)
	} else {
		req = append(req, 3, byte(len(host)))
		req = append(req, []byte(host)...)
	}
	req = append(req, byte(port>>8), byte(port))
	if _, err := conn.Write(req); err != nil {
		t.Fatal(err)
	}
	head := make([]byte, 3)
	if _, err := io.ReadFull(conn, head); err != nil {
		t.Fatal(err)
	}
	if head[0] != 5 {
		t.Fatalf("version=%v", head)
	}
	if head[1] != 0 {
		return head[1]
	}
	if _, err := readAddress(conn); err != nil {
		t.Fatal(err)
	}
	return 0
}

func TestServerRejectsNoAuth(t *testing.T) {
	cfg := serverConfig("opaque", "secret", 32)
	ln, addr := startServer(t, cfg, newInstantClock(), &captureLogger{})
	defer ln.Close()
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_, _ = c.Write([]byte{5, 1, 0})
	resp := make([]byte, 2)
	_, _ = io.ReadFull(c, resp)
	if !bytes.Equal(resp, []byte{5, 0xff}) {
		t.Fatalf("response=%v", resp)
	}
}

func TestServerRejectsWrongPasswordWithoutLoggingSecrets(t *testing.T) {
	logger := &captureLogger{}
	cfg := serverConfig("opaque", "correct-secret", 32)
	ln, addr := startServer(t, cfg, newInstantClock(), logger)
	defer ln.Close()
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if status := authenticate(t, c, "opaque", "wrong-secret"); status == 0 {
		t.Fatal("wrong password accepted")
	}
	logs := logger.String()
	if strings.Contains(logs, "opaque") || strings.Contains(logs, "wrong-secret") || strings.Contains(logs, "correct-secret") {
		t.Fatalf("secret leaked in logs: %q", logs)
	}
}

func TestServerConnectIPv4AndUsesDirectionalLimits(t *testing.T) {
	echo, origin := startEcho(t, "tcp", "127.0.0.1:0")
	defer echo.Close()
	host, portText, _ := net.SplitHostPort(origin)
	port, _ := strconv.Atoi(portText)
	clock := newInstantClock()
	cfg := serverConfig("opaque", "secret", 4)
	ln, addr := startServer(t, cfg, clock, &captureLogger{})
	defer ln.Close()
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if authenticate(t, c, "opaque", "secret") != 0 {
		t.Fatal("auth failed")
	}
	if rep := connectRequest(t, c, 1, host, port); rep != 0 {
		t.Fatalf("connect reply=%d", rep)
	}
	payload := []byte("hello")
	if _, err := c.Write(payload); err != nil {
		t.Fatal(err)
	}
	got := make([]byte, len(payload))
	if _, err := io.ReadFull(c, got); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("echo=%q", got)
	}
	if clock.Slept() == 0 {
		t.Fatal("expected limiter waits for payload larger than burst")
	}
}

func TestServerConnectDomain(t *testing.T) {
	echo, origin := startEcho(t, "tcp", "127.0.0.1:0")
	defer echo.Close()
	_, portText, _ := net.SplitHostPort(origin)
	port, _ := strconv.Atoi(portText)
	cfg := serverConfig("opaque", "secret", 64)
	ln, addr := startServer(t, cfg, newInstantClock(), &captureLogger{})
	defer ln.Close()
	c, _ := net.Dial("tcp", addr)
	defer c.Close()
	if authenticate(t, c, "opaque", "secret") != 0 {
		t.Fatal("auth failed")
	}
	if rep := connectRequest(t, c, 1, "localhost", port); rep != 0 {
		t.Fatalf("connect reply=%d", rep)
	}
}

func TestServerConnectIPv6(t *testing.T) {
	echo, origin := startEcho(t, "tcp6", "[::1]:0")
	defer echo.Close()
	host, portText, _ := net.SplitHostPort(origin)
	port, _ := strconv.Atoi(portText)
	cfg := serverConfig("opaque", "secret", 64)
	ln, addr := startServer(t, cfg, newInstantClock(), &captureLogger{})
	defer ln.Close()
	c, _ := net.Dial("tcp", addr)
	defer c.Close()
	if authenticate(t, c, "opaque", "secret") != 0 {
		t.Fatal("auth failed")
	}
	if rep := connectRequest(t, c, 1, host, port); rep != 0 {
		t.Fatalf("connect reply=%d", rep)
	}
}

func TestServerRejectsBind(t *testing.T) {
	cfg := serverConfig("opaque", "secret", 64)
	ln, addr := startServer(t, cfg, newInstantClock(), &captureLogger{})
	defer ln.Close()
	c, _ := net.Dial("tcp", addr)
	defer c.Close()
	if authenticate(t, c, "opaque", "secret") != 0 {
		t.Fatal("auth failed")
	}
	if rep := connectRequest(t, c, 2, "127.0.0.1", 80); rep != 7 {
		t.Fatalf("BIND reply=%d want 7", rep)
	}
}

func TestServerHandshakeTimeoutIsBounded(t *testing.T) {
	cfg := serverConfig("opaque", "secret", 64)
	registry, _ := limit.NewRegistry(cfg, newInstantClock())
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	s := NewServer(cfg, registry, nil, &captureLogger{})
	s.handshakeTimeout = 30 * time.Millisecond
	go func() { _ = s.Serve(ln) }()
	c, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	time.Sleep(80 * time.Millisecond)
	_ = c.SetReadDeadline(time.Now().Add(50 * time.Millisecond))
	one := make([]byte, 1)
	if _, err := c.Read(one); err == nil {
		t.Fatal("idle handshake remained open")
	}
}
