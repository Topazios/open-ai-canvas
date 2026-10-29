package app

import (
	"bytes"
	"image"
	"image/png"
	"math/rand"
	"testing"
)

func TestStoryboardReferenceEncodingPreservesAllReferencesAndDimensions(t *testing.T) {
	pixels := image.NewNRGBA(image.Rect(0, 0, 320, 240))
	random := rand.New(rand.NewSource(1))
	random.Read(pixels.Pix)
	for i := 3; i < len(pixels.Pix); i += 4 {
		pixels.Pix[i] = 255
	}
	var original bytes.Buffer
	if err := png.Encode(&original, pixels); err != nil {
		t.Fatal(err)
	}
	uri := dataURL("image/png", original.Bytes())
	input := canvasGenerationInput{Mode: "image", Metadata: map[string]interface{}{"storyboardFrame": map[string]interface{}{"kind": "start"}}, ReferenceImages: []providerMedia{{ID: "a", DataURL: uri}, {ID: "b", DataURL: uri}}}
	if err := prepareStoryboardReferenceImages(&input); err != nil {
		t.Fatal(err)
	}
	if len(input.ReferenceImages) != 2 {
		t.Fatal("reference removed")
	}
	for _, media := range input.ReferenceImages {
		mime, raw, err := decodeProviderDataURL(media.DataURL)
		if err != nil || mime != "image/jpeg" || len(raw) >= original.Len() {
			t.Fatalf("mime=%s bytes=%d original=%d err=%v", mime, len(raw), original.Len(), err)
		}
		cfg, _, err := image.DecodeConfig(bytes.NewReader(raw))
		if err != nil || cfg.Width != 320 || cfg.Height != 240 {
			t.Fatalf("dimensions=%+v err=%v", cfg, err)
		}
	}
	for _, tc := range []struct {
		name     string
		metadata map[string]interface{}
		mask     *providerMedia
	}{
		{"ordinary", nil, nil}, {"mask", input.Metadata, &providerMedia{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ordinary := canvasGenerationInput{Mode: "image", Metadata: tc.metadata, Mask: tc.mask, ReferenceImages: []providerMedia{{DataURL: uri}}}
			if err := prepareStoryboardReferenceImages(&ordinary); err != nil {
				t.Fatal(err)
			}
			if ordinary.ReferenceImages[0].DataURL != uri {
				t.Fatal("ordinary edits or masks changed")
			}
		})
	}
	pixels.Pix[3] = 0
	original.Reset()
	png.Encode(&original, pixels)
	transparent := dataURL("image/png", original.Bytes())
	input.ReferenceImages = []providerMedia{{DataURL: transparent}}
	if err := prepareStoryboardReferenceImages(&input); err != nil {
		t.Fatal(err)
	}
	if input.ReferenceImages[0].DataURL != transparent {
		t.Fatal("alpha channel was lost")
	}
}
