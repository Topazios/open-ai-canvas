package app

// Provider 出站 HTTP、multipart 与媒体字节读取。

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"mime/multipart"
	"net"
	"net/http"
	"net/textproto"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/platform"
)

const providerRequestPendingStatus = -1

type providerRequestLogKey struct{}
type providerRequestLogIdentity struct {
	ID          string
	StartedAt   time.Time
	RequestBody string
}

type providerRequestTimeoutError struct {
	timeout       time.Duration
	cause         error
	receiving     bool
	receivedBytes int64
}

func (e providerRequestTimeoutError) Error() string {
	if e.receiving {
		return fmt.Sprintf("模型已响应，但图片结果接收连续 %s 无进展（已收到 %d 字节）；结果不完整，请先核对渠道任务和扣费状态", e.timeout.Round(time.Second), e.receivedBytes)
	}
	return fmt.Sprintf("等待模型响应超过单次上游请求超时（%s），本地已停止等待；请先核对渠道任务和扣费状态", e.timeout.Round(time.Second))
}

func (e providerRequestTimeoutError) Unwrap() error { return e.cause }

func preserveProviderRequestTimeout(err error, ctx context.Context, timeout time.Duration) error {
	var existing providerRequestTimeoutError
	if errors.As(err, &existing) {
		return err
	}
	if err != nil && errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil {
		return providerRequestTimeoutError{timeout: timeout, cause: err}
	}
	return err
}

func postGeminiJSON(ctx context.Context, config providerConfig, path string, body interface{}, target interface{}) error {
	data, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("序列化上游请求失败：%w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, geminiVeoURL(config.BaseURL, path), bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("x-goog-api-key", config.APIKey)
	req.Header.Set("Content-Type", "application/json")
	ApplyOutboundHeaders(req, config.Headers)
	return doJSON(req, target)
}

func deleteGeminiCachedContent(ctx context.Context, config providerConfig, resourceName string) error {
	if err := validateGeminiCachedContentName(resourceName); err != nil {
		return err
	}
	suffix := strings.TrimPrefix(strings.TrimSpace(resourceName), "cachedContents/")
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, geminiVeoURL(config.BaseURL, "/cachedContents/"+suffix), nil)
	if err != nil {
		return err
	}
	req.Header.Set("x-goog-api-key", config.APIKey)
	ApplyOutboundHeaders(req, config.Headers)
	_, _, err = doBinary(req)
	if err == nil {
		return nil
	}
	var httpErr providerHTTPError
	if errors.As(err, &httpErr) && httpErr.StatusCode == http.StatusNotFound {
		return nil
	}
	return err
}

func getGeminiJSON(ctx context.Context, config providerConfig, path string, target interface{}) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, geminiVeoURL(config.BaseURL, path), nil)
	if err != nil {
		return err
	}
	req.Header.Set("x-goog-api-key", config.APIKey)
	ApplyOutboundHeaders(req, config.Headers)
	return doJSON(req, target)
}

func getGeminiBinary(ctx context.Context, config providerConfig, rawURL string) ([]byte, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("x-goog-api-key", config.APIKey)
	ApplyOutboundHeaders(req, config.Headers)
	return doBinary(req)
}

func geminiVeoURL(baseURL string, path string) string {
	return apiURLWithDefaultPrefix(baseURL, path, "/v1beta")
}

func postStreamingBinary(ctx context.Context, config providerConfig, path string, body interface{}, onChunk func(string, []byte), validators ...func([]byte, string) error) ([]byte, string, error) {
	data, err := json.Marshal(body)
	if err != nil {
		return nil, "", fmt.Errorf("序列化上游请求失败：%w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, apiURL(config.BaseURL, path), bytes.NewReader(data))
	if err != nil {
		return nil, "", err
	}
	applyProviderAuth(req, config)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	ApplyOutboundHeaders(req, config.Headers)
	return doBinaryWithConsumer(req, onChunk, validators...)
}

func postJSON(ctx context.Context, config providerConfig, path string, body interface{}, target interface{}, validators ...func([]byte, string) error) error {
	data, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("序列化上游请求失败：%w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, apiURL(config.BaseURL, path), bytes.NewReader(data))
	if err != nil {
		return err
	}
	applyProviderAuth(req, config)
	req.Header.Set("Content-Type", "application/json")
	ApplyOutboundHeaders(req, config.Headers)
	return doJSON(req, target, validators...)
}

func applyProviderAuth(req *http.Request, config providerConfig) {
	if config.APIFormat == "claude" {
		req.Header.Set("x-api-key", config.APIKey)
		req.Header.Set("anthropic-version", "2023-06-01")
		return
	}
	if config.APIFormat == "gemini" {
		req.Header.Set("x-goog-api-key", config.APIKey)
		return
	}
	req.Header.Set("Authorization", "Bearer "+config.APIKey)
}

func postForm(ctx context.Context, config providerConfig, path string, contentType string, body io.Reader, target interface{}) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, apiURL(config.BaseURL, path), body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+config.APIKey)
	req.Header.Set("Content-Type", contentType)
	ApplyOutboundHeaders(req, config.Headers)
	return doJSON(req, target)
}

func getJSON(ctx context.Context, config providerConfig, path string, target interface{}) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, apiURL(config.BaseURL, path), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+config.APIKey)
	ApplyOutboundHeaders(req, config.Headers)
	return doJSON(req, target)
}

