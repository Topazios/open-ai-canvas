package app

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"
)

//go:embed model_official_prices.json
var officialPricesJSON []byte

type OfficialPriceProfile struct {
	ID                string  `json:"id"`
	ModelKey          string  `json:"modelKey"`
	Label             string  `json:"label"`
	Capability        string  `json:"capability"`
	BillingMode       string  `json:"billingMode"`
	UnitPrice         float64 `json:"unitPrice"`
	InputTokenPrice   float64 `json:"inputTokenPrice"`
	OutputTokenPrice  float64 `json:"outputTokenPrice"`
	CachedTokenPrice  float64 `json:"cachedTokenPrice"`
	SourceURL         string  `json:"sourceUrl"`
	Note              string  `json:"note"`
	UnsupportedReason string  `json:"unsupportedReason,omitempty"`
	AutoMatch         bool    `json:"autoMatch"`
}

type ModelDefaultPrice struct {
	ModelID          string  `json:"modelId"`
	TierID           string  `json:"tierId"`
	UpstreamModel    string  `json:"upstreamModel"`
	ProfileID        string  `json:"profileId,omitempty"`
	Supported        bool    `json:"supported"`
	Reason           string  `json:"reason,omitempty"`
	BillingMode      string  `json:"billingMode,omitempty"`
	UnitPrice        float64 `json:"unitPrice"`
	InputTokenPrice  float64 `json:"inputTokenPrice"`
	OutputTokenPrice float64 `json:"outputTokenPrice"`
	CachedTokenPrice float64 `json:"cachedTokenPrice"`
	SourceURL        string  `json:"sourceUrl,omitempty"`
	Note             string  `json:"note,omitempty"`
}

type ModelDefaultPricing struct {
	Currency   string                 `json:"currency"`
	Source     string                 `json:"source"`
	VerifiedAt string                 `json:"verifiedAt"`
	FetchedAt  time.Time              `json:"fetchedAt"`
	Profiles   []OfficialPriceProfile `json:"profiles"`
	Prices     []ModelDefaultPrice    `json:"prices"`
}

func officialPriceCatalog() (string, []OfficialPriceProfile, error) {
	var catalog struct {
		VerifiedAt string                 `json:"verifiedAt"`
		Profiles   []OfficialPriceProfile `json:"profiles"`
	}
	if err := json.Unmarshal(officialPricesJSON, &catalog); err != nil {
		return "", nil, err
	}
	if _, err := time.Parse("2006-01-02", catalog.VerifiedAt); err != nil {
		return "", nil, err
	}
	ids := make(map[string]bool)
	autoModels := make(map[string]bool)
	for _, profile := range catalog.Profiles {
		if profile.ID == "" || ids[profile.ID] || profile.ModelKey == "" || !strings.HasPrefix(profile.SourceURL, "https://") || profile.Note == "" {
			return "", nil, fmt.Errorf("invalid official price profile %q", profile.ID)
		}
		ids[profile.ID] = true
		if profile.AutoMatch {
			if autoModels[profile.ModelKey] {
				return "", nil, fmt.Errorf("ambiguous official model %q", profile.ModelKey)
			}
			autoModels[profile.ModelKey] = true
		}
		for _, value := range []float64{profile.UnitPrice, profile.InputTokenPrice, profile.OutputTokenPrice, profile.CachedTokenPrice} {
			if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || value > 1e6 {
				return "", nil, fmt.Errorf("invalid official amount %q", profile.ID)
			}
		}
		if profile.UnsupportedReason == "" && profile.BillingMode != "token" && profile.BillingMode != "fixed_request" && profile.BillingMode != "per_second" {
			return "", nil, fmt.Errorf("invalid official unit %q", profile.ID)
		}
	}
	return catalog.VerifiedAt, catalog.Profiles, nil
}

