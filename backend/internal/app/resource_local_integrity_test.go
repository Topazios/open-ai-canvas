package app

import (
	"os"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestWriteLocalResourceRejectsIncompleteFiles(t *testing.T) {
	s := &Service{dataDir: t.TempDir()}
	image := func(size int64) *model.Resource {
		return &model.Resource{Provider: "local", ObjectKey: "u/a.png", MimeType: "image/png", Size: size}
	}

	if err := s.writeLocalResource(image(3), strings.NewReader("abc")); err != nil {
		t.Fatal(err)
	}
	if !s.resourceObjectUsable(image(3)) {
		t.Fatal("complete file reported unusable")
	}

	if err := s.writeLocalResource(image(0), strings.NewReader("")); err == nil {
		t.Fatal("empty media file was accepted")
	}
	if _, err := os.Stat(s.localResourcePath(image(0))); !os.IsNotExist(err) {
		t.Fatal("empty file was left on disk")
	}
	text := &model.Resource{Provider: "local", ObjectKey: "u/a.txt", MimeType: "text/plain"}
	if err := s.writeLocalResource(text, strings.NewReader("")); err != nil {
		t.Fatalf("empty non-media file must stay allowed: %v", err)
	}
}

func TestResourceObjectUsable(t *testing.T) {
	s := &Service{dataDir: t.TempDir()}
	missing := &model.Resource{Provider: "local", ObjectKey: "u/missing.png", MimeType: "image/png"}
	if s.resourceObjectUsable(missing) || s.resourceObjectUsable(nil) {
		t.Fatal("a missing local file or nil resource must be unusable")
	}
	if !s.resourceObjectUsable(&model.Resource{Provider: "oss", ObjectKey: "x.png", MimeType: "image/png"}) {
		t.Fatal("remote objects are checked on read, not here")
	}
}
