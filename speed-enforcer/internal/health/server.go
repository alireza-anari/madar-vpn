package health

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
)

type Server struct {
	path       string
	generation int64
}

func New(path string, generation int64) *Server { return &Server{path: path, generation: generation} }

func (s *Server) Listen() (net.Listener, error) {
	if s.path == "" {
		return nil, errors.New("health socket path is empty")
	}
	if info, err := os.Lstat(s.path); err == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			return nil, errors.New("health socket path is a symlink")
		}
		if info.Mode()&os.ModeSocket == 0 {
			return nil, errors.New("health socket path exists and is not a socket")
		}
		if err := os.Remove(s.path); err != nil {
			return nil, fmt.Errorf("remove stale health socket: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	ln, err := net.Listen("unix", s.path)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(s.path, 0600); err != nil {
		ln.Close()
		_ = os.Remove(s.path)
		return nil, err
	}
	return ln, nil
}

func (s *Server) Serve(ctx context.Context, ln net.Listener) error {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(struct {
			Generation int64 `json:"generation"`
			Ready      bool  `json:"ready"`
		}{Generation: s.generation, Ready: true})
	})
	httpServer := &http.Server{Handler: mux}
	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			_ = httpServer.Shutdown(context.Background())
		case <-done:
		}
	}()
	err := httpServer.Serve(ln)
	close(done)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