// Only verified manufacturer snapshots are read; channel prices and credentials are not consulted.
func (s *Service) PreviewAdminDefaultPricing(ctx context.Context, actor *model.User, channelID string, ids []string, mappings map[string]string) (*ModelDefaultPricing, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if len(ids) == 0 || len(ids) > 100 {
		return nil, BadAuthRequest("请选择 1 到 100 个模型")
	}
	if _, err := s.adminSystemChannel(channelID); err != nil {
		return nil, err
	}
	items, err := s.repo.ChannelModels(channelID, true)
	if err != nil {
		return nil, err
	}
	selected := make(map[string]bool, len(ids))
	for _, id := range ids {
		if id == "" || selected[id] {
			return nil, BadAuthRequest("模型不能为空或重复")
		}
		selected[id] = true
	}
	var chosen []model.ChannelModel
	tierOwners := make(map[string]bool)
	for _, item := range items {
		if selected[item.ID] {
			chosen = append(chosen, item)
			for _, tier := range item.PriceTiers {
				tierOwners[tier.ID] = true
			}
		}
	}
	if len(chosen) != len(ids) {
		return nil, BadAuthRequest("模型已删除或不属于当前渠道")
	}
	verifiedAt, profiles, err := officialPriceCatalog()
	if err != nil {
		return nil, err
	}
	byID, byModel := make(map[string]OfficialPriceProfile), make(map[string]OfficialPriceProfile)
	for _, profile := range profiles {
		byID[profile.ID] = profile
		if profile.AutoMatch {
			byModel[profile.ModelKey] = profile
		}
	}
	for tierID, profileID := range mappings {
		if !tierOwners[tierID] {
			return nil, BadAuthRequest("官方价格映射包含不属于所选模型的规格")
		}
		if _, ok := byID[profileID]; profileID != "" && !ok {
			return nil, BadAuthRequest("官方价格档位不存在，请刷新")
		}
	}
	result := &ModelDefaultPricing{Currency: "USD", Source: "厂商官方公开价快照", VerifiedAt: verifiedAt, FetchedAt: time.Now(), Profiles: profiles, Prices: []ModelDefaultPrice{}}
	for _, item := range chosen {
		for _, tier := range item.PriceTiers {
			key := strings.TrimPrefix(strings.TrimSpace(firstNonEmpty(tier.ProviderModelKey, item.ProviderModelKey, item.ModelKey)), "models/")
			entry := ModelDefaultPrice{ModelID: item.ID, TierID: tier.ID, UpstreamModel: key}
			profile, exists := byModel[key]
			if profileID := mappings[tier.ID]; profileID != "" {
				profile, exists = byID[profileID]
			}
			if !exists {
				entry.Reason = "未匹配官方模型；渠道别名请手动选择官方模型/档位，或保留原价"
			} else {
				entry.ProfileID, entry.SourceURL, entry.Note = profile.ID, profile.SourceURL, profile.Note
				switch {
				case profile.Capability != item.Capability:
					entry.Reason = "官方模型类型与当前模型不一致"
				case profile.UnsupportedReason != "":
					entry.Reason = profile.UnsupportedReason
				case len(skuSelectorForTier(tier)) != 0:
					entry.Reason = "该规格不能用通用官方基准价替代，请手动核对规格定价"
				default:
					entry.BillingMode = profile.BillingMode
					entry.UnitPrice, entry.InputTokenPrice, entry.OutputTokenPrice, entry.CachedTokenPrice = profile.UnitPrice, profile.InputTokenPrice, profile.OutputTokenPrice, profile.CachedTokenPrice
					entry.Supported = true
					cost := tier.CostPricing
					if entry.BillingMode != tier.BillingMode && cost.Configured && (cost.UnitPriceMicrocredits != 0 || cost.InputTokenPriceMicrocredits != 0 || cost.OutputTokenPriceMicrocredits != 0 || cost.CachedTokenPriceMicrocredits != 0) {
						entry.Supported = false
						entry.Reason = "计费单位与现有成本不同，请在模型编辑中同步调整"
					}
				}
			}
			result.Prices = append(result.Prices, entry)
		}
	}
	return result, nil
}
