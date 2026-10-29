package app

import (
	"strings"
	"testing"
	"time"
)

func TestProviderJSONBodyCompleteHandlesLargePartialAndCompleteBodies(t *testing.T) {
	complete := []byte(`{"data":[{"b64_json":"` + strings.Repeat("A", 200<<10) + `"}]}` + "\n")
	if !providerJSONBodyComplete(complete) {
		t.Fatal("complete large JSON should be recognized")
	}
	partial := complete[:len(complete)-8]
	if providerJSONBodyComplete(partial) {
		t.Fatal("truncated large JSON must not be treated as complete")
	}
	if providerJSONBodyComplete([]byte(`{"a":1`)) || !providerJSONBodyComplete([]byte(`{"a":1}`)) {
		t.Fatal("small bodies must keep full JSON validation")
	}
	// 40MB 响应按 32KB 分块读取的总校验耗时应保持线性。
	large := []byte(`{"data":[{"b64_json":"` + strings.Repeat("A", 40<<20) + `"}]}`)
	started := time.Now()
	for end := 32 << 10; end < len(large)-1; end += 32 << 10 {
		if providerJSONBodyComplete(large[:end]) {
			t.Fatal("partial body reported complete")
		}
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("chunked completeness checks too slow: %s", elapsed)
	}
}