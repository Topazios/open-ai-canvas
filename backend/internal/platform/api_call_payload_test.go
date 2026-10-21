package platform

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestSanitizeAPICallPayloadSummarizesLargeInlineImages(t *testing.T) {
	dataURL := "data:image/png;base64," + strings.Repeat("A", 2<<20)
	payload, err := json.Marshal(map[string]any{
		"model": "image-model",
		"images": []any{map[string]any{"image_url": dataURL}},
		"api_key": "must-not-be-logged",
	})
	if err != nil {
		t.Fatal(err)
	}

	got := SanitizeAPICallPayload(payload, "application/json")
	if !strings.Contains(got, "内嵌媒体 image/png") || !strings.Contains(got, fmt.Sprintf("%d 字符", len(dataURL))) {
		t.Fatalf("large JSON image was not summarized: %s", got)
	}
	if strings.Contains(got, strings.Repeat("A", 128)) || strings.Contains(got, "must-not-be-logged") {
		t.Fatal("payload sanitizer leaked inline image bytes or credentials")
	}
	if bytes.Contains([]byte(got), []byte(dataURL)) {
		t.Fatal("payload sanitizer retained the complete data URL")
	}
}