func postBinary(ctx context.Context, config providerConfig, path string, body interface{}) ([]byte, string, error) {
	data, err := json.Marshal(body)
	if err != nil {
		return nil, "", fmt.Errorf("序列化上游请求失败：%w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, apiURL(config.BaseURL, path), bytes.NewReader(data))
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Authorization", "Bearer "+config.APIKey)
	req.Header.Set("Content-Type", "application/json")
	ApplyOutboundHeaders(req, config.Headers)
	return doBinary(req)
}

func getBinary(ctx context.Context, config providerConfig, path string) ([]byte, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, apiURL(config.BaseURL, path), nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Authorization", "Bearer "+config.APIKey)
	ApplyOutboundHeaders(req, config.Headers)
	return doBinary(req)
}

func getExternalBinary(ctx context.Context, rawURL string) ([]byte, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, "", err
	}
	return doBinary(req)
}

func getProviderExternalBinary(ctx context.Context, config providerConfig, rawURL string) ([]byte, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, "", err
	}
	if sameProviderOrigin(config.BaseURL, rawURL) {
		applyProviderAuth(req, config)
		ApplyOutboundHeaders(req, config.Headers)
	}
	return doBinary(req)
}

func sameProviderOrigin(baseURL string, rawURL string) bool {
	base, baseErr := url.Parse(strings.TrimSpace(baseURL))
	target, targetErr := url.Parse(strings.TrimSpace(rawURL))
	if baseErr != nil || targetErr != nil || base.Scheme == "" || base.Host == "" || target.Scheme == "" || target.Host == "" {
		return false
	}
	return strings.EqualFold(base.Scheme, target.Scheme) && strings.EqualFold(base.Host, target.Host)
}

func doJSON(req *http.Request, target interface{}, validators ...func([]byte, string) error) error {
	data, mimeType, err := doBinaryWithConsumer(req, nil, validators...)
	if err != nil {
		return err
	}
	if !strings.Contains(mimeType, "json") && !json.Valid(data) {
		return providerResponseDecodeError{Err: fmt.Errorf("接口返回非 JSON 内容：%s", mimeType)}
	}
	if err := json.Unmarshal(data, target); err != nil {
		return providerResponseDecodeError{Err: err}
	}
	if payload, ok := target.(*imageResponse); ok {
		if payload.Error != nil && payload.Error.Message != "" {
			return errors.New(providerPayloadErrorMessage(payload.Error.Message))
		}
		if payload.Code != nil && *payload.Code != 0 {
			return errors.New(providerPayloadErrorMessage(payload.Msg))
		}
	}
	if payload, ok := target.(*map[string]interface{}); ok {
		if _, rawMessage, failed := providerPayloadBusinessFailure(*payload); failed {
			return providerPayloadError{raw: rawMessage, message: providerPayloadErrorMessage(rawMessage)}
		}
		if errValue, ok := (*payload)["error"].(map[string]interface{}); ok && stringField(errValue, "message") != "" {
			rawMessage := stringField(errValue, "message")
			return providerPayloadError{raw: rawMessage, message: providerPayloadErrorMessage(rawMessage)}
		}
	}
	return nil
}

func doBinary(req *http.Request) ([]byte, string, error) {
	return doBinaryWithConsumer(req, nil)
}

