package repository

import (
	"fmt"
	"strings"
	"unicode/utf8"

	"infinite-canvas/backend/internal/model"
)

const defaultCompactedAPICallBodyBytes = 32 << 10

// CompactAPICallLogBodies bounds only diagnostic request/response bodies.
// Provider IDs, statuses, usage, billing links and error fields stay intact.
func (r *Repository) CompactAPICallLogBodies(limitBytes, batchSize int) (int, error) {
	if limitBytes <= 0 {
		limitBytes = defaultCompactedAPICallBodyBytes
	}
	if batchSize <= 0 {
		batchSize = 100
	}
	var logs []model.ApiCallLog
	if err := r.db.
		Where("status IN ?", []model.ApiCallStatus{model.ApiCallStatusSucceeded, model.ApiCallStatusFailed}).
		Where("length(COALESCE(request_body, '')) > ? OR length(COALESCE(response_body, '')) > ?", limitBytes, limitBytes).
		Order("created_at asc").Limit(batchSize).Find(&logs).Error; err != nil {
		return 0, err
	}
	updated := 0
	for _, log := range logs {
		requestBody := compactAPICallLogBody(log.RequestBody, limitBytes)
		responseBody := compactAPICallLogBody(log.ResponseBody, limitBytes)
		if requestBody == log.RequestBody && responseBody == log.ResponseBody {
			continue
		}
		if err := r.db.Model(&model.ApiCallLog{}).Where("id = ?", log.ID).Updates(map[string]any{
			"request_body":  requestBody,
			"response_body": responseBody,
		}).Error; err != nil {
			return updated, err
		}
		updated++
	}
	return updated, nil
}

func compactAPICallLogBody(value string, limitBytes int) string {
	if len(value) <= limitBytes {
		return value
	}
	marker := fmt.Sprintf("\n[历史报文已压缩，原始长度 %d 字节]", len(value))
	keep := limitBytes - len(marker)
	if keep <= 0 {
		return marker
	}
	if keep > len(value) {
		keep = len(value)
	}
	for keep > 0 && !utf8.ValidString(value[:keep]) {
		keep--
	}
	return strings.TrimSuffix(value[:keep], "\x00") + marker
}
