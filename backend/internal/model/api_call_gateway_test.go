package model

import "testing"

func TestGatewayTimeoutProjectionPreservesReceipt(t *testing.T) {
	for _, status := range []int{504, 524} {
		row := ApiCallLog{Status: ApiCallStatusFailed, StatusCode: status, ErrorSource: "upstream", ResponseBody: "openresty", EstimatedCostMicros: 123, ProviderRequestID: "receipt-id"}
		if row.DisplayStatus() != ApiCallStatusWarning {
			t.Fatal("legacy gateway still shown as model failure")
		}
		row.ProjectGatewayTimeout()
		if row.ErrorSource != "gateway" || row.ErrorCode != GatewayResponseUnconfirmed || row.ResponseBody != "openresty" || row.StatusCode != status || row.EstimatedCostMicros != 123 || row.ProviderRequestID != "receipt-id" {
			t.Fatalf("projection changed facts: %+v", row)
		}
	}
	row := ApiCallLog{Status: ApiCallStatusFailed, StatusCode: 400, ErrorSource: "upstream"}
	row.ProjectGatewayTimeout()
	if row.Status != ApiCallStatusFailed || row.ErrorSource != "upstream" {
		t.Fatal("explicit rejection hidden")
	}
}