// doBinaryWithConsumer 是 Provider 出站响应的统一安全边界。JSON、SSE 和媒体下载最终都在这里执行
// 渠道并发/熔断、SSRF、超时、响应大小、HTTP 状态和审计检查；onChunk 仅观察已读取的流片段，
// 不会绕过完整响应的大小上限或错误判定。
func doBinaryWithConsumer(req *http.Request, onChunk func(string, []byte), validators ...func([]byte, string) error) ([]byte, string, error) {
	startedAt := time.Now()
	requestTimeout := time.Duration(platform.DefaultRuntimePolicy().Task.ProviderRequestTimeoutSeconds) * time.Second
	requestKind := providerRequestKindFromContext(req.Context())
	if deadline, ok := req.Context().Deadline(); ok {
		if remaining := time.Until(deadline); remaining > 0 {
			requestTimeout = remaining
		}
	}
	var release func()
	var coordinator *platform.Coordinator
	var runtimeService *Service
	cacheManagementRequest := requestKind == "cache-create" || requestKind == "cache-delete"
	responseLimit := maxProviderResponseBytes
	channelID := ""
	if metadata, ok := req.Context().Value(providerAnalyticsKey{}).(providerAnalyticsContext); ok && metadata.Service != nil {
		runtimeService = metadata.Service
		coordinator = metadata.Service.coordinator
		channelID = metadata.ChannelID
		policy, err := metadata.Service.RuntimePolicy()
		if err != nil {
			return nil, "", fmt.Errorf("读取生成资源限制失败：%w", err)
		}
		responseLimit = megabytes(policy.Resource.GeneratedFileMB)
		if !cacheManagementRequest {
			open, err := coordinator.CircuitOpen(req.Context(), channelID)
			if err != nil {
				return nil, "", fmt.Errorf("读取渠道熔断状态失败：%w", err)
			}
			if open {
				return nil, "", providerCircuitOpenError{}
			}
			slotID := channelID
			if slotID == "" {
				slotID = "custom:" + strings.ToLower(req.URL.Host)
			}
			var concurrencyLimit int
			release, concurrencyLimit, err = metadata.Service.AcquireChannelSlot(req.Context(), channelID, slotID, requestTimeout+time.Minute, model.TaskConcurrency(metadata.Capability, metadata.Operation))
			metadata.ConcurrencyLimit = concurrencyLimit
			req = req.WithContext(context.WithValue(req.Context(), providerAnalyticsKey{}, metadata))
			if err != nil {
				recordProviderRequest(req, startedAt, 0, nil, err)
				return nil, "", err
			}
		}
		if release != nil {
			defer release()
		}
	}
	// Channel-slot wait is scheduling time, not provider execution time. Start
	// request analytics and the configured upstream deadline only after admission.
	startedAt = time.Now()
	// The worker deadline caps the total task. This independent setting limits
	// one upstream HTTP call, so a stuck request can fail before the whole task.
	if deadline, ok := req.Context().Deadline(); ok {
		if remaining := time.Until(deadline); remaining > 0 {
			requestTimeout = remaining
		}
	}
	if metadata, ok := req.Context().Value(providerAnalyticsKey{}).(providerAnalyticsContext); ok && metadata.Service != nil {
		if policy, err := metadata.Service.RuntimePolicy(); err == nil && policy.Task.ProviderRequestTimeoutSeconds > 0 {
			requestTimeout = time.Duration(policy.Task.ProviderRequestTimeoutSeconds) * time.Second
			if deadline, ok := req.Context().Deadline(); ok {
				if remaining := time.Until(deadline); remaining > 0 && remaining < requestTimeout {
					requestTimeout = remaining
				}
			}
		}
	}
	if _, err := ValidateOutboundURL(req.URL.String()); err != nil {
		recordProviderRequest(req, startedAt, 0, nil, err)
		return nil, "", err
	}
	ApplyDefaultOutboundHeaders(req)
	// Polls keep their existing aggregation on the accepted video request.
	// Only model submissions acquire a durable in-flight audit row.
	if metadata, ok := req.Context().Value(providerAnalyticsKey{}).(providerAnalyticsContext); ok && metadata.Service != nil && providerRequestIsBillable(req.Method, requestKind) {
		req = req.WithContext(context.WithValue(req.Context(), providerRequestLogKey{}, providerRequestLogIdentity{ID: newID(), StartedAt: startedAt, RequestBody: requestPayloadForLog(req)}))
		if err := recordProviderRequest(req, startedAt, providerRequestPendingStatus, nil, nil); err != nil {
			return nil, "", fmt.Errorf("请求日志写入失败，尚未向模型发送请求：%w", err)
		}
	}
	resp, err := doProviderHTTPRequest(req, requestTimeout)
	if err != nil {
		// http.Client.Timeout also unwraps to context.DeadlineExceeded. Preserve
		// its source when the task's own context is still live; the worker's task
		// deadline is a separate, larger limit and must not mask this cause.
		if metadataCapability(req.Context()) != "image" {
			err = preserveProviderRequestTimeout(err, req.Context(), requestTimeout)
		}
		err = providerConnectionError(err)
		if runtimeService != nil && !cacheManagementRequest {
			_ = runtimeService.RecordChannelResult(req.Context(), channelID, !errors.Is(err, context.Canceled))
		}
		recordProviderRequest(req, startedAt, 0, nil, err)
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.ContentLength > responseLimit {
		err = fmt.Errorf("上游响应超过 %s 限制", formatStorageLimit(responseLimit))
		recordProviderRequest(req, startedAt, resp.StatusCode, nil, err)
		return nil, "", err
	}
	mimeType := resp.Header.Get("Content-Type")
	var buffered bytes.Buffer
	reader := io.LimitReader(resp.Body, responseLimit+1)
	chunk := make([]byte, 32<<10)
	for {
		readCount, readErr := reader.Read(chunk)
		if readCount > 0 {
			if int64(buffered.Len()+readCount) > responseLimit {
				err = fmt.Errorf("上游响应超过 %s 限制", formatStorageLimit(responseLimit))
				recordProviderRequest(req, startedAt, resp.StatusCode, buffered.Bytes(), err)
				return nil, "", err
			}
			_, _ = buffered.Write(chunk[:readCount])
			if onChunk != nil {
				onChunk(mimeType, chunk[:readCount])
			}
			// A few image relays send a complete JSON document and keep the
			// connection open. Once the document is valid, the result is already
			// usable; waiting for EOF would turn a successful HTTP 200 into a local
			// deadline warning after several minutes.
			if resp.StatusCode >= 200 && resp.StatusCode < 300 && providerResponseBodyComplete(resp, mimeType, buffered.Bytes()) {
				break
			}
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			if metadataCapability(req.Context()) != "image" {
				readErr = preserveProviderRequestTimeout(readErr, req.Context(), requestTimeout)
			}
			readErr = providerConnectionError(readErr)
			// Some gateways write a complete JSON result and keep the upstream
			// connection open without sending EOF. Once the payload is complete,
			// the generated result is usable and must not be reclassified as a
			// timeout merely because connection shutdown is delayed.
			if resp.StatusCode >= 200 && resp.StatusCode < 300 && providerResponseBodyComplete(resp, mimeType, buffered.Bytes()) {
				break
			}
			recordProviderRequest(req, startedAt, resp.StatusCode, buffered.Bytes(), readErr)
			return nil, "", readErr
		}
	}
	data := buffered.Bytes()
	if int64(len(data)) > responseLimit {
		err = fmt.Errorf("上游响应超过 %s 限制", formatStorageLimit(responseLimit))
		recordProviderRequest(req, startedAt, resp.StatusCode, nil, err)
		return nil, "", err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if runtimeService != nil && !cacheManagementRequest {
			_ = runtimeService.RecordChannelResult(req.Context(), channelID, resp.StatusCode >= 500)
		}
		httpErr := providerHTTPError{StatusCode: resp.StatusCode, Status: resp.Status, Body: string(data), RetryAfter: parseRetryAfter(resp.Header.Get("Retry-After"), time.Now())}
		recordProviderRequest(req, startedAt, resp.StatusCode, data, httpErr)
		return nil, "", httpErr
	}
	// Protocol validation belongs to the same request receipt as transport.
	// HTTP 200 headers alone cannot prove a streaming model call succeeded.
	for _, validate := range validators {
		if err := validate(data, mimeType); err != nil {
			recordProviderRequest(req, startedAt, resp.StatusCode, data, err)
			return nil, mimeType, err
		}
	}
	recordProviderRequest(req, startedAt, resp.StatusCode, data, nil)
	if runtimeService != nil && !cacheManagementRequest {
		_ = runtimeService.RecordChannelResult(req.Context(), channelID, false)
	}
	return data, mimeType, nil
}

func providerResponseBodyComplete(resp *http.Response, mimeType string, data []byte) bool {
	if resp == nil || len(data) == 0 {
		return false
	}
	if resp.ContentLength >= 0 && int64(len(data)) >= resp.ContentLength {
		return true
	}
	if providerSSEBodyComplete(mimeType, data) {
		return true
	}
	// Some relays return a complete JSON response with text/plain or no
	// Content-Type and keep the connection alive. The payload itself is the
	// reliable completion signal; otherwise image jobs wait for EOF and leave
	// their in-flight audit row open until the idle timeout fires.
	return providerJSONBodyComplete(data)
}

// providerJSONBodyComplete 在每读一块数据后被调用。大图的 base64 响应可达数十 MB，
// 对未完成的 JSON 每次都整段扫描会让读取变成 O(n²)，拖慢读取并让连接窗口回收变慢。
// 大响应只有首个非空白字节是对象或数组起点，且末尾非空白字节是对应的闭合符时才做完整校验。
func providerJSONBodyComplete(data []byte) bool {
	const smallBody = 64 << 10
	if len(data) <= smallBody {
		return json.Valid(data)
	}
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) < 2 {
		return false
	}
	switch {
	case trimmed[0] == '{' && trimmed[len(trimmed)-1] == '}':
	case trimmed[0] == '[' && trimmed[len(trimmed)-1] == ']':
	default:
		return false
	}
	return json.Valid(trimmed)
}

