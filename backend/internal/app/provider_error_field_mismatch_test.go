package app

import (
	"strings"
	"testing"
)

func TestProviderHTTPErrorFieldMismatchPointsAtProtocol(t *testing.T) {
	err := providerHTTPError{StatusCode: 400, Body: `{"error":{"message":"reference_images is not supported; use reference_image_urls or the model's first_image_url"}}`}
	got := err.Error()
	if !strings.Contains(got, "渠道所选协议") {
		t.Fatalf("缺少协议不匹配提示: %s", got)
	}
	if !strings.Contains(got, "reference_image_urls") {
		t.Fatalf("应保留上游给出的字段提示: %s", got)
	}
}