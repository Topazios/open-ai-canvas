package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestVideoParametersReachUpstreamWithoutCapabilityBlocking(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	for _, reject := range []bool{false, true} {
		t.Run(fmt.Sprintf("upstream_rejects_%t", reject), func(t *testing.T) {
			calls := 0
			var received map[string]any
			var server *httptest.Server
			server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch r.Method + " " + r.URL.Path {
				case "POST /v1/videos/generations":
					calls++
					if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
						t.Error(err)
						http.Error(w, "invalid JSON", 400)
						return
					}
					if reject {
						w.WriteHeader(http.StatusBadRequest)
						fmt.Fprint(w, `{"error":{"message":"provider does not accept this duration","code":"invalid_duration"}}`)
						return
					}
					fmt.Fprint(w, `{"id":"video-test","status":"queued"}`)
				case "GET /v1/videos/generations/video-test":
					fmt.Fprintf(w, `{"id":"video-test","status":"completed","video_url":%q}`, server.URL+"/result.mp4")
				case "GET /result.mp4":
					w.Header().Set("Content-Type", "video/mp4")
					fmt.Fprint(w, "test-video")
				default:
					http.NotFound(w, r)
				}
			}))
			defer server.Close()
			profile := DefaultModelCapabilityConfigForModel("videos-generations-capability", "omni-fast").Video
			profile.Duration.Max = 15
			profile.Resolutions = []string{"480p"}
			profile.References.MaxImages = 1
			input := canvasGenerationInput{
				Mode:            "video",
				Prompt:          strings.Repeat("scene ", 2000),
				Config:          providerConfig{InterfaceType: "videos-generations-capability", BaseURL: server.URL, APIKey: "test", Model: "omni-fast", VideoSeconds: "24", VQuality: "1080p", Size: "21:9"},
				VideoCapability: profile,
				Metadata:        map[string]interface{}{"videoEditOperation": "reference_to_video", "videoStartFrameNodeId": "first", "videoEndFrameNodeId": "last"},
				ReferenceImages: []providerMedia{
					{ID: "first", URL: "https://cdn.example/first.png"},
					{ID: "last", URL: "https://cdn.example/last.png"},
				},
			}
			for i := 0; i < 6; i++ {
				input.ReferenceImages = append(input.ReferenceImages, providerMedia{ID: fmt.Sprint(i), URL: fmt.Sprintf("https://cdn.example/ref-%d.png", i)})
			}
			applyFixedVideoResolution(&input, profile)
			if err := validateVideoTask(profile, input); err != nil {
				t.Fatal(err)
			}
			result, err := runVideoTaskWithPolicy(context.Background(), input, fastVideoPollPolicy())
			if calls != 1 {
				t.Fatalf("create calls=%d, err=%v", calls, err)
			}
			if received["duration"] != float64(24) || received["resolution"] != "1080p" {
				t.Fatalf("parameters changed: %#v", received)
			}
			if received["first_image_url"] != "https://cdn.example/first.png" || received["last_image_url"] != "https://cdn.example/last.png" {
				t.Fatalf("frame roles lost: %#v", received)
			}
			if refs, _ := received["reference_image_urls"].([]any); len(refs) != 6 {
				t.Fatalf("reference images truncated: %#v", received)
			}
			if !strings.Contains(fmt.Sprint(received["prompt"]), strings.TrimSpace(input.Prompt)) {
				t.Fatal("prompt truncated")
			}
			if reject {
				var providerErr providerHTTPError
				if !errors.As(err, &providerErr) || providerErr.StatusCode != 400 || !strings.Contains(err.Error(), "provider does not accept") {
					t.Fatalf("upstream failure not retained: %T %v", err, err)
				}
			} else if err != nil || result["mode"] != "video" {
				t.Fatalf("result=%#v, err=%v", result, err)
			}
		})
	}
}

func TestVideoCapabilityMatchingDefersSupportButPreservesModality(t *testing.T) {
	profile := DefaultModelCapabilityConfigForModel("videos-generations-capability", "omni-fast")
	profile.Video.Duration.Max = 15
	spec, err := CapabilitySpecFromModelCapabilityConfig(profile, "video")
	if err != nil {
		t.Fatal(err)
	}
	intent := ModelRequestIntent{Capability: "video", Operation: "reference_to_video", Inputs: map[string]int{"image": 15, "video": 2, "audio": 2}, Options: map[string]any{"videoSeconds": 24, "size": "21:9", "vquality": "custom", "videoGenerateAudio": true}}
	if match := MatchCapability(spec, intent); !match.Matched {
		t.Fatalf("blocked: %#v", match)
	}
	intent.Capability = "image"
	if MatchCapability(spec, intent).Matched {
		t.Fatal("wrong modality accepted")
	}
	intent.Capability = "video"
	intent.Inputs["image"] = -1
	if MatchCapability(spec, intent).Matched {
		t.Fatal("negative input count accepted")
	}
}

func TestVideoPricingIntentRetainsUndeclaredSubmittedOptions(t *testing.T) {
	options := capabilityOptionsFromConfig("video", map[string]any{"videoGenerateAudio": "true", "vquality": "1080p", "videoSeconds": "24"}, map[string]OptionConstraint{})
	if options["videoGenerateAudio"] != "true" || options["vquality"] != "1080p" || options["videoSeconds"] != "24" {
		t.Fatalf("pricing intent lost submitted choices: %#v", options)
	}
}