// SSE responses are often kept open by gateways after the model has emitted
// its terminal frame. Stop reading at that protocol boundary instead of
// turning a complete result into a local read timeout while waiting for EOF.
func providerSSEBodyComplete(mimeType string, data []byte) bool {
	if !strings.Contains(strings.ToLower(mimeType), "text/event-stream") {
		return false
	}
	var eventName string
	var eventData []string
	for _, line := range strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n") {
		if line == "" {
			if isTerminalProviderSSEEvent(eventName, strings.Join(eventData, "\n")) {
				return true
			}
			eventName = ""
			eventData = eventData[:0]
			continue
		}
		if strings.HasPrefix(line, "event:") {
			eventName = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		} else if strings.HasPrefix(line, "data:") {
			eventData = append(eventData, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	return false
}

func isTerminalProviderSSEEvent(eventName, data string) bool {
	if isTerminalProviderSSEEventName(eventName) {
		return true
	}
	if strings.TrimSpace(data) == "[DONE]" {
		return true
	}
	var payload struct {
		Type string `json:"type"`
	}
	if json.Unmarshal([]byte(data), &payload) == nil && isTerminalProviderSSEEventName(payload.Type) {
		return true
	}
	return false
}

func isTerminalProviderSSEEventName(eventName string) bool {
	switch strings.TrimSpace(eventName) {
	case "response.completed", "response.failed", "response.incomplete", "message_stop", "error":
		return true
	}
	return false
}

func metadataCapability(ctx context.Context) string {
	metadata, _ := ctx.Value(providerAnalyticsKey{}).(providerAnalyticsContext)
	return metadata.Capability
}

func providerRequestKindFromContext(ctx context.Context) string {
	metadata, _ := ctx.Value(providerAnalyticsKey{}).(providerAnalyticsContext)
	return strings.TrimSpace(metadata.RequestKind)
}

func providerConnectionError(err error) error {
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return fmt.Errorf("模型服务连接提前关闭，未收到完整结果；请先核对中转站任务和扣费记录，再决定是否重试：%w", err)
	}
	return err
}

func parseRetryAfter(value string, now time.Time) time.Duration {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0
	}
	if seconds, err := strconv.Atoi(value); err == nil && seconds > 0 {
		return time.Duration(seconds) * time.Second
	}
	if at, err := http.ParseTime(value); err == nil && at.After(now) {
		return at.Sub(now)
	}
	return 0
}

