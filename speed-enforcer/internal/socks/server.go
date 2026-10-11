package socks

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"strconv"
	"sync"
	"time"

	"github.com/alireza-anari/madar-vpn/speed-enforcer/internal/config"
	"github.com/alireza-anari/madar-vpn/speed-enforcer/internal/limit"
)

const (
	socksVersion       = 0x05
	userPassMethod     = 0x02
	noAcceptableMethod = 0xff
	cmdConnect         = 0x01
)

type DialFunc func(ctx context.Context, network, address string) (net.Conn, error)

type Logger interface{ Printf(format string, args ...any) }

type discardLogger struct{}

func (discardLogger) Printf(string, ...any) {}

type Server struct {
	cfg              config.Config
	registry         *limit.Registry
	dial             DialFunc
	log              Logger
	handshakeTimeout time.Duration
	clients          map[string]string
}

func NewServer(cfg config.Config, registry *limit.Registry, dial DialFunc, logger Logger) *Server {
	if dial == nil {
		d := &net.Dialer{Timeout: 10 * time.Second}
		dial = d.DialContext
	}
	if logger == nil {
		logger = discardLogger{}
	}
	clients := make(map[string]string, len(cfg.Clients))
	for _, client := range cfg.Clients {
		clients[client.Alias] = client.PasswordVerifier
	}
	return &Server{cfg: cfg, registry: registry, dial: dial, log: logger, handshakeTimeout: 5 * time.Second, clients: clients}
}

func (s *Server) Serve(listener net.Listener) error {
	for {
		conn, err := listener.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			var ne net.Error
			if errors.As(err, &ne) && ne.Temporary() {
				continue
			}
			return err
		}
		go s.handle(conn)
	}
}

func (s *Server) handle(conn net.Conn) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(s.handshakeTimeout))
	alias, err := s.negotiate(conn)
	if err != nil {
		s.log.Printf("SOCKS handshake rejected")
		return
	}
	if err := s.handleRequest(conn, alias); err != nil {
		s.log.Printf("SOCKS request failed")
	}
}

func (s *Server) negotiate(conn net.Conn) (string, error) {
	var head [2]byte
	if _, err := io.ReadFull(conn, head[:]); err != nil {
		return "", err
	}
	if head[0] != socksVersion || head[1] == 0 {
		return "", errors.New("invalid greeting")
	}
	methods := make([]byte, int(head[1]))
	if _, err := io.ReadFull(conn, methods); err != nil {
		return "", err
	}
	found := false
	for _, method := range methods {
		if method == userPassMethod {
			found = true
			break
		}
	}
	if !found {
		_, _ = conn.Write([]byte{socksVersion, noAcceptableMethod})
		return "", errors.New("username/password required")
	}
	if _, err := conn.Write([]byte{socksVersion, userPassMethod}); err != nil {
		return "", err
	}
	return s.authenticate(conn)
}

func (s *Server) authenticate(conn net.Conn) (string, error) {
	var head [2]byte
	if _, err := io.ReadFull(conn, head[:]); err != nil {
		return "", err
	}
	if head[0] != 0x01 || head[1] == 0 {
		return "", errors.New("invalid auth request")
	}
	username := make([]byte, int(head[1]))
	if _, err := io.ReadFull(conn, username); err != nil {
		return "", err
	}
	var plen [1]byte
	if _, err := io.ReadFull(conn, plen[:]); err != nil {
		return "", err
	}
	if plen[0] == 0 {
		return "", errors.New("empty password")
	}
	password := make([]byte, int(plen[0]))
	if _, err := io.ReadFull(conn, password); err != nil {
		return "", err
	}
	alias := string(username)
	want, ok := s.clients[alias]
	got := passwordVerifier(alias, string(password))
	valid := ok && len(want) == len(got) && subtle.ConstantTimeCompare([]byte(want), []byte(got)) == 1
	if !valid {
		_, _ = conn.Write([]byte{0x01, 0x01})
		return "", errors.New("authentication failed")
	}
	if _, err := conn.Write([]byte{0x01, 0x00}); err != nil {
		return "", err
	}
	return alias, nil
}

