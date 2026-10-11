package health

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestListenCreatesRootOnlyUnixSocketAndExactHealthResponse(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "health.sock")
	srv := New(path, 123)
	ln, err := srv.Listen()
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	defer os.Remove(path)
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("mode=%#o want 0600", info.Mode().Perm())
	}
	if info.Mode()&os.ModeSocket == 0 {
		t.Fatalf("not a socket: %v", info.Mode())
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = srv.Serve(ctx, ln) }()
	dialer := &net.Dialer{}
	tr := &http.Transport{DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		return dialer.DialContext(ctx, "unix", path)
	}}
	client := &http.Client{Transport: tr, Timeout: time.Second}
	defer tr.CloseIdleConnections()
	resp, err := client.Get("http://unix/health")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d", resp.StatusCode)
	}
	var body map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"generation": float64(123), "ready": true}
	if !reflect.DeepEqual(body, want) {
		t.Fatalf("body=%v want=%v", body, want)
	}
}

func TestHealthRejectsNonGetAndUnknownPathWithoutSensitiveFields(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "health.sock")
	srv := New(path, 9)
	ln, err := srv.Listen()
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	defer os.Remove(path)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = srv.Serve(ctx, ln) }()
	conn, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	fmt.Fprintf(conn, "POST /health HTTP/1.1\r\nHost: unix\r\nContent-Length: 0\r\n\r\n")
	status, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	if status != "HTTP/1.1 405 Method Not Allowed\r\n" {
		t.Fatalf("status=%q", status)
	}
}

func TestListenRejectsSymlinkAndRegularFile(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target")
	if err := os.WriteFile(target, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "health.sock")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if _, err := New(link, 1).Listen(); err == nil {
		t.Fatal("symlink socket path accepted")
	}
	if got, _ := os.ReadFile(target); string(got) != "x" {
		t.Fatalf("target modified: %q", got)
	}
	_ = os.Remove(link)
	if err := os.WriteFile(link, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := New(link, 1).Listen(); err == nil {
		t.Fatal("regular-file socket path accepted")
	}
	if got, _ := os.ReadFile(link); string(got) != "keep" {
		t.Fatalf("regular file modified: %q", got)
	}
}

func TestListenReplacesOnlyStaleUnixSocket(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "health.sock")
	old, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	if err := old.Close(); err != nil {
		t.Fatal(err)
	}
	ln, err := New(path, 2).Listen()
	if err != nil {
		t.Fatal(err)
	}
	ln.Close()
	os.Remove(path)
}
