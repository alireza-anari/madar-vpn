package limit

import (
	"context"
	"errors"
	"math"
	"sync"
	"time"
)

var ErrRequestExceedsBurst = errors.New("request exceeds burst")

type Clock interface {
	Now() time.Time
	Sleep(context.Context, time.Duration) error
}

type RealClock struct{}

func (RealClock) Now() time.Time { return time.Now() }
func (RealClock) Sleep(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

type bucket struct {
	mu     sync.Mutex
	rate   int64
	burst  int64
	tokens float64
	last   time.Time
	clock  Clock
}

func newBucket(rate, burst int64, clock Clock) (*bucket, error) {
	if rate <= 0 || burst <= 0 {
		return nil, errors.New("rate and burst must be positive")
	}
	if clock == nil {
		clock = RealClock{}
	}
	now := clock.Now()
	return &bucket{rate: rate, burst: burst, tokens: float64(burst), last: now, clock: clock}, nil
}

func (b *bucket) wait(ctx context.Context, amount int) error {
	if amount <= 0 {
		return errors.New("amount must be positive")
	}
	if int64(amount) > b.burst {
		return ErrRequestExceedsBurst
	}
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		b.mu.Lock()
		b.refillLocked()
		need := float64(amount)
		if b.tokens+1e-9 >= need {
			b.tokens -= need
			if b.tokens < 0 {
				b.tokens = 0
			}
			b.mu.Unlock()
			return nil
		}
		missing := need - b.tokens
		seconds := missing / float64(b.rate)
		ns := math.Ceil(seconds * float64(time.Second))
		if ns < 1 {
			ns = 1
		}
		delay := time.Duration(ns)
		b.mu.Unlock()
		if err := b.clock.Sleep(ctx, delay); err != nil {
			return err
		}
	}
}

func (b *bucket) refillLocked() {
	now := b.clock.Now()
	elapsed := now.Sub(b.last)
	if elapsed <= 0 {
		return
	}
	b.last = now
	refill := elapsed.Seconds() * float64(b.rate)
	b.tokens = math.Min(float64(b.burst), b.tokens+refill)
}
