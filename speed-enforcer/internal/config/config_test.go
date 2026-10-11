package config

import (
	"fmt"
	"strings"
	"testing"
)

const validVerifier = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func validJSON() string {
	return fmt.Sprintf(`{
      "generation": 7,
      "listener": "127.0.0.1:10808",
      "healthSocket": "/run/madar-node-agent/speed-enforcer.sock",
      "clients": [{
        "alias": "opaque-user",
        "passwordVerifier": %q,
        "uploadBytesPerSecond": 625000,
        "uploadBurstBytes": 312500,
        "downloadBytesPerSecond": 625000,
        "downloadBurstBytes": 312500
      }]
    }`, validVerifier)
}

func TestParseAcceptsStrictValidConfig(t *testing.T) {
	cfg, err := Parse([]byte(validJSON()))
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	if cfg.Generation != 7 || len(cfg.Clients) != 1 {
		t.Fatalf("unexpected config: %#v", cfg)
	}
}

func TestParseAllowsZeroClients(t *testing.T) {
	raw := strings.Replace(validJSON(), `"clients": [{
        "alias": "opaque-user",
        "passwordVerifier": "`+validVerifier+`",
        "uploadBytesPerSecond": 625000,
        "uploadBurstBytes": 312500,
        "downloadBytesPerSecond": 625000,
        "downloadBurstBytes": 312500
      }]`, `"clients": []`, 1)
	cfg, err := Parse([]byte(raw))
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	if len(cfg.Clients) != 0 {
		t.Fatalf("clients = %d", len(cfg.Clients))
	}
}

func TestParseRejectsInvalidShape(t *testing.T) {
	tests := []struct{ name, old, new string }{
		{"zero generation", `"generation": 7`, `"generation": 0`},
		{"public listener", `"listener": "127.0.0.1:10808"`, `"listener": "0.0.0.0:10808"`},
		{"hostname listener", `"listener": "127.0.0.1:10808"`, `"listener": "localhost:10808"`},
		{"relative health", `"healthSocket": "/run/madar-node-agent/speed-enforcer.sock"`, `"healthSocket": "speed.sock"`},
		{"empty alias", `"alias": "opaque-user"`, `"alias": ""`},
		{"upper verifier", validVerifier, strings.ToUpper(validVerifier)},
		{"short verifier", validVerifier, validVerifier[:62]},
		{"zero upload rate", `"uploadBytesPerSecond": 625000`, `"uploadBytesPerSecond": 0`},
		{"zero upload burst", `"uploadBurstBytes": 312500`, `"uploadBurstBytes": 0`},
		{"zero download rate", `"downloadBytesPerSecond": 625000`, `"downloadBytesPerSecond": 0`},
		{"zero download burst", `"downloadBurstBytes": 312500`, `"downloadBurstBytes": 0`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			raw := strings.Replace(validJSON(), tt.old, tt.new, 1)
			if _, err := Parse([]byte(raw)); err == nil {
				t.Fatal("Parse() unexpectedly succeeded")
			}
		})
	}
}

func TestParseAcceptsIPv6LoopbackListener(t *testing.T) {
	raw := strings.Replace(validJSON(), `"listener": "127.0.0.1:10808"`, `"listener": "[::1]:10808"`, 1)
	if _, err := Parse([]byte(raw)); err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
}

func TestParseRejectsDuplicateAlias(t *testing.T) {
	client := fmt.Sprintf(`{"alias":"same","passwordVerifier":%q,"uploadBytesPerSecond":1,"uploadBurstBytes":1,"downloadBytesPerSecond":1,"downloadBurstBytes":1}`, validVerifier)
	raw := fmt.Sprintf(`{"generation":1,"listener":"127.0.0.1:10808","healthSocket":"/tmp/health.sock","clients":[%s,%s]}`, client, client)
	if _, err := Parse([]byte(raw)); err == nil {
		t.Fatal("Parse() unexpectedly succeeded")
	}
}

func TestParseRejectsUnknownFieldsAndTrailingJSON(t *testing.T) {
	raw := strings.Replace(validJSON(), `"generation": 7,`, `"generation": 7, "extra": true,`, 1)
	if _, err := Parse([]byte(raw)); err == nil {
		t.Fatal("unknown field accepted")
	}
	if _, err := Parse([]byte(validJSON() + ` {}`)); err == nil {
		t.Fatal("trailing JSON accepted")
	}
}
