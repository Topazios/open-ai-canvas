package app

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/google/uuid"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

// Manual edits share the durable per-asset state counter with Agent states.
func (s *Service) ReserveProductionVariantCode(userID, canvasID, nodeID string) (string, error) {
	var code string
	err := s.repo.ProductionAgentTransaction(func(repo *repository.Repository) error {
		canvas, err := repo.CanvasProjectForUser(userID, canvasID)
		if err != nil {
			return err
		}
		doc, err := creationDocument(canvas.PayloadJSON)
		if err != nil {
			return err
		}
		node := productionNode(doc, nodeID)
		if node == nil || stringValue(node["type"]) != "text" {
			return BadAuthRequest("请选择已保存的独立资产文稿")
		}
		encoded, _ := json.Marshal(productionWorkflow(node)["assetIdentity"])
		var identity productionAssetIdentity
		if json.Unmarshal(encoded, &identity) != nil || identity.ID == "" || identity.Code == "" || productionAssetPrefixes[identity.Kind] == "" {
			return BadAuthRequest("资产缺少系统身份编码，请先保存制作方案")
		}
		code, err = newProductionVariantCode(repo, identity.Code)
		return err
	})
	return code, err
}

type productionAssetIdentity struct {
	ID   string `json:"id"`
	Code string `json:"code"`
	Kind string `json:"kind"`
}

var productionAssetPrefixes = map[string]string{"character": "CHR", "environment": "SCN", "prop": "PRP", "special": "SPC", "sound": "AUD"}
var productionAssetBaseCode = regexp.MustCompile(`^` + model.ProductionAssetCodePattern + `$`)

const productionAssetIdentityPolicy = `资产编号与内部身份分开：内部 ID 用于数据关联，展示与提示词使用系统返回的短编号，格式为类别-剧码-顺序号（如 CHR-D001-001），状态为所属资产编号-V状态号（如 CHR-D001-001-V01）。每剧各类资产独立顺序编号，系统批量原子预留防止多人并发重号，不扫描资产库或查询全库最大号。模型只提交稳定 key，完整复用 identity.code，不自行编造、截短或重排编号。相同资产的重试、修订和新版本沿用原身份，新资产与状态才分配新号。已有编号原样引用，不主动改写。关系、集号、场号和镜号只用于所属剧及集内排列。`

func newProductionAssetIdentities(repo *repository.Repository, canvasID, pipelineID, kind string, count int) ([]*productionAssetIdentity, error) {
	if strings.TrimSpace(canvasID) == "" {
		return nil, BadAuthRequest("资产编码需要所属项目")
	}
	prefix := productionAssetPrefixes[kind]
	if prefix == "" || count < 1 {
		return nil, BadAuthRequest("资产类别或数量无效")
	}
	drama, err := repo.ProductionDramaCode(productionHash([]string{canvasID, pipelineID}))
	if err != nil {
		return nil, err
	}
	first, err := repo.ReserveProductionCodeRange("asset:"+drama+":"+kind, int64(count))
	if err != nil {
		return nil, err
	}
	identities := make([]*productionAssetIdentity, 0, count)
	for i := 0; i < count; i++ {
		token, err := uuid.NewRandom()
		if err != nil {
			return nil, err
		}
		identities = append(identities, &productionAssetIdentity{ID: "asset-" + token.String(), Code: fmt.Sprintf("%s-%s-%03d", prefix, drama, first+int64(i)), Kind: kind})
	}
	return identities, nil
}

func newProductionAssetIdentity(repo *repository.Repository, canvasID, pipelineID, kind string) (*productionAssetIdentity, error) {
	identities, err := newProductionAssetIdentities(repo, canvasID, pipelineID, kind, 1)
	if err != nil {
		return nil, err
	}
	return identities[0], nil
}

func newProductionVariantCode(repo *repository.Repository, assetCode string) (string, error) {
	codes, err := newProductionVariantCodes(repo, assetCode, 1)
	if err != nil {
		return "", err
	}
	return codes[0], nil
}

func newProductionVariantCodes(repo *repository.Repository, assetCode string, count int) ([]string, error) {
	if !productionAssetBaseCode.MatchString(assetCode) || count < 1 {
		return nil, BadAuthRequest("状态编码需要有效的资产身份编码和数量")
	}
	first, err := repo.ReserveProductionCodeRange("variant:"+assetCode, int64(count))
	if err != nil {
		return nil, err
	}
	codes := make([]string, count)
	for i := range codes {
		codes[i] = fmt.Sprintf("%s-V%02d", assetCode, first+int64(i))
	}
	return codes, nil
}

// Only resolve explicitly declared sources. A similarly named asset elsewhere
// in the canvas must not silently enter this version's prompt or identity.
func productionSourceAsset(m productionManifest, doc map[string]any, key string) *productionAssetIdentity {
	for _, source := range m.Sources {
		wd := productionWorkflow(productionNode(doc, source.NodeID))
		value, _ := wd["assetIdentity"].(map[string]any)
		if value != nil && (value["code"] == strings.TrimPrefix(key, "@") || wd["assetKey"] == key) {
			return &productionAssetIdentity{ID: stringValue(value["id"]), Code: stringValue(value["code"]), Kind: stringValue(value["kind"])}
		}
	}
	return nil
}

func productionCategoryKind(category string) string {
	return map[string]string{"characters": "character", "environments": "environment", "props": "prop", "special": "special", "voices": "sound"}[category]
}

func productionAssetFact(m productionManifest, kind string) bool {
	return m.Category == "bible" || (m.Category == "reconcile" && productionAssetPrefixes[kind] != "") || kind == productionCategoryKind(m.Category)
}