func providerPollingDeadline(ctx context.Context) time.Time {
	if deadline, ok := ctx.Deadline(); ok {
		return deadline
	}
	return time.Now().Add(time.Duration(platform.DefaultRuntimePolicy().Task.VideoTimeoutMinutes) * time.Minute)
}

func recordProviderRequest(req *http.Request, startedAt time.Time, statusCode int, responseBody []byte, requestErr error) error {
	metadata, ok := req.Context().Value(providerAnalyticsKey{}).(providerAnalyticsContext)
	if !ok || metadata.Service == nil {
		return nil
	}
	status := model.ApiCallStatusSucceeded
	errorCode := ""
	errorText := ""
	errorSource := ""
	if statusCode == providerRequestPendingStatus {
		status, statusCode = model.ApiCallStatusRunning, 0
	} else if requestErr != nil || statusCode < 200 || statusCode >= 300 {
		status, errorSource = providerRequestFailureOutcome(statusCode, requestErr)
		errorCode, errorText = providerRequestErrorDetails(requestErr)
	} else if businessCode, businessMessage, failed := providerResponseBusinessFailure(responseBody); failed {
		status = model.ApiCallStatusFailed
		errorSource = "upstream"
		errorCode = businessCode
		errorText = businessMessage
	}
	requestKind := providerRequestKind(req.Method, req.URL.Path)
	if metadata.RequestKind != "" {
		requestKind = metadata.RequestKind
	}
	if status == model.ApiCallStatusSucceeded && (requestKind == "create" || requestKind == "poll") && (metadata.Capability == "image" || metadata.Capability == "video") {
		metadata.Service.syncProviderTaskProgress(metadata.TaskID, responseBody)
	}
	apiFormat := "openai"
	if req.Header.Get("x-goog-api-key") != "" {
		apiFormat = "gemini"
	}
	requestBody := ""
	identity, hasIdentity := req.Context().Value(providerRequestLogKey{}).(providerRequestLogIdentity)
	if hasIdentity {
		requestBody = identity.RequestBody
	} else {
		requestBody = requestPayloadForLog(req)
	}
	callLog := model.ApiCallLog{
		UserID: metadata.UserID, TraceID: metadata.TraceID, RequestID: metadata.RequestID, ChannelID: metadata.ChannelID, TaskID: metadata.TaskID, BillingOrderID: metadata.BillingOrderID,
		Source: "backend-task", Capability: metadata.Capability, Operation: metadata.Operation,
		RequestKind: requestKind, Billable: providerRequestIsBillable(req.Method, requestKind),
		APIFormat: apiFormat, Method: req.Method, Path: req.URL.Path, Model: metadata.Model,
		Status: status, StatusCode: statusCode, DurationMs: time.Since(startedAt).Milliseconds(),
		ErrorCode: errorCode, ErrorSource: errorSource, Error: errorText, ConcurrencyLimit: metadata.ConcurrencyLimit, UpstreamURL: req.URL.Scheme + "://" + req.URL.Host + req.URL.Path,
		ProviderRequestID: metadata.ProviderRequestID, RequestContentType: req.Header.Get("Content-Type"), RequestBody: requestBody, ResponseBody: SanitizeAPICallPayload(responseBody, ""),
	}
	if hasIdentity {
		callLog.ID, callLog.StartedAt, callLog.CreatedAt = identity.ID, identity.StartedAt, identity.StartedAt
		callLog.RequestBody = identity.RequestBody
	}
	channelSlotFailure := false
	if code, message := ChannelSlotFailureDetails(requestErr); code != "" {
		channelSlotFailure = true
		callLog.ErrorCode = code
		callLog.Error = message
	}
	if requestKind == "create" && metadata.Capability == "video" {
		callLog.VideoSeconds = metadata.VideoSeconds
		if callLog.VideoSeconds <= 0 {
			if strings.Contains(strings.ToLower(metadata.Model), "seedance") || strings.Contains(req.URL.Path, "/contents/generations/tasks") {
				callLog.VideoSeconds = 5
			} else {
				callLog.VideoSeconds = 6
			}
		}
	}
	metadata.Service.EnrichAPICallLog(&callLog, responseBody)
	if err := metadata.Service.LogAPICall(callLog); err != nil {
		log.Printf("provider request audit write failed: task_id=%s request_log_id=%s status=%s error=%v", metadata.TaskID, callLog.ID, callLog.Status, err)
		if status != model.ApiCallStatusRunning && !channelSlotFailure && metadata.Billing != nil {
			if uncertainErr := metadata.Billing.MarkBillingUncertain(metadata.BillingOrderID, "上游调用日志写入失败，费用状态待核对"); uncertainErr != nil {
				// 这里无法把日志落库错误返回给已完成的 HTTP 请求，只能把计费边界失败写入进程日志，交给待核对审计继续处理。
				log.Printf("provider billing uncertainty update failed: task_id=%s billing_order_id=%s error=%v", metadata.TaskID, metadata.BillingOrderID, uncertainErr)
			}
		}
		return err
	}
	return nil
}

