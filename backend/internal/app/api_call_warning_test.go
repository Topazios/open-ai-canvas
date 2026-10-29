package app

import (
	"encoding/csv"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
)

func TestAPICallWarningKeepsExplicitProviderFailuresAndUsage(t *testing.T) {
	for _, tc := range []struct {
		name, body, code, source string
		http                     int
		want                     model.ApiCallStatus
		wantSource               string
	}{
		{"limit", `{"status":"incomplete","error":null,"incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":31,"output_tokens":16383,"output_tokens_details":{"reasoning_tokens":16383}}}`, "output_limit_exceeded", "", 200, model.ApiCallStatusWarning, "content"},
		{"unknown-incomplete", `{"status":"incomplete","error":null}`, "", "", 200, model.ApiCallStatusWarning, "content"},
		{"local-decode", `invalid json`, "upstream_response_invalid", "", 200, model.ApiCallStatusWarning, "content"},
		{"error-object-limit-code", `{"status":"incomplete","error":{"code":"output_limit_exceeded","message":"provider rejected request"}}`, "output_limit_exceeded", "", 200, model.ApiCallStatusFailed, "upstream"},
		{"error-object-decode-code", `{"status":"completed","error":{"code":"upstream_response_invalid","message":"provider failed"}}`, "upstream_response_invalid", "", 200, model.ApiCallStatusFailed, "upstream"},
		{"explicit-failed", `{"status":"failed","error":null}`, "output_limit_exceeded", "", 200, model.ApiCallStatusFailed, "upstream"},
		{"explicit-canceled", `{"status":"canceled","error":null}`, "output_limit_exceeded", "", 200, model.ApiCallStatusFailed, "upstream"},
		{"sse-failed", "event: response.failed\ndata: {\"response\":{\"status\":\"incomplete\"}}\n\n", "output_limit_exceeded", "", 200, model.ApiCallStatusFailed, "upstream"},
		{"sse-error", "event: error\ndata: {}\n\n", "upstream_response_invalid", "", 200, model.ApiCallStatusFailed, "upstream"},
		{"sse-error-malformed", "event: error\ndata: invalid\n\n", "upstream_response_invalid", "", 200, model.ApiCallStatusFailed, "upstream"},
		{"sse-error-before-incomplete", "event: error\ndata: {\"error\":{\"code\":\"provider_broken\",\"message\":\"provider failed\"}}\n\nevent: response.incomplete\ndata: {\"response\":{\"status\":\"incomplete\",\"incomplete_details\":{\"reason\":\"max_output_tokens\"}}}\n\n", "provider_broken", "", 200, model.ApiCallStatusFailed, "upstream"},
		{"http-error", `{"error":{"code":"output_limit_exceeded","message":"provider rejected request"}}`, "output_limit_exceeded", "", 429, model.ApiCallStatusFailed, "upstream"},
		{"application", `{"status":"completed"}`, "upstream_response_invalid", "application", 200, model.ApiCallStatusFailed, "application"},
		{"wording-not-proof", `{"status":"completed"}`, "other_error", "", 200, model.ApiCallStatusFailed, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			log := model.ApiCallLog{Status: model.ApiCallStatusFailed, StatusCode: tc.http, Capability: "text", ErrorCode: tc.code, ErrorSource: tc.source, Error: "output limit; invalid response"}
			(&Service{}).EnrichAPICallLog(&log, []byte(tc.body))
			if log.Status != tc.want || log.ErrorSource != tc.wantSource || log.ErrorCode != tc.code || log.StatusCode != tc.http {
				t.Fatalf("wrong attribution/status or rewritten code: status=%s source=%q code=%q http=%d", log.Status, log.ErrorSource, log.ErrorCode, log.StatusCode)
			}
			if tc.name == "limit" && (log.InputTokens != 31 || log.OutputTokens != 16383 || log.ReasoningTokens == nil || *log.ReasoningTokens != 16383 || !log.UsageAvailable) {
				t.Fatalf("warning lost upstream token facts: %+v", log)
			}
			if tc.name == "error-object-limit-code" {
				s, db, _, _ := creationTestService(t)
				log.ID, log.UserID, log.RequestKind = "explicit-limit-error", "user", "create"
				if err := s.LogAPICall(log); err != nil {
					t.Fatal(err)
				}
				var stored model.ApiCallLog
				if err := db.First(&stored, "id = ?", log.ID).Error; err != nil {
					t.Fatal(err)
				}
				if stored.Status != model.ApiCallStatusFailed || stored.ErrorSource != "upstream" || stored.ErrorCode != "output_limit_exceeded" {
					t.Fatalf("explicit upstream error changed during persistence: %+v", stored)
				}
			}
		})
	}
}

