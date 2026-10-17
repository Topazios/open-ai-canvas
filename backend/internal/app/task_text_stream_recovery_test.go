package app

import (
	"errors"
	"github.com/mattn/go-sqlite3"
	"testing"
)

func TestTaskTextStreamRetainsDeltasAfterTransientWriteConflict(t *testing.T) {
	p := newTaskTextStreamPublisher(nil, "user", "task")
	calls := 0
	stored := ""
	p.sink = func(content string) error {
		calls++
		if calls == 1 {
			return sqlite3.Error{Code: sqlite3.ErrBusy}
		}
		stored += content
		return nil
	}
	p.Publish("first")
	p.flush()
	p.Publish(" second")
	if calls != 1 || p.disabled {
		t.Fatal("transient failure disabled streaming or retried each token")
	}
	p.flush()
	p.Close()
	if stored != "first second" || p.disabled {
		t.Fatalf("lost or duplicated text: %q", stored)
	}
}
func TestTaskTextStreamDoesNotRetryAmbiguousStorageErrors(t *testing.T) {
	p := newTaskTextStreamPublisher(nil, "user", "task")
	calls := 0
	p.sink = func(content string) error { calls++; return errors.New("ambiguous network commit") }
	p.Publish("text")
	p.flush()
	p.Publish("later")
	p.Close()
	if calls != 1 || !p.disabled {
		t.Fatal("ambiguous commit must not be replayed")
	}
}
