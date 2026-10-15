package app

import (
	"encoding/json"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

type productionBibleSection struct {
	Key   string `json:"key"`
	Name  string `json:"name"`
	Step  string `json:"step"`
	Scope string `json:"scope"`
}

var productionBibleSections = []productionBibleSection{
	{"settings", "世界观与规则", "assets.settings", "时代地域、世界规则、能力边界、组织和术语"},
	{"story_continuity", "人物关系与时间线", "assets.settings", "身份别名、人物关系、事件顺序、空间关系及不可变事实"},
	{"style", "全局视觉风格", "assets.style", "画风、色彩、光影、质感和视觉母题"},
	{"art_direction", "美术与服化道", "assets.style", "建筑、服装妆发、道具材质与标志符号的共用基准，不重复逐资产条目"},
	{"cinematography", "摄影与剪辑", "assets.style", "构图、景别、轴线、运动、节奏和转场，不编造镜头表"},
	{"performance", "表演与配音", "assets.style", "表演尺度、对白节奏、声线一致性、口音与情绪边界，具体声线仍放人物资产"},
	{"sound", "音乐与环境声音", "assets.style", "配乐母题、环境声层次、标志音效、声音空间和混音原则"},
	{"generation", "生成与一致性约束", "assets.style", "共用正负提示词、参考资产规则、跨集不变项与质量检查，不虚构模型参数或完成的媒体"},
}

func productionBibleSectionFor(key string) (productionBibleSection, bool) {
	for _, section := range productionBibleSections {
		if section.Key == key {
			return section, true
		}
	}
	return productionBibleSection{}, false
}

func productionBibleKeys(m productionManifest) []string {
	if m.Category != "bible" {
		return nil
	}
	if len(m.BibleSections) > 0 {
		return m.BibleSections
	}
	// Running jobs created before the split retain their original scope.
	return []string{"settings", "style"}
}

func productionBibleRequirements(m productionManifest) []productionBibleSection {
	sections := []productionBibleSection{}
	for _, key := range productionBibleKeys(m) {
		if section, ok := productionBibleSectionFor(key); ok {
			sections = append(sections, section)
		}
	}
	return sections
}

// An old worker may have created a two-section manifest for an explicitly
// scoped new container. Adopt only that declared scope after source validation.
func productionRestoreBibleScope(repo *repository.Repository, run *model.CloudAgentExecution, state *cloudAgentRuntime, job *model.ProductionAgentJob, m *productionManifest, doc map[string]any) error {
	if m.Category != "bible" || len(m.BibleSections) > 0 || (cloudAgentRunTerminal(run.Status) && run.Status != "failed") {
		return nil
	}
	frame := productionNode(doc, m.FrameID)
	data := productionWorkflow(frame)
	group, _ := data["assetGroup"].(map[string]any)
	if group["sections"] == nil {
		return nil
	}
	target := productionNode(doc, state.Request.Production.TargetNodeID)
	if frame["type"] != "frame" || data["step"] != "assets.bible" || data["pipelineId"] != productionWorkflow(target)["pipelineId"] || group["kind"] != "bible" || group["manifestId"] != target["id"] || target["parentId"] != m.FrameID {
		return BadAuthRequest("制作规范容器关联已变化，未改变任务范围")
	}
	sections := productionIDs(group["sections"])
	if len(sections) == 0 {
		return BadAuthRequest("制作规范分类清单为空或无效，未改变任务范围")
	}
	seen := map[string]bool{}
	for _, key := range sections {
		if _, ok := productionBibleSectionFor(key); !ok || seen[key] {
			return BadAuthRequest("制作规范分类清单包含未知或重复分类，未改变任务范围")
		}
		seen[key] = true
	}
	if !seen["settings"] || !seen["style"] {
		return BadAuthRequest("制作规范分类清单缺少原有设定或风格，未改变任务范围")
	}
	m.BibleSections = sections
	encoded, err := json.Marshal(m)
	if err != nil {
		return err
	}
	if err = repo.RestoreProductionAgentScope(run.UserID, run.ID, job.ManifestJSON, string(encoded)); err != nil {
		return err
	}
	job.ManifestJSON, job.Validated = string(encoded), false
	return nil
}
