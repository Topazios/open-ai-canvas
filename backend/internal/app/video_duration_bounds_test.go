package app

import (
	"encoding/json"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestVideoDurationUsesDeclaredBounds(t *testing.T) {
	profile := DefaultModelCapabilityConfigForModel("videos-generations-capability", "omni-fast")
	if profile.Video.Duration.Max != 0 {
		t.Fatal("generic protocol invented a duration ceiling")
	}
	for _, seconds := range []int{24, 120, 4000} {
		if !videoDurationAllowed(profile.Video.Duration, seconds) {
			t.Fatalf("unbounded duration rejected %d", seconds)
		}
	}
	if videoDurationAllowed(profile.Video.Duration, 0) || videoDurationAllowed(profile.Video.Duration, -1) {
		t.Fatal("nonpositive duration accepted")
	}
	profile.Video.Duration.Max = 30
	profile.Video.Duration.Default = 24
	if err := validateVideoDuration(profile.Video.Duration); err != nil {
		t.Fatal(err)
	}
	if !videoDurationAllowed(profile.Video.Duration, 24) || videoDurationAllowed(profile.Video.Duration, 31) {
		t.Fatal("configured bound ignored")
	}
	profile.Video.Duration.Max = 0
	profile.Video.Duration.Step = 2
	profile.Video.Duration.Default = 5
	if videoDurationAllowed(profile.Video.Duration, 24) || !videoDurationAllowed(profile.Video.Duration, 25) {
		t.Fatal("step ignored without maximum")
	}
	for _, duration := range []VideoDurationConfig{
		{Selection: "range", Min: 1, Max: -1, Step: 1, Default: 1},
		{Selection: "range", Min: 2, Max: 1, Step: 1, Default: 2},
		{Selection: "range", Min: 1, Step: 0, Default: 1},
	} {
		if validateVideoDuration(duration) == nil {
			t.Fatalf("invalid duration accepted: %+v", duration)
		}
	}
	if err := validateVideoDuration(VideoDurationConfig{Selection: "enum", Values: []int{24, 4000}, Default: 24}); err != nil {
		t.Fatal(err)
	}
}

func TestVideoUnboundedDurationProjectsAndValidates(t *testing.T) {
	profile := DefaultModelCapabilityConfigForModel("videos-generations-capability", "omni-fast")
	spec, err := CapabilitySpecFromModelCapabilityConfig(profile, "video")
	if err != nil {
		t.Fatal(err)
	}
	constraint := spec.Options["videoSeconds"]
	if _, err := NormalizeCapabilitySpec(spec); err != nil {
		t.Fatalf("unbounded duration cannot enter logical catalog: %v", err)
	}
	if constraint.Max != nil || constraint.Min == nil || *constraint.Min != 1 {
		t.Fatalf("incorrect routing bound: %+v", constraint)
	}
	input := canvasGenerationInput{Config: providerConfig{VideoSeconds: "24", Size: "16:9", VQuality: "720p"}}
	if err := validateVideoTask(profile.Video, input); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(profile)
	tiers := []model.ChannelModelPriceTier{{Resolution: "720p", VideoSeconds: 24}}
	if err := validateChannelModelTierCapabilities(tiers, string(raw), "video"); err != nil {
		t.Fatal(err)
	}
	profile.Video.Duration.Max = 15
	raw, _ = json.Marshal(profile)
	if validateChannelModelTierCapabilities(tiers, string(raw), "video") == nil {
		t.Fatal("invalid price configuration accepted")
	}
	if err := validateVideoTask(profile.Video, input); err != nil {
		t.Fatalf("video request blocked by advisory capability: %v", err)
	}
}
