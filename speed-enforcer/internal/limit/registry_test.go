package limit

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/alireza-anari/madar-vpn/speed-enforcer/internal/config"
)

type fakeClock struct {
	mu    sync.Mutex
	now   time.Time
	slept time.Duration
}

func newFakeClock() *fakeClock      { return &fakeClock{now: time.Unix(0, 0)} }
func (f *fakeClock) Now() time.Time { f.mu.Lock(); defer f.mu.Unlock(); return f.now }
func (f *fakeClock) Sleep(ctx context.Context, d time.Duration) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}
	f.mu.Lock()
	f.now = f.now.Add(d)
	f.slept += d
	f.mu.Unlock()
	return nil
}
func (f *fakeClock) totalSlept() time.Duration { f.mu.Lock(); defer f.mu.Unlock(); return f.slept }

func testConfig() config.Config {
	return config.Config{Clients: []config.Client{{
		Alias: "a", UploadBytesPerSecond: 100, UploadBurstBytes: 50,
		DownloadBytesPerSecond: 200, DownloadBurstBytes: 100,
	}, {
		Alias: "b", UploadBytesPerSecond: 100, UploadBurstBytes: 50,
		DownloadBytesPerSecond: 200, DownloadBurstBytes: 100,
	}}}
}

func TestRegistryInitialBurstAndRefill(t *testing.T) {
	clock := newFakeClock()
	r, err := NewRegistry(testConfig(), clock)
	if err != nil {
		t.Fatal(err)
	}
	if err := r.WaitUpload(context.Background(), "a", 50); err != nil {
		t.Fatal(err)
	}
	if got := clock.totalSlept(); got != 0 {
		t.Fatalf("initial burst slept %v", got)
	}
	if err := r.WaitUpload(context.Background(), "a", 10); err != nil {
		t.Fatal(err)
	}
	if got := clock.totalSlept(); got != 100*time.Millisecond {
		t.Fatalf("sleep = %v, want 100ms", got)
	}
}

func TestRegistryUploadAndDownloadAreIndependent(t *testing.T) {
	clock := newFakeClock()
	r, _ := NewRegistry(testConfig(), clock)
	if err := r.WaitUpload(context.Background(), "a", 50); err != nil {
		t.Fatal(err)
	}
	if err := r.WaitDownload(context.Background(), "a", 100); err != nil {
		t.Fatal(err)
	}
	if got := clock.totalSlept(); got != 0 {
		t.Fatalf("independent initial bursts slept %v", got)
	}
}

func TestRegistryAliasesAreIndependent(t *testing.T) {
	clock := newFakeClock()
	r, _ := NewRegistry(testConfig(), clock)
	if err := r.WaitUpload(context.Background(), "a", 50); err != nil {
		t.Fatal(err)
	}
	if err := r.WaitUpload(context.Background(), "b", 50); err != nil {
		t.Fatal(err)
	}
	if got := clock.totalSlept(); got != 0 {
		t.Fatalf("independent aliases slept %v", got)
	}
}

func TestRegistrySameAliasSharesBudget(t *testing.T) {
	clock := newFakeClock()
	r, _ := NewRegistry(testConfig(), clock)
	if err := r.WaitUpload(context.Background(), "a", 40); err != nil {
		t.Fatal(err)
	}
	if err := r.WaitUpload(context.Background(), "a", 20); err != nil {
		t.Fatal(err)
	}
	if got := clock.totalSlept(); got != 100*time.Millisecond {
		t.Fatalf("sleep = %v, want 100ms", got)
	}
}

func TestRegistryRejectsUnknownAliasAndOversizeRequest(t *testing.T) {
	clock := newFakeClock()
	r, _ := NewRegistry(testConfig(), clock)
	if err := r.WaitUpload(context.Background(), "missing", 1); !errors.Is(err, ErrUnknownAlias) {
		t.Fatalf("err = %v", err)
	}
	if err := r.WaitUpload(context.Background(), "a", 51); !errors.Is(err, ErrRequestExceedsBurst) {
		t.Fatalf("err = %v", err)
	}
}

func TestRegistryCanceledContextExits(t *testing.T) {
	clock := newFakeClock()
	r, _ := NewRegistry(testConfig(), clock)
	if err := r.WaitUpload(context.Background(), "a", 50); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := r.WaitUpload(ctx, "a", 1); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
}
