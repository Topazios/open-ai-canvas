package repository

import (
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type AnalyticsFilter struct {
	From       time.Time
	To         time.Time
	UserID     string
	Model      string
	ChannelID  string
	Capability string
}

type APICallLogFilter struct {
	AnalyticsFilter
	RecordType                 string
	Keyword                    string
	Status                     string
	IDs                        []string
	Page                       int
	Limit                      int
	historicalUpstreamErrorIDs []string
}

// A dispatched request and its terminal response share one audit row.
func (r *Repository) CompletePendingAPICallLog(item *model.ApiCallLog) (bool, error) {
	if item.ID == "" || item.Status == model.ApiCallStatusRunning {
		return false, nil
	}
	result := r.db.Model(&model.ApiCallLog{}).Where("id = ? AND status = ?", item.ID, model.ApiCallStatusRunning).Select("*").Updates(item)
	return result.RowsAffected > 0, result.Error
}

func (r *Repository) RecordUserActivity(userID string, event string, count int, now time.Time) error {
	if userID == "" {
		return nil
	}
	if count <= 0 {
		count = 1
	}
	day := time.Date(now.UTC().Year(), now.UTC().Month(), now.UTC().Day(), 0, 0, 0, 0, time.UTC)
	activity := model.UserDailyActivity{ID: userID + ":" + day.Format("2006-01-02"), Day: day, UserID: userID, CreatedAt: now, UpdatedAt: now}
	updates := map[string]any{"updated_at": now}
	switch event {
	case "login":
		activity.LoginCount = count
		updates["login_count"] = gorm.Expr("user_daily_activities.login_count + ?", count)
	case "task":
		activity.TaskCount = count
		updates["task_count"] = gorm.Expr("user_daily_activities.task_count + ?", count)
	case "agent_message":
		activity.AgentMessageCount = count
		updates["agent_message_count"] = gorm.Expr("user_daily_activities.agent_message_count + ?", count)
	case "canvas":
		activity.CanvasActive = true
		updates["canvas_active"] = true
	case "asset":
		activity.AssetCount = count
		updates["asset_count"] = gorm.Expr("user_daily_activities.asset_count + ?", count)
	case "resource":
		activity.ResourceCount = count
		updates["resource_count"] = gorm.Expr("user_daily_activities.resource_count + ?", count)
	default:
		return nil
	}
	if event != "login" {
		activity.FirstActiveAt = &now
		activity.LastActiveAt = &now
		updates["first_active_at"] = gorm.Expr("COALESCE(user_daily_activities.first_active_at, ?)", now)
		updates["last_active_at"] = now
	}
	return r.db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "day"}, {Name: "user_id"}},
		DoUpdates: clause.Assignments(updates),
	}).Create(&activity).Error
}

func (r *Repository) AnalyticsTasks(filter AnalyticsFilter) ([]model.Task, error) {
	var tasks []model.Task
	query := r.db.Select("id", "user_id", "type", "status", "operation", "provider", "model", "started_at", "completed_at", "created_at").Where("created_at >= ? AND created_at < ?", filter.From, filter.To)
	if filter.UserID != "" {
		query = query.Where("user_id = ?", filter.UserID)
	}
	if filter.Model != "" {
		query = query.Where("model = ?", filter.Model)
	}
	if filter.Capability != "" {
		if filter.Capability == "text" {
			query = query.Where("type LIKE ? OR type LIKE ? OR type LIKE ?", "%text%", "%storyboard%", "%agent%")
		} else {
			query = query.Where("type LIKE ?", "%"+filter.Capability+"%")
		}
	}
	return tasks, query.Find(&tasks).Error
}

func (r *Repository) AnalyticsAPICallLogs(filter AnalyticsFilter) ([]model.ApiCallLog, error) {
	var logs []model.ApiCallLog
	query := r.apiCallLogQuery(filter)
	err := query.Omit("RequestBody", "ResponseBody").Find(&logs).Error
	if err == nil {
		err = r.projectAPICallLogStatuses(logs, filter)
	}
	return logs, err
}