func passwordVerifier(alias, password string) string {
	sum := sha256.Sum256([]byte("verifier-v1\x00" + alias + "\x00" + password))
	return hex.EncodeToString(sum[:])
}

func (s *Server) handleRequest(client net.Conn, alias string) error {
	var head [3]byte
	if _, err := io.ReadFull(client, head[:]); err != nil {
		return err
	}
	if head[0] != socksVersion || head[2] != 0 {
		return errors.New("invalid request")
	}
	if head[1] != cmdConnect {
		_ = writeReply(client, 0x07, Address{ATYP: atypIPv4, Host: "127.0.0.1", Port: 1})
		return errors.New("unsupported command")
	}
	target, err := readAddress(client)
	if err != nil {
		_ = writeReply(client, 0x08, Address{ATYP: atypIPv4, Host: "127.0.0.1", Port: 1})
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	upstream, err := s.dial(ctx, "tcp", net.JoinHostPort(target.Host, strconv.Itoa(int(target.Port))))
	if err != nil {
		_ = writeReply(client, 0x05, Address{ATYP: atypIPv4, Host: "127.0.0.1", Port: 1})
		return err
	}
	defer upstream.Close()
	if err := writeReply(client, 0x00, addressFromNetAddr(upstream.LocalAddr())); err != nil {
		return err
	}
	if err := client.SetDeadline(time.Time{}); err != nil {
		return err
	}
	return s.proxy(client, upstream, alias)
}

func writeReply(w io.Writer, code byte, bound Address) error {
	encoded, err := encodeAddress(bound)
	if err != nil {
		return err
	}
	msg := []byte{socksVersion, code, 0x00}
	msg = append(msg, encoded...)
	_, err = w.Write(msg)
	return err
}

func (s *Server) proxy(client, upstream net.Conn, alias string) error {
	var wg sync.WaitGroup
	errCh := make(chan error, 2)
	wg.Add(2)
	go func() {
		defer wg.Done()
		errCh <- s.copyLimited(upstream, client, alias, true)
		if c, ok := upstream.(interface{ CloseWrite() error }); ok {
			_ = c.CloseWrite()
		}
	}()
	go func() {
		defer wg.Done()
		errCh <- s.copyLimited(client, upstream, alias, false)
		if c, ok := client.(interface{ CloseWrite() error }); ok {
			_ = c.CloseWrite()
		}
	}()
	first := <-errCh
	_ = client.SetDeadline(time.Now())
	_ = upstream.SetDeadline(time.Now())
	wg.Wait()
	if errors.Is(first, io.EOF) {
		return nil
	}
	return first
}

func (s *Server) copyLimited(dst io.Writer, src io.Reader, alias string, upload bool) error {
	burst, err := s.registry.DownloadBurst(alias)
	if upload {
		burst, err = s.registry.UploadBurst(alias)
	}
	if err != nil {
		return err
	}
	chunkMax := int64(32 * 1024)
	if burst < chunkMax {
		chunkMax = burst
	}
	if chunkMax < 1 {
		return errors.New("invalid limiter burst")
	}
	buf := make([]byte, int(chunkMax))
	for {
		n, readErr := src.Read(buf)
		if n > 0 {
			ctx := context.Background()
			if upload {
				err = s.registry.WaitUpload(ctx, alias, n)
			} else {
				err = s.registry.WaitDownload(ctx, alias, n)
			}
			if err != nil {
				return err
			}
			written := 0
			for written < n {
				m, writeErr := dst.Write(buf[written:n])
				written += m
				if writeErr != nil {
					return writeErr
				}
				if m == 0 {
					return io.ErrShortWrite
				}
			}
		}
		if readErr != nil {
			return readErr
		}
	}
}
