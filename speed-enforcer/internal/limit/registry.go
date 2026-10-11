package limit

import (
	"context"
	"errors"

	"github.com/alireza-anari/madar-vpn/speed-enforcer/internal/config"
)

var ErrUnknownAlias = errors.New("unknown alias")

type pair struct{ upload, download *bucket }

type Registry struct{ clients map[string]pair }

func NewRegistry(cfg config.Config, clock Clock) (*Registry, error) {
	result := &Registry{clients: make(map[string]pair, len(cfg.Clients))}
	for _, client := range cfg.Clients {
		if client.Alias == "" {
			return nil, errors.New("empty alias")
		}
		if _, exists := result.clients[client.Alias]; exists {
			return nil, errors.New("duplicate alias")
		}
		up, err := newBucket(client.UploadBytesPerSecond, client.UploadBurstBytes, clock)
		if err != nil {
			return nil, err
		}
		down, err := newBucket(client.DownloadBytesPerSecond, client.DownloadBurstBytes, clock)
		if err != nil {
			return nil, err
		}
		result.clients[client.Alias] = pair{upload: up, download: down}
	}
	return result, nil
}

func (r *Registry) WaitUpload(ctx context.Context, alias string, payloadBytes int) error {
	p, ok := r.clients[alias]
	if !ok {
		return ErrUnknownAlias
	}
	return p.upload.wait(ctx, payloadBytes)
}

func (r *Registry) WaitDownload(ctx context.Context, alias string, payloadBytes int) error {
	p, ok := r.clients[alias]
	if !ok {
		return ErrUnknownAlias
	}
	return p.download.wait(ctx, payloadBytes)
}

func (r *Registry) UploadBurst(alias string) (int64, error) {
	p, ok := r.clients[alias]
	if !ok {
		return 0, ErrUnknownAlias
	}
	return p.upload.burst, nil
}

func (r *Registry) DownloadBurst(alias string) (int64, error) {
	p, ok := r.clients[alias]
	if !ok {
		return 0, ErrUnknownAlias
	}
	return p.download.burst, nil
}