func (r *Repository) projectAPICallLogStatuses(logs []model.ApiCallLog, filter AnalyticsFilter) error {
	candidates := make([]string, 0)
	for _, log := range logs {
		if log.ErrorSource == "" && log.DisplayStatus() == model.ApiCallStatusWarning {
			candidates = append(candidates, log.ID)
		}
	}
	knownFailures := make(map[string]bool)
	if len(candidates) > 0 {
		ids, err := r.historicalAPICallProviderFailures(filter, candidates)
		if err != nil {
			return err
		}
		for _, id := range ids {
			knownFailures[id] = true
		}
	}
	for index := range logs {
		if knownFailures[logs[index].ID] {
			logs[index].Status = model.ApiCallStatusFailed
			logs[index].ErrorSource = "upstream"
		}
		logs[index].Status = logs[index].DisplayStatus()
	}
	return nil
}

// Only legacy warning candidates need retained bodies to disambiguate a
// provider error object using the same code as a local incomplete category.
func (r *Repository) historicalAPICallProviderFailures(filter AnalyticsFilter, ids []string) ([]string, error) {
	query := r.apiCallLogQuery(filter).Model(&model.ApiCallLog{}).
		Where("("+apiCallLogDisplayStatusSQL+") = ?", model.ApiCallStatusWarning).
		Where("COALESCE(api_call_logs.error_source, '') = ''")
	if ids != nil {
		query = query.Where("api_call_logs.id IN ?", ids)
	}
	result := make([]string, 0)
	var batch []model.ApiCallLog
	err := query.Select("api_call_logs.id", "api_call_logs.response_body").FindInBatches(&batch, 100, func(tx *gorm.DB, batchNumber int) error {
		for _, log := range batch {
			if model.APICallResponseHasExplicitFailure(log.ResponseBody) {
				result = append(result, log.ID)
			}
		}
		return nil
	}).Error
	return result, err
}

// Keep this predicate aligned with model.ApiCallLog.DisplayStatus. It uses
// stored structured facts only, so historical warnings participate in paging
// and export filters without rewriting their original audit receipts.
const apiCallLogDisplayStatusSQL = `CASE
 WHEN COALESCE(api_call_logs.error_source, '') NOT IN ('', 'content') THEN api_call_logs.status
 WHEN api_call_logs.status = 'running' OR COALESCE(api_call_logs.status_code, 0) < 200 OR api_call_logs.status_code >= 300 THEN api_call_logs.status
 WHEN COALESCE(api_call_logs.provider_status, '') IN ('failed', 'cancelled', 'canceled', 'expired') THEN 'failed'
 WHEN COALESCE(api_call_logs.error_code, '') IN ('output_limit_exceeded', 'upstream_response_invalid') THEN 'warning'
 WHEN api_call_logs.provider_status = 'incomplete' AND COALESCE(api_call_logs.error_code, '') = '' THEN 'warning'
 ELSE api_call_logs.status END`

func (r *Repository) AnalyticsActivities(filter AnalyticsFilter) ([]model.UserDailyActivity, error) {
	var activities []model.UserDailyActivity
	query := r.db.Where("day >= ? AND day < ?", filter.From, filter.To)
	if filter.UserID != "" {
		query = query.Where("user_id = ?", filter.UserID)
	}
	return activities, query.Find(&activities).Error
}

