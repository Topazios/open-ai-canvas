package app

import (
	"fmt"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestReasoningUsageIsReportedSubsetNotExtraOutput(t *testing.T) {
	for _, key := range []string{"output_tokens_details", "completion_tokens_details"} {
		for _, test := range []struct {
			value string
			want  *int64
		}{
			{"0", int64Pointer(0)}, {"6", int64Pointer(6)}, {"10", int64Pointer(10)},
			{"-1", nil}, {"11", nil}, {"1.5", nil}, {`"6"`, nil}, {"null", nil}, {"9223372036854775808", nil},
		} {
			t.Run(key+"/"+test.value, func(t *testing.T) {
				log := &model.ApiCallLog{Capability: "text", Status: model.ApiCallStatusSucceeded}
				new(Service).EnrichAPICallLog(log, []byte(fmt.Sprintf(`{"usage":{"input_tokens":4,"output_tokens":10,%q:{"reasoning_tokens":%s}}}`, key, test.value)))
				if log.InputTokens != 4 || log.OutputTokens != 10 || !log.UsageAvailable {
					t.Fatalf("breakdown changed total usage: %+v", log)
				}
				if test.want == nil && log.ReasoningTokens != nil || test.want != nil && (log.ReasoningTokens == nil || *test.want != *log.ReasoningTokens) {
					t.Fatalf("reasoning=%v want=%v", log.ReasoningTokens, test.want)
				}
			})
		}
	}
	log := &model.ApiCallLog{Capability: "text", Status: model.ApiCallStatusFailed}
	new(Service).EnrichAPICallLog(log, []byte("event: response.incomplete\ndata: {\"response\":{\"status\":\"incomplete\",\"incomplete_details\":{\"reason\":\"max_output_tokens\"},\"usage\":{\"output_tokens\":10,\"output_tokens_details\":{\"reasoning_tokens\":10}}}}\n\n"))
	if log.ReasoningTokens == nil || *log.ReasoningTokens != 10 || log.OutputTokens != 10 || log.ErrorCode != providerOutputLimitCode {
		t.Fatalf("failed response lost accurate usage: %+v", log)
	}
	unknown := &model.ApiCallLog{Capability: "text"}
	new(Service).EnrichAPICallLog(unknown, []byte(`{"usage":{"output_tokens":10},"output_text":"a very long answer"}`))
	if unknown.ReasoningTokens != nil {
		t.Fatal("inferred unreported reasoning tokens")
	}
}

func int64Pointer(value int64) *int64 { return &value }
