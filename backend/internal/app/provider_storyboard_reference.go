package app

import (
	"bytes"
	"fmt"
	"image"
	"image/jpeg"
	_ "image/png"
	"strings"

	"infinite-canvas/backend/internal/productionrules"
)

// Only storyboard reference copies are optimized. Originals, masks and ordinary
// image edits retain their exact bytes and dimensions.
func prepareStoryboardReferenceImages(input *canvasGenerationInput) error {
	if input.Mode != "image" || input.Metadata["storyboardFrame"] == nil || input.Mask != nil {
		return nil
	}
	policy := productionrules.StoryboardReferenceImageEncoding()
	if policy.Encoding != "jpeg" || policy.Quality < 1 || policy.Quality > 100 || policy.MaxPixels <= 0 {
		return fmt.Errorf("分镜参考图编码配置无效")
	}
	for i := range input.ReferenceImages {
		media := &input.ReferenceImages[i]
		if !strings.HasPrefix(media.DataURL, "data:image/png;") {
			continue
		}
		_, raw, err := decodeProviderDataURL(media.DataURL)
		if err != nil {
			return err
		}
		config, _, err := image.DecodeConfig(bytes.NewReader(raw))
		if err != nil {
			return fmt.Errorf("读取分镜参考图尺寸失败：%w", err)
		}
		// Large originals remain valid references; skip this optional in-memory
		// encoding rather than allocate an unbounded decoded bitmap.
		if config.Width <= 0 || config.Height <= 0 || int64(config.Width) > policy.MaxPixels/int64(config.Height) {
			continue
		}
		decoded, _, err := image.Decode(bytes.NewReader(raw))
		if err != nil {
			return fmt.Errorf("解码分镜参考图失败：%w", err)
		}
		if opaque, ok := decoded.(interface{ Opaque() bool }); !ok || !opaque.Opaque() {
			continue
		}
		var encoded bytes.Buffer
		if err := jpeg.Encode(&encoded, decoded, &jpeg.Options{Quality: policy.Quality}); err != nil {
			return err
		}
		if encoded.Len() >= len(raw) {
			continue
		}
		media.DataURL = dataURL("image/jpeg", encoded.Bytes())
		media.URL = ""
		media.Type, media.MimeType, media.Bytes = "image/jpeg", "image/jpeg", int64(encoded.Len())
		media.Width, media.Height = decoded.Bounds().Dx(), decoded.Bounds().Dy()
	}
	return nil
}
