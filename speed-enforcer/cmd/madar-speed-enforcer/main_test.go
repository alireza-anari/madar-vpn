package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testVerifier(alias, password string) string {
	sum := sha256.Sum256([]byte("verifier-v1\x00" + alias + "\x00" + password))
	return hex.EncodeToString(sum[:])
}
func freeTCPPort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}
func writeConfig(t *testing.T, dir string, port int) (string, string, string) {
	t.Helper()
	alias := "opaque-alias"
	password := "never-log-me"
	verifier := testVerifier(alias, password)
	path := filepath.Join(dir, "speed.json")
	health := filepath.Join(dir, "health.sock")
	raw := fmt.Sprintf(`{"generation":42,"listener":"127.0.0.1:%d","healthSocket":%q,"clients":[{"alias":%q,"passwordVerifier":%q,"uploadBytesPerSecond":625000,"uploadBurstBytes":312500,"downloadBytesPerSecond":625000,"downloadBurstBytes":312500}]}`, port, health, alias, verifier)
	if err := os.WriteFile(path, []byte(raw), 0600); err != nil {
		t.Fatal(err)
	}
	return path, alias, verifier
}

func TestRunTestModeValidatesWithoutRuntimeMutationOrSecrets(t *testing.T) {
	dir := t.TempDir()
	cfg, alias, verifier := writeConfig(t, dir, 10808)
	var out, errOut bytes.Buffer
	if code := runContext(context.Background(), []string{"--config", cfg, "--test"}, &out, &errOut); code != 0 {
		t.Fatalf("code=%d stderr=%s", code, errOut.String())
	}
	if _, err := os.Stat(filepath.Join(dir, "health.sock")); !os.IsNotExist(err) {
		t.Fatalf("health socket created in --test: %v", err)
	}
	combined := out.String() + errOut.String()
	if strings.Contains(combined, alias) || strings.Contains(combined, verifier) {
		t.Fatalf("sensitive config leaked: %q", combined)
	}
}

func TestRunTestModeRejectsInvalidConfig(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "bad.json")
	if err := os.WriteFile(path, []byte(`{"generation":0}`), 0600); err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	if code := runContext(context.Background(), []string{"--config", path, "--test"}, &out, &errOut); code == 0 {
		t.Fatal("invalid config accepted")
	}
}

func TestRunContextStartsReadyRuntimeAndCleansUpOnCancel(t *testing.T) {
	dir := t.TempDir()
	cfg, alias, verifier := writeConfig(t, dir, freeTCPPort(t))
	var out, errOut bytes.Buffer
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan int, 1)
	go func() { done <- runContext(ctx, []string{"--config", cfg}, &out, &errOut) }()
	health := filepath.Join(dir, "health.sock")
	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, err := os.Stat(health); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("health socket did not appear: %s", errOut.String())
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	select {
	case code := <-done:
		if code != 0 {
			t.Fatalf("code=%d stderr=%s", code, errOut.String())
		}
	case <-time.After(2 * time.Second):
		t.Fatal("runtime did not stop after cancellation")
	}
	if _, err := os.Stat(health); !os.IsNotExist(err) {
		t.Fatalf("health socket left after shutdown: %v", err)
	}
	combined := out.String() + errOut.String()
	if strings.Contains(combined, alias) || strings.Contains(combined, verifier) {
		t.Fatalf("sensitive config leaked: %q", combined)
	}
}