// HTTP/API failures have direct upstream evidence. Local context interruption
// and unknown errors must not be presented as a channel failure merely because
// the request has no response status yet.
func providerRequestFailureOutcome(statusCode int, err error) (model.ApiCallStatus, string) {
	var httpErr providerHTTPError
	var payloadErr providerPayloadError
	var networkErr *net.OpError
	var decodeErr providerResponseDecodeError
	var requestTimeoutErr providerRequestTimeoutError
	switch {
	case errors.As(err, &requestTimeoutErr):
		return model.ApiCallStatusWarning, "application"
	case (statusCode > 0 && (statusCode < 200 || statusCode >= 300)), errors.As(err, &httpErr), errors.As(err, &payloadErr):
		return model.ApiCallStatusFailed, "upstream"
	case errors.As(err, &networkErr):
		return model.ApiCallStatusFailed, "network"
	case errors.Is(err, errProviderOutputLimit), errors.As(err, &decodeErr):
		return model.ApiCallStatusWarning, "content"
	}
	if code, _ := ChannelSlotFailureDetails(err); code != "" {
		return model.ApiCallStatusWarning, "application"
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return model.ApiCallStatusWarning, "application"
	}
	return model.ApiCallStatusWarning, "unknown"
}

func providerRequestIsBillable(method, requestKind string) bool {
	if method != http.MethodPost {
		return false
	}
	switch requestKind {
	case "cancel", "cache-create", "cache-delete":
		return false
	default:
		return true
	}
}