func (r *Repository) QueryAPICallLogs(filter APICallLogFilter) ([]model.ApiCallLog, int64, error) {
	if filter.Page <= 0 {
		filter.Page = 1
	}
	if filter.Limit <= 0 || filter.Limit > 200 {
		filter.Limit = 50
	}
	if filter.Status == string(model.ApiCallStatusWarning) || filter.Status == string(model.ApiCallStatusFailed) {
		ids, err := r.historicalAPICallProviderFailures(filter.AnalyticsFilter, nil)
		if err != nil {
			return nil, 0, err
		}
		filter.historicalUpstreamErrorIDs = ids
	}
	var total int64
	// GORM 会把 Distinct 状态保留在同一查询链；计数和分页必须分别构造，避免 PostgreSQL 的 DISTINCT + ORDER BY 冲突。
	if err := r.filteredAPICallLogQuery(filter).Model(&model.ApiCallLog{}).Distinct("api_call_logs.id").Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var logs []model.ApiCallLog
	err := r.filteredAPICallLogQuery(filter).Omit("RequestBody", "ResponseBody").Order("api_call_logs.created_at desc").Offset((filter.Page - 1) * filter.Limit).Limit(filter.Limit).Find(&logs).Error
	if err == nil {
		err = r.projectAPICallLogStatuses(logs, filter.AnalyticsFilter)
	}
	return logs, total, err
}

func (r *Repository) ExportAPICallLogs(filter APICallLogFilter, limit int) ([]model.ApiCallLog, error) {
	if limit <= 0 || limit > 10_000 {
		limit = 10_000
	}
	if filter.Status == string(model.ApiCallStatusWarning) || filter.Status == string(model.ApiCallStatusFailed) {
		ids, err := r.historicalAPICallProviderFailures(filter.AnalyticsFilter, nil)
		if err != nil {
			return nil, err
		}
		filter.historicalUpstreamErrorIDs = ids
	}
	query := r.filteredAPICallLogQuery(filter)
	if len(filter.IDs) > 0 {
		query = query.Where("api_call_logs.id IN ?", filter.IDs)
	}
	var logs []model.ApiCallLog
	err := query.Omit("RequestBody", "ResponseBody").Order("api_call_logs.created_at desc").Limit(limit).Find(&logs).Error
	if err == nil {
		err = r.projectAPICallLogStatuses(logs, filter.AnalyticsFilter)
	}
	return logs, err
}

func (r *Repository) filteredAPICallLogQuery(filter APICallLogFilter) *gorm.DB {
	query := r.apiCallLogQuery(filter.AnalyticsFilter)
	switch filter.RecordType {
	case "download":
		query = query.Where("api_call_logs.request_kind = ?", "download")
	case "all":
	default:
		query = visibleAPICallLogQuery(query).Where("COALESCE(api_call_logs.request_kind, '') NOT IN ?", []string{"download", "upload", "local_save", "register"})
	}
	if value := strings.TrimSpace(filter.Keyword); value != "" {
		pattern := "%" + strings.ToLower(value) + "%"
		query = query.
			Joins("LEFT JOIN users ON users.id = api_call_logs.user_id").
			Joins("LEFT JOIN model_channels ON model_channels.id = api_call_logs.channel_id").
			Where(
				"lower(api_call_logs.user_id) LIKE ? OR lower(users.username) LIKE ? OR lower(users.display_name) LIKE ? OR lower(api_call_logs.channel_id) LIKE ? OR lower(model_channels.name) LIKE ? OR lower(api_call_logs.model) LIKE ? OR lower(api_call_logs.path) LIKE ? OR lower(api_call_logs.provider_request_id) LIKE ? OR lower(api_call_logs.error_code) LIKE ? OR lower(api_call_logs.error) LIKE ?",
				pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern,
			)
	}
	if filter.Status != "" {
		if len(filter.historicalUpstreamErrorIDs) > 0 && filter.Status == string(model.ApiCallStatusWarning) {
			query = query.Where("("+apiCallLogDisplayStatusSQL+") = ? AND api_call_logs.id NOT IN ?", filter.Status, filter.historicalUpstreamErrorIDs)
		} else if len(filter.historicalUpstreamErrorIDs) > 0 && filter.Status == string(model.ApiCallStatusFailed) {
			query = query.Where("("+apiCallLogDisplayStatusSQL+") = ? OR api_call_logs.id IN ?", filter.Status, filter.historicalUpstreamErrorIDs)
		} else {
			query = query.Where("("+apiCallLogDisplayStatusSQL+") = ?", filter.Status)
		}
	}
	return query
}

