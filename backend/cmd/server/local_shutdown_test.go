package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLocalShutdownRequest(t *testing.T) {
	path := filepath.Join(t.TempDir(), "instance.stop")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		watchLocalShutdown(ctx, path, time.Millisecond, cancel)
		close(done)
	}()
	// A different instance's marker cannot stop this instance.
	if err := os.WriteFile(path+".other", nil, 0o600); err != nil {
		t.Fatal(err)
	}
	select {
	case <-ctx.Done():
		t.Fatal("stopped without matching request")
	case <-time.After(20 * time.Millisecond):
	}
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
		if ctx.Err() != context.Canceled {
			t.Fatal("request did not cancel server context")
		}
	case <-time.After(time.Second):
		t.Fatal("request was not consumed")
	}
}

func TestLocalShutdownDisabledAndParentCancellation(t *testing.T) {
	parent, stop := context.WithCancel(context.Background())
	ctx, cancel := localShutdownContext(parent, "")
	defer cancel()
	if ctx.Err() != nil {
		t.Fatal("disabled watcher stopped the server")
	}
	stop()
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("signal context was not propagated")
	}
	finished := make(chan struct{})
	go func() {
		watchLocalShutdown(ctx, filepath.Join(t.TempDir(), "absent.stop"), time.Millisecond, cancel)
		close(finished)
	}()
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("watcher leaked after cancellation")
	}
}