func providerRequestErrorDetails(err error) (string, string) {
	if err == nil {
		return "", ""
	}
	var requestTimeoutErr providerRequestTimeoutError
	if errors.As(err, &requestTimeoutErr) {
		if requestTimeoutErr.receiving {
			return "provider_response_read_timeout", requestTimeoutErr.Error()
		}
		return "provider_request_timeout", requestTimeoutErr.Error()
	}
	if errors.Is(err, errProviderOutputLimit) {
		return providerOutputLimitCode, errProviderOutputLimit.Error()
	}
	var decodeErr providerResponseDecodeError
	if errors.As(err, &decodeErr) {
		return "upstream_response_invalid", safeProviderLogError(err)
	}
	if errors.Is(err, context.Canceled) {
		return "request_cancelled", "执行上下文已取消，请核对任务状态"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "upstream_timeout", "执行等待时间已到，请核对任务状态"
	}
	return "", safeProviderLogError(err)
}

func safeProviderLogError(err error) string {
	var httpErr providerHTTPError
	if errors.As(err, &httpErr) {
		return fmt.Sprintf("上游 HTTP %d", httpErr.StatusCode)
	}
	return truncateRunes(err.Error(), 500)
}

func providerRequestKind(method string, path string) string {
	if method == http.MethodGet {
		if strings.HasSuffix(strings.TrimRight(path, "/"), "/content") || strings.Contains(path, "/download") {
			return "download"
		}
		return "poll"
	}
	if strings.Contains(path, "repair") {
		return "repair"
	}
	return "create"
}

func apiURL(baseURL string, path string) string {
	return apiURLWithDefaultPrefix(baseURL, path, "/v1")
}

// ChannelAPIURL 是 Provider 请求拼接 URL 的唯一公共入口。
// 渠道地址可配置为 host、host/、host/v1 或 host/v1/；调用方应传协议路径，避免重复硬编码版本前缀。
func ChannelAPIURL(baseURL string, path string) string {
	return apiURL(baseURL, path)
}

// ChannelAPIURLForProtocol 把协议默认版本收敛在传输边界：Gemini 默认 v1beta，
// OpenAI 兼容协议默认 v1；baseURL 或 path 中显式出现的版本始终优先。
func ChannelAPIURLForProtocol(baseURL string, path string, interfaceType model.ChannelInterfaceType) string {
	if interfaceType == model.ChannelInterfaceAgnesVideo && strings.HasPrefix(strings.TrimSpace(path), "/agnesapi") {
		base, err := url.Parse(strings.TrimSpace(baseURL))
		requestPath, pathErr := url.Parse(strings.TrimSpace(path))
		if err == nil && pathErr == nil && base.Scheme != "" && base.Host != "" && strings.HasPrefix(requestPath.Path, "/") {
			base.Path = requestPath.Path
			base.RawPath = requestPath.RawPath
			base.RawQuery = requestPath.RawQuery
			base.Fragment = ""
			return base.String()
		}
	}
	defaultPrefix := "/v1"
	if interfaceType == model.ChannelInterfaceGeminiVeo || interfaceType == model.ChannelInterfaceGeminiImage {
		defaultPrefix = "/v1beta"
	}
	return apiURLWithDefaultPrefix(baseURL, path, defaultPrefix)
}

var channelAPIPrefixes = []string{"/api/plan/v3", "/api/v3", "/api/v1", "/v1beta", "/v1", "/v2", "/v3"}
var requestAPIVersionPattern = regexp.MustCompile(`(?i)^/(?:api/)?v[0-9]+(?:alpha[0-9]*|beta[0-9]*)?(?:/|$)`)
var baseAPIVersionPattern = regexp.MustCompile(`(?i)/(?:api/)?v[0-9]+(?:alpha[0-9]*|beta[0-9]*)?$`)

