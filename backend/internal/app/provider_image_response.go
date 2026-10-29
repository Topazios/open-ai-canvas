package app

import (
	"context"
	"errors"
	"io"
	"net/http"
	"time"
)

// Image responses can contain megabytes of encoded media. The request setting
// bounds silence, while the worker context still bounds the whole task. Keeping
// http.Client.Timeout here would abort a progressing download at that duration.
func doProviderHTTPRequest(req *http.Request, timeout time.Duration) (*http.Response, error) {
	if metadataCapability(req.Context()) != "image" {
		return OutboundHTTPClient(timeout).Do(req)
	}
	parent := req.Context()
	endTask := func() {}
	if _, bounded := parent.Deadline(); !bounded {
		policy := defaultRuntimePolicy()
		if metadata, ok := parent.Value(providerAnalyticsKey{}).(providerAnalyticsContext); ok && metadata.Service != nil {
			var err error
			policy, err = metadata.Service.RuntimePolicy()
			if err != nil {
				return nil, err
			}
		}
		parent, endTask = context.WithTimeout(parent, time.Duration(policy.Task.ImageTimeoutMinutes)*time.Minute)
	}
	ctx, cancel := context.WithCancelCause(parent)
	timer := time.AfterFunc(timeout, func() {
		cancel(providerRequestTimeoutError{timeout: timeout, cause: context.DeadlineExceeded})
	})
	stop := func() { timer.Stop(); cancel(context.Canceled); endTask() }
	resp, err := OutboundHTTPClient(0).Do(req.WithContext(ctx))
	if err != nil {
		var timeoutErr providerRequestTimeoutError
		if errors.As(context.Cause(ctx), &timeoutErr) {
			err = timeoutErr
		}
		stop()
		return nil, err
	}
	timer.Reset(timeout)
	resp.Body = &providerImageResponseBody{ReadCloser: resp.Body, ctx: ctx, timer: timer, timeout: timeout, stop: stop}
	return resp, nil
}

type providerImageResponseBody struct {
	io.ReadCloser
	ctx      context.Context
	timer    *time.Timer
	timeout  time.Duration
	stop     func()
	received int64
}

func (body *providerImageResponseBody) Read(p []byte) (int, error) {
	n, err := body.ReadCloser.Read(p)
	body.received += int64(n)
	if n > 0 {
		body.timer.Reset(body.timeout)
	}
	if err != nil && !errors.Is(err, io.EOF) {
		var timeoutErr providerRequestTimeoutError
		if errors.As(context.Cause(body.ctx), &timeoutErr) {
			timeoutErr.receiving = true
			timeoutErr.receivedBytes = body.received
			err = timeoutErr
		}
	}
	return n, err
}

func (body *providerImageResponseBody) Close() error {
	body.stop()
	return body.ReadCloser.Close()
}
