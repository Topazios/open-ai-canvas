package app

import (
	"infinite-canvas/backend/internal/repository"
	"strings"
	"sync"
	"time"
)

const (
	taskTextStreamFlushBytes    = 2 << 10
	taskTextStreamFlushInterval = 500 * time.Millisecond
)

// taskTextStreamPublisher batches model deltas before persisting them. Streaming
// is an observability and recovery enhancement: persistence failure must not turn
// an otherwise successful model response into a failed generation task.
type taskTextStreamPublisher struct {
	service  *Service
	userID   string
	taskID   string
	mu       sync.Mutex
	buffer   strings.Builder
	timer    *time.Timer
	disabled bool
	closed   bool
	retrying bool
	sink     func(string) error
}

func newTaskTextStreamPublisher(service *Service, userID string, taskID string) *taskTextStreamPublisher {
	return &taskTextStreamPublisher{service: service, userID: userID, taskID: taskID}
}

func (p *taskTextStreamPublisher) Publish(delta string) {
	if p == nil || delta == "" {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.disabled || p.closed {
		return
	}
	p.buffer.WriteString(delta)
	if p.retrying && p.timer != nil {
		return
	}
	if p.buffer.Len() >= taskTextStreamFlushBytes {
		p.flushLocked()
		return
	}
	if p.timer == nil {
		p.timer = time.AfterFunc(taskTextStreamFlushInterval, p.flush)
	}
}

func (p *taskTextStreamPublisher) Close() {
	if p == nil {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.closed = true
	p.flushLocked()
}

func (p *taskTextStreamPublisher) flush() {
	if p == nil {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.flushLocked()
}

func (p *taskTextStreamPublisher) flushLocked() {
	if p.timer != nil {
		p.timer.Stop()
		p.timer = nil
	}
	if p.disabled || p.buffer.Len() == 0 {
		return
	}
	content := p.buffer.String()
	var err error
	if p.sink != nil {
		err = p.sink(content)
	} else {
		_, err = p.service.AppendTaskTextDelta(p.userID, p.taskID, content)
	}
	if err != nil {
		if repository.IsTransientSQLiteWrite(err) && !p.closed && p.buffer.Len() < 60<<10 {
			// Preserve the exact delta until a local transaction succeeds. A retry
			// never invokes the model again and never changes billing.
			if !p.retrying && p.service != nil {
				_ = p.service.log(p.userID, p.taskID, "warn", "文本进度写入暂忙，正在恢复", "")
			}
			p.retrying = true
			p.timer = time.AfterFunc(time.Second, p.flush)
			return
		}
		p.disabled = true
		if p.service != nil {
			_ = p.service.log(p.userID, p.taskID, "warn", "文本流持久化已降级", err.Error())
		}
		return
	}
	p.buffer.Reset()
	p.retrying = false
}