func TestAPICallWarningPersistsAndMatchesHistoryListDetailAndExport(t *testing.T) {
	s, db, _, _ := creationTestService(t)
	now := time.Now()
	entries := []model.ApiCallLog{
		{ID: "old-limit", UserID: "user", Status: model.ApiCallStatusFailed, StatusCode: 200, ErrorCode: "output_limit_exceeded", ProviderStatus: "incomplete", ResponseBody: `{"text":"The words error and failed do not establish a provider error"}`},
		{ID: "old-incomplete", UserID: "user", Status: model.ApiCallStatusFailed, StatusCode: 200, ProviderStatus: "incomplete"},
		{ID: "old-decode", UserID: "user", Status: model.ApiCallStatusFailed, StatusCode: 200, ErrorCode: "upstream_response_invalid"},
		{ID: "provider-failed", UserID: "user", Status: model.ApiCallStatusFailed, StatusCode: 200, ErrorCode: "output_limit_exceeded", ProviderStatus: "failed"},
		{ID: "provider-canceled", UserID: "user", Status: model.ApiCallStatusFailed, StatusCode: 200, ErrorCode: "output_limit_exceeded", ProviderStatus: "canceled"},
		{ID: "provider-error", UserID: "user", Status: model.ApiCallStatusFailed, StatusCode: 200, ErrorCode: "output_limit_exceeded", ProviderStatus: "incomplete", ErrorSource: "upstream"},
		{ID: "old-provider-error", UserID: "user", Status: model.ApiCallStatusFailed, StatusCode: 200, ErrorCode: "output_limit_exceeded", ProviderStatus: "incomplete", ResponseBody: `{"status":"incomplete","error":{"code":"output_limit_exceeded","message":"explicit provider failure"}}`},
		{ID: "old-sse-error", UserID: "user", Status: model.ApiCallStatusFailed, StatusCode: 200, ErrorCode: "upstream_response_invalid", ResponseBody: "event: error\ndata: {\"error\":{\"code\":\"upstream_response_invalid\"}}\n\n"},
		{ID: "old-sse-malformed-error", UserID: "user", Status: model.ApiCallStatusFailed, StatusCode: 200, ErrorCode: "upstream_response_invalid", ResponseBody: "event: error\ndata: invalid\n\n"},
		{ID: "old-sse-empty-error", UserID: "user", Status: model.ApiCallStatusFailed, StatusCode: 200, ErrorCode: "upstream_response_invalid", ResponseBody: "event: error\ndata:\n\n"},
		{ID: "old-sse-done-error", UserID: "user", Status: model.ApiCallStatusFailed, StatusCode: 200, ErrorCode: "upstream_response_invalid", ResponseBody: "event: error\ndata: [DONE]\n\n"},
		{ID: "application-error", UserID: "user", Status: model.ApiCallStatusFailed, StatusCode: 200, ErrorCode: "upstream_response_invalid", ErrorSource: "application"},
		{ID: "unknown-error", UserID: "user", Status: model.ApiCallStatusFailed, StatusCode: 200, Error: "output limit; invalid response"},
		{ID: "http-error", UserID: "user", Status: model.ApiCallStatusFailed, StatusCode: 429, ErrorCode: "output_limit_exceeded"},
	}
	for index := range entries {
		entries[index].CreatedAt = now
		entries[index].RequestKind = "create"
		entries[index].Capability = "text"
	}
	if err := db.Create(&entries).Error; err != nil {
		t.Fatal(err)
	}
	for _, entry := range []model.ApiCallLog{
		{ID: "new-warning", UserID: "user", Status: model.ApiCallStatusFailed, StatusCode: 200, ErrorCode: "output_limit_exceeded", ProviderStatus: "incomplete", RequestKind: "create", Capability: "text", CreatedAt: now, InputTokens: 31, OutputTokens: 16383, UsageAvailable: true},
		{ID: "new-provider-error", UserID: "user", Status: model.ApiCallStatusFailed, StatusCode: 200, ErrorCode: "output_limit_exceeded", ProviderStatus: "incomplete", ErrorSource: "upstream", RequestKind: "create", Capability: "text", CreatedAt: now},
	} {
		if err := s.LogAPICall(entry); err != nil {
			t.Fatal(err)
		}
		var stored model.ApiCallLog
		if err := db.First(&stored, "id = ?", entry.ID).Error; err != nil {
			t.Fatal(err)
		}
		if stored.Status != entry.DisplayStatus() || stored.ErrorCode != entry.ErrorCode {
			t.Fatalf("new receipt not persisted correctly: %+v", stored)
		}
		if entry.ID == "new-warning" && (stored.ErrorSource != "content" || stored.OutputTokens != 16383 || !stored.UsageAvailable) {
			t.Fatalf("new warning lost source/usage: %+v", stored)
		}
	}
	actor := &model.User{ID: "user", Role: model.UserRoleAdmin}
	for _, status := range []model.ApiCallStatus{model.ApiCallStatusWarning, model.ApiCallStatusFailed} {
		query := APICallLogQuery{AnalyticsQuery: AnalyticsQuery{From: now.Add(-time.Hour).Format(time.RFC3339), To: now.Add(time.Hour).Format(time.RFC3339)}, Status: string(status), Limit: 200}
		page, err := s.AdminAPICallLogs(actor, query)
		if err != nil {
			t.Fatal(err)
		}
		want := 12
		if status == model.ApiCallStatusWarning {
			want = 4
		}
		if page.Total != int64(want) || len(page.Logs) != want {
			t.Fatalf("%s filter returned total=%d rows=%d", status, page.Total, len(page.Logs))
		}
		for _, log := range page.Logs {
			if log.Status != status {
				t.Fatalf("filter/status mismatch: %+v", log)
			}
			detail, err := s.AdminAPICallLog(actor, log.ID)
			if err != nil || detail.Status != status || detail.ErrorCode != log.ErrorCode || detail.ErrorSource != log.ErrorSource {
				t.Fatalf("detail mismatch: detail=%+v err=%v", detail, err)
			}
		}
		body, err := s.AdminAPICallLogsCSV(actor, query)
		if err != nil {
			t.Fatal(err)
		}
		rows, err := csv.NewReader(strings.NewReader(strings.TrimPrefix(string(body), "\uFEFF"))).ReadAll()
		if err != nil || len(rows) != want+1 {
			t.Fatalf("export rows=%d err=%v", len(rows), err)
		}
		for _, row := range rows[1:] {
			if row[6] != string(status) {
				t.Fatalf("export status mismatch: %v", row)
			}
		}
	}
	for _, old := range entries {
		var stored model.ApiCallLog
		if err := db.First(&stored, "id = ?", old.ID).Error; err != nil {
			t.Fatal(err)
		}
		if stored.Status != old.Status || stored.ErrorCode != old.ErrorCode || stored.ErrorSource != old.ErrorSource || stored.ResponseBody != old.ResponseBody {
			t.Fatalf("history was rewritten: %+v", stored)
		}
	}
}