func apiURLWithDefaultPrefix(baseURL string, path string, defaultPrefix string) string {
	parsedBase, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return ""
	}
	base := strings.TrimRight(parsedBase.EscapedPath(), "/")
	requestPath := strings.TrimSpace(path)
	if requestPath == "" {
		return strings.TrimRight(strings.TrimSpace(baseURL), "/")
	}
	if !strings.HasPrefix(requestPath, "/") {
		requestPath = "/" + requestPath
	}

	parsedRequest, err := url.Parse(requestPath)
	if err != nil || parsedRequest.Host != "" {
		return ""
	}
	requestPath = parsedRequest.EscapedPath()
	requestPrefix := requestAPIPathPrefix(requestPath)
	basePrefix := baseAPIPathPrefix(base)
	var joined string
	if requestPrefix != "" {
		if basePrefix == requestPrefix {
			joined = base + requestPath[len(requestPrefix):]
		} else {
			joined = base[:len(base)-len(basePrefix)] + requestPath
		}
		// 请求路径显式版本优先于 baseURL 残留版本，例如 base=/v1、path=/v2/... 时必须切到 /v2。
	} else if basePrefix != "" {
		joined = base + requestPath
	} else {
		joined = base + defaultPrefix + requestPath
	}
	parsedBase.Path, err = url.PathUnescape(joined)
	if err != nil {
		return ""
	}
	parsedBase.RawPath = joined
	query := parsedBase.Query()
	for key, values := range parsedRequest.Query() {
		query[key] = values
	}
	parsedBase.RawQuery = query.Encode()
	parsedBase.Fragment = ""
	return parsedBase.String()
}

func requestAPIPathPrefix(value string) string {
	lower := strings.ToLower(value)
	for _, prefix := range channelAPIPrefixes {
		if lower == prefix || strings.HasPrefix(lower, prefix+"/") || strings.HasPrefix(lower, prefix+"?") || strings.HasPrefix(lower, prefix+"#") {
			return prefix
		}
	}
	return strings.TrimRight(requestAPIVersionPattern.FindString(value), "/")
}

func baseAPIPathPrefix(value string) string {
	lower := strings.ToLower(strings.TrimRight(value, "/"))
	for _, prefix := range channelAPIPrefixes {
		if lower == prefix || strings.HasSuffix(lower, prefix) {
			return prefix
		}
	}
	return baseAPIVersionPattern.FindString(value)
}

func writeField(writer *multipart.Writer, key string, value string) {
	_ = writer.WriteField(key, value)
}

func writeMediaPart(writer *multipart.Writer, field string, media providerMedia) error {
	raw, mimeType, err := mediaBytes(media)
	if err != nil {
		return err
	}
	filename := providerMediaFilename(media, mimeType)
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", mime.FormatMediaType("form-data", map[string]string{"name": field, "filename": filename}))
	header.Set("Content-Type", mimeType)
	part, err := writer.CreatePart(header)
	if err != nil {
		return err
	}
	_, err = part.Write(raw)
	return err
}

func providerMediaFilename(media providerMedia, mimeType string) string {
	base := strings.TrimSpace(media.ID)
	if base == "" {
		base = "reference"
	}
	var builder strings.Builder
	for _, char := range base {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char == '-' || char == '_' {
			builder.WriteRune(char)
			if builder.Len() >= 64 {
				break
			}
		}
	}
	base = builder.String()
	if base == "" {
		base = "reference"
	}
	extensions, _ := mime.ExtensionsByType(strings.TrimSpace(strings.Split(mimeType, ";")[0]))
	extension := ".bin"
	if len(extensions) > 0 {
		extension = extensions[0]
	}
	return "reference-" + base + extension
}

func mediaBytes(media providerMedia) ([]byte, string, error) {
	value := media.DataURL
	if value == "" {
		value = media.URL
	}
	if !strings.HasPrefix(value, "data:") {
		return nil, "", errors.New("后端任务队列需要 data URL 形式的本地参考素材")
	}
	header, encoded, ok := strings.Cut(value, ",")
	if !ok {
		return nil, "", errors.New("data URL 格式错误")
	}
	mimeType := strings.TrimPrefix(strings.Split(strings.TrimPrefix(header, "data:"), ";")[0], " ")
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, "", err
	}
	return raw, normalizedMediaMimeType(defaultString(mimeType, media.Type), raw), nil
}
