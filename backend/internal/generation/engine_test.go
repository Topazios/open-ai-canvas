package generation_test

import (
	"net/http"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/generation"
)

func TestGenerationPackageHasEngineAndOfficialRegistry(t *testing.T) {
	engine := generation.NewEngine(generation.Deps{})
	if engine == nil {
		t.Fatal("NewEngine returned nil")
	}
	if name, ok := generation.OfficialDeclarativeImageInterface("openai-image"); !ok || name == "" {
		t.Fatalf("openai-image whitelist = %q %v", name, ok)
	}
	registry := generation.LoadOfficialFallbackRegistry()
	if registry == nil {
		t.Fatal("LoadOfficialFallbackRegistry returned nil")
	}
}

func TestGatewayTimeoutWarnsAboutUncertainProviderCompletion(t *testing.T) {
	for _, status := range []int{http.StatusGatewayTimeout, 524} {
		message := (generation.HTTPError{StatusCode: status}).Error()
		if !strings.Contains(message, "可能仍在服务端执行并产生费用") || !strings.Contains(message, "请勿立即重试") || !strings.Contains(message, "核对任务或账单") {
			t.Fatalf("HTTPError(%d).Error() = %q", status, message)
		}
	}
}