func (r *Repository) APICallLogTasks(ids []string) ([]model.Task, error) {
	if len(ids) == 0 {
		return []model.Task{}, nil
	}
	var tasks []model.Task
	err := r.db.Select("id", "user_id", "type", "status", "result_json", "media_stage", "execution_diagnostic_json").Where("id IN ?", ids).Find(&tasks).Error
	return tasks, err
}

func (r *Repository) LatestProviderRequestIDForTask(taskID string) (string, error) {
	var log model.ApiCallLog
	err := r.db.Select("provider_request_id").
		Where("task_id = ? AND provider_request_id <> ''", taskID).
		Order("created_at desc").
		First(&log).Error
	return strings.TrimSpace(log.ProviderRequestID), err
}

// LatestProviderRequestIDsForTasks returns the newest upstream request ID per task.
// Task list queries intentionally select a narrow read model; this bulk lookup
// hydrates IDs recorded in API logs so the UI can hide cancellation after the
// upstream request has been accepted even when the task row was not updated yet.
func (r *Repository) LatestProviderRequestIDsForTasks(taskIDs []string) (map[string]string, error) {
	result := make(map[string]string, len(taskIDs))
	if len(taskIDs) == 0 {
		return result, nil
	}
	var logs []model.ApiCallLog
	err := r.db.Select("task_id", "provider_request_id", "created_at").
		Where("task_id IN ? AND provider_request_id <> ''", taskIDs).
		Order("created_at desc").
		Find(&logs).Error
	if err != nil {
		return nil, err
	}
	for _, log := range logs {
		taskID := strings.TrimSpace(log.TaskID)
		providerRequestID := strings.TrimSpace(log.ProviderRequestID)
		if taskID == "" || providerRequestID == "" {
			continue
		}
		if _, exists := result[taskID]; !exists {
			result[taskID] = providerRequestID
		}
	}
	return result, nil
}

// APICallLogUsageForTask 返回一次任务调用里上游上报的用量。
// 这是模型自己的分词器算出的计数，是上下文压力可以采信的权威锚点；
// 没有上报（usage_available=false 或输入为 0）时返回 false，调用方退回本地估算。
func (r *Repository) APICallLogUsageForTask(userID, taskID string) (model.ApiCallLog, bool, error) {
	if strings.TrimSpace(userID) == "" || strings.TrimSpace(taskID) == "" {
		return model.ApiCallLog{}, false, nil
	}
	var log model.ApiCallLog
	err := r.db.Where("user_id = ? AND task_id = ? AND capability = ? AND status = ? AND usage_available = ?", userID, taskID, "text", model.ApiCallStatusSucceeded, true).
		Order("created_at DESC").Limit(1).Find(&log).Error
	if err != nil {
		return model.ApiCallLog{}, false, err
	}
	if log.ID == "" || log.InputTokens <= 0 {
		return model.ApiCallLog{}, false, nil
	}
	return log, true, nil
}

// LatestAPICallStatusForTask 返回任务最近一次上游调用的 HTTP 状态码；
// 任务没收到任何上游响应（例如网络错误）时返回 0。
func (r *Repository) LatestAPICallStatusForTask(taskID string) (int, error) {
	log, err := r.LatestAPICallFailureForTask(taskID)
	return log.StatusCode, err
}

// LatestAPICallFailureForTask includes failures reported after HTTP headers,
// such as a Responses SSE error following HTTP 200. Polls remain excluded.
func (r *Repository) LatestAPICallFailureForTask(taskID string) (model.ApiCallLog, error) {
	if strings.TrimSpace(taskID) == "" {
		return model.ApiCallLog{}, nil
	}
	var log model.ApiCallLog
	err := r.db.Select("status_code", "error_code", "error").Where("task_id = ? AND request_kind <> ?", taskID, "poll").
		Order("created_at DESC").Limit(1).Find(&log).Error
	return log, err
}

