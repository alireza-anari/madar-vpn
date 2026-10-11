package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

var verifierPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

type Config struct {
	Generation   int64    `json:"generation"`
	Listener     string   `json:"listener"`
	HealthSocket string   `json:"healthSocket"`
	Clients      []Client `json:"clients"`
}

type Client struct {
	Alias                  string `json:"alias"`
	PasswordVerifier       string `json:"passwordVerifier"`
	UploadBytesPerSecond   int64  `json:"uploadBytesPerSecond"`
	UploadBurstBytes       int64  `json:"uploadBurstBytes"`
	DownloadBytesPerSecond int64  `json:"downloadBytesPerSecond"`
	DownloadBurstBytes     int64  `json:"downloadBurstBytes"`
}

func Load(path string) (Config, error) {
	data, err := osReadFile(path)
	if err != nil {
		return Config{}, err
	}
	return Parse(data)
}

var osReadFile = func(path string) ([]byte, error) {
	return os.ReadFile(path)
}

func Parse(data []byte) (Config, error) {
	var cfg Config
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&cfg); err != nil {
		return Config{}, fmt.Errorf("decode config: %w", err)
	}
	var trailing any
	if err := dec.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return Config{}, errors.New("trailing JSON value")
		}
		return Config{}, fmt.Errorf("trailing JSON: %w", err)
	}
	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func (c Config) Validate() error {
	if c.Generation <= 0 {
		return errors.New("generation must be positive")
	}
	if err := validateListener(c.Listener); err != nil {
		return err
	}
	if !filepath.IsAbs(c.HealthSocket) {
		return errors.New("health socket must be absolute")
	}
	aliases := make(map[string]struct{}, len(c.Clients))
	for i, client := range c.Clients {
		if client.Alias == "" {
			return fmt.Errorf("client %d alias must be non-empty", i)
		}
		if _, ok := aliases[client.Alias]; ok {
			return fmt.Errorf("duplicate alias")
		}
		aliases[client.Alias] = struct{}{}
		if !verifierPattern.MatchString(client.PasswordVerifier) {
			return fmt.Errorf("client %d invalid password verifier", i)
		}
		if client.UploadBytesPerSecond <= 0 || client.UploadBurstBytes <= 0 || client.DownloadBytesPerSecond <= 0 || client.DownloadBurstBytes <= 0 {
			return fmt.Errorf("client %d rate and burst values must be positive", i)
		}
	}
	return nil
}

func validateListener(value string) error {
	host, portText, err := net.SplitHostPort(value)
	if err != nil {
		return fmt.Errorf("invalid listener: %w", err)
	}
	if host != "127.0.0.1" && host != "::1" {
		return errors.New("listener must use exact loopback address")
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65535 {
		return errors.New("listener port out of range")
	}
	return nil
}
