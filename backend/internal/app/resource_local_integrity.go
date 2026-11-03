package app

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"infinite-canvas/backend/internal/model"
)

func (s *Service) localResourcePath(resource *model.Resource) string {
	return filepath.Join(s.dataDir, "resources", filepath.FromSlash(resource.ObjectKey))
}

func resourceIsMedia(resource *model.Resource) bool {
	mime := strings.ToLower(resource.MimeType)
	return strings.HasPrefix(mime, "image/") || strings.HasPrefix(mime, "video/") || strings.HasPrefix(mime, "audio/")
}

// writeLocalResource 写入本地资源文件并核对落盘大小。
// 媒体文件落盘后为空时删除文件并报错，避免资源记录为就绪但内容是空白文件。
// 不比较声明大小：部分来源的声明大小只是估计值，写入中断本身会由拷贝返回错误。
func (s *Service) writeLocalResource(resource *model.Resource, body io.Reader) error {
	path := s.localResourcePath(resource)
	if err := writeLocalResourceObject(path, body); err != nil {
		return err
	}
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if info.Size() == 0 && resourceIsMedia(resource) {
		_ = os.Remove(path)
		return fmt.Errorf("资源文件写入后为空")
	}
	return nil
}

// resourceObjectUsable 判断就绪资源的本地文件是否真实存在且非空。
// 非本地存储无法在这里廉价核对，按可用处理，由读取路径报错。
func (s *Service) resourceObjectUsable(resource *model.Resource) bool {
	if resource == nil {
		return false
	}
	if resource.Provider != "local" {
		return true
	}
	info, err := os.Stat(s.localResourcePath(resource))
	if err != nil || info.IsDir() {
		return false
	}
	return info.Size() > 0 || !resourceIsMedia(resource)
}