func (r *Repository) HasAPICallLogForTask(taskID string) (bool, error) {
	if strings.TrimSpace(taskID) == "" {
		return false, nil
	}
	var count int64
	err := r.db.Model(&model.ApiCallLog{}).Where("task_id = ?", taskID).Count(&count).Error
	return count > 0, err
}

func visibleAPICallLogQuery(query *gorm.DB) *gorm.DB {
	// 轮询属于一次生成调用的内部状态查询，管理端不单独展示。
	return query.Where("api_call_logs.request_kind <> ?", "poll")
}

func (r *Repository) VideoAPICallRoot(log model.ApiCallLog) (*model.ApiCallLog, error) {
	var root model.ApiCallLog
	query := r.db.Where("capability = ? AND request_kind = ?", "video", "create")
	if log.TaskID != "" {
		query = query.Where("task_id = ?", log.TaskID)
	} else {
		query = query.Where("user_id = ? AND channel_id = ? AND provider_request_id = ?", log.UserID, log.ChannelID, log.ProviderRequestID)
	}
	if err := query.Order("created_at desc").First(&root).Error; err != nil {
		return nil, err
	}
	return &root, nil
}

func (r *Repository) apiCallLogQuery(filter AnalyticsFilter) *gorm.DB {
	query := r.db.Where("api_call_logs.created_at >= ? AND api_call_logs.created_at < ?", filter.From, filter.To)
	if r.db.Dialector.Name() == "sqlite" {
		// SQLite compares datetime TEXT lexically. Normalize offsets before comparing
		// UTC filters with records written in the server's local time zone.
		query = r.db.Where("julianday(api_call_logs.created_at) >= julianday(?) AND julianday(api_call_logs.created_at) < julianday(?)", filter.From.Format(time.RFC3339Nano), filter.To.Format(time.RFC3339Nano))
	}
	if filter.UserID != "" {
		query = query.Where("api_call_logs.user_id = ?", filter.UserID)
	}
	if filter.Model != "" {
		query = query.Where("api_call_logs.model = ?", filter.Model)
	}
	if filter.ChannelID != "" {
		query = query.Where("api_call_logs.channel_id = ?", filter.ChannelID)
	}
	if filter.Capability != "" {
		query = query.Where("api_call_logs.capability = ?", filter.Capability)
	}
	return query
}

func (r *Repository) ModelPricings() ([]model.ModelPricing, error) {
	var items []model.ModelPricing
	return items, r.db.Order("model asc, capability asc").Find(&items).Error
}

func (r *Repository) ModelPricing(channelID string, modelName string, capability string) (*model.ModelPricing, error) {
	var pricing model.ModelPricing
	query := r.db.Where("model = ? AND capability = ?", modelName, capability)
	if channelID != "" {
		query = query.Where("channel_id IN ?", []string{channelID, ""}).Order("channel_id desc")
	} else {
		query = query.Where("channel_id = ?", "")
	}
	if err := query.First(&pricing).Error; err != nil {
		return nil, err
	}
	return &pricing, nil
}

func (r *Repository) ModelPricingByID(id string) (*model.ModelPricing, error) {
	var pricing model.ModelPricing
	if err := r.db.First(&pricing, "id = ?", id).Error; err != nil {
		return nil, err
	}
	return &pricing, nil
}

func (r *Repository) DeleteModelPricing(id string) error {
	return r.db.Delete(&model.ModelPricing{}, "id = ?", id).Error
}

func (r *Repository) CurrentQueuedTaskCount() (int64, error) {
	var count int64
	err := r.db.Model(&model.Task{}).Where("status IN ?", []model.TaskStatus{model.TaskStatusQueued, model.TaskStatusRunning}).Count(&count).Error
	return count, err
}
