package app

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestOfficialPriceCatalog(t *testing.T) {
	verified, profiles, err := officialPriceCatalog()
	if err != nil || verified != "2026-10-17" || len(profiles) < 20 {
		t.Fatalf("%s %d %v", verified, len(profiles), err)
	}
	domains := map[string]bool{"developers.openai.com": true, "docs.x.ai": true, "platform.claude.com": true, "ai.google.dev": true}
	for _, p := range profiles {
		source, err := url.Parse(p.SourceURL)
		if err != nil || !domains[source.Hostname()] {
			t.Fatalf("non official source: %s", p.SourceURL)
		}
		if p.ID == "grok-4.5" && p.CachedTokenPrice != .3 {
			t.Fatal("channel discount leaked into official pricing")
		}
		if p.ID == "gpt-6-sol:long" && (p.AutoMatch || p.InputTokenPrice != 4 || p.OutputTokenPrice != 15) {
			t.Fatal("long context profile wrong")
		}
		if p.ID == "gpt-image-2" && p.UnsupportedReason == "" {
			t.Fatal("multimodal image tokens treated as per image")
		}
	}
}

func TestPreviewOfficialPricingReadOnlyAndAliases(t *testing.T) {
	svc, db, admin := seedRepricingModels(t)
	// No channel URL is required: the catalog is manufacturer-sourced, never channel-sourced.
	if err := db.Model(&model.ChannelModelPriceTier{}).Where("id = ?", "tier-a").Updates(map[string]any{"provider_model_key": "gpt-6-sol", "cost_configured": false}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.ChannelModelPriceTier{}).Where("id = ?", "tier-b").Updates(map[string]any{"provider_model_key": "gpt-6-sol-long", "cost_configured": false}).Error; err != nil {
		t.Fatal(err)
	}
	result, err := svc.PreviewAdminDefaultPricing(context.Background(), admin, "channel", []string{"a", "b"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range result.Prices {
		if p.ModelID == "a" && (!p.Supported || p.InputTokenPrice != 2 || p.OutputTokenPrice != 10 || p.CachedTokenPrice != .2) {
			t.Fatalf("%+v", p)
		}
		if p.ModelID == "b" && (p.Supported || !strings.Contains(p.Reason, "别名")) {
			t.Fatalf("guessed alias: %+v", p)
		}
	}
	result, err = svc.PreviewAdminDefaultPricing(context.Background(), admin, "channel", []string{"b"}, map[string]string{"tier-b": "gpt-6-sol:long"})
	if err != nil || !result.Prices[0].Supported || result.Prices[0].InputTokenPrice != 4 || result.Prices[0].ProfileID != "gpt-6-sol:long" {
		t.Fatalf("%+v %v", result, err)
	}
	item, _ := svc.repo.ChannelModelByID("channel", "b")
	if item.PriceVersion != 1 || item.UnitPriceMicrocredits != 9 || item.PriceTiers[0].BillingMode != "fixed_request" {
		t.Fatal("preview wrote pricing")
	}
	for _, ids := range [][]string{nil, {"a", "a"}, {"a", "other"}} {
		if _, err := svc.PreviewAdminDefaultPricing(context.Background(), admin, "channel", ids, nil); err == nil {
			t.Fatal("invalid selection accepted")
		}
	}
	if _, err := svc.PreviewAdminDefaultPricing(context.Background(), &model.User{ID: "user"}, "channel", []string{"a"}, nil); err == nil {
		t.Fatal("non admin accepted")
	}
	for _, mapping := range []map[string]string{{"tier-b": "gpt-6-sol"}, {"tier-a": "unknown"}} {
		if _, err := svc.PreviewAdminDefaultPricing(context.Background(), admin, "channel", []string{"a"}, mapping); err == nil {
			t.Fatal("invalid mapping accepted")
		}
	}
	for _, mutation := range []map[string]any{{"cost_configured": true}, {"cost_configured": false, "selector_json": `{"quality":"high"}`}, {"selector_json": "{}", "provider_model_key": "gpt-image-2"}} {
		if err := db.Model(&model.ChannelModelPriceTier{}).Where("id = ?", "tier-a").Updates(mutation).Error; err != nil {
			t.Fatal(err)
		}
		result, err = svc.PreviewAdminDefaultPricing(context.Background(), admin, "channel", []string{"a"}, nil)
		if err != nil || result.Prices[0].Supported || result.Prices[0].Reason == "" {
			t.Fatalf("invalid import: %+v %v", result, err)
		}
	}
}

func TestRepriceRepairsMissingCostsAndInvalidSale(t *testing.T) {
	svc, db, admin := seedRepricingModels(t)
	if err := db.Model(&model.ChannelModelPriceTier{}).Where("id = ?", "tier-a").Updates(map[string]any{"cost_configured": false, "unit_price_microcredits": -1}).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := svc.RepriceAdminChannelModels(admin, "channel", []ChannelModelRepriceRequest{repricingRequest("a", 100)}); err != nil {
		t.Fatal(err)
	}
	item, _ := svc.repo.ChannelModelByID("channel", "a")
	if item.PriceTiers[0].CostPricing.Configured || item.PriceTiers[0].UnitPriceMicrocredits != 100 {
		t.Fatalf("%+v", item.PriceTiers[0])
	}
}

func TestRepriceExplicitUnitChangeAndCostGuard(t *testing.T) {
	for _, knownCost := range []bool{false, true} {
		t.Run(fmt.Sprint(knownCost), func(t *testing.T) {
			svc, db, admin := seedRepricingModels(t)
			if err := db.Model(&model.ChannelModelPriceTier{}).Where("id = ?", "tier-a").Update("cost_configured", knownCost).Error; err != nil {
				t.Fatal(err)
			}
			input, output, cached := int64(5_000_000), int64(40_000_000), int64(500_000)
			req := repricingRequest("a", 0)
			req.PriceTiers[0].BillingMode = "token"
			req.PriceTiers[0].Prices = map[string]*int64{"inputTokenPriceMicrocredits": &input, "outputTokenPriceMicrocredits": &output, "cachedTokenPriceMicrocredits": &cached}
			_, err := svc.RepriceAdminChannelModels(admin, "channel", []ChannelModelRepriceRequest{req})
			if knownCost {
				if err == nil {
					t.Fatal("reinterpreted cost")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			item, _ := svc.repo.ChannelModelByID("channel", "a")
			tier := item.PriceTiers[0]
			if item.BillingMode != "token" || tier.BillingMode != "token" || tier.InputTokenPriceMicrocredits != input || tier.OutputTokenPriceMicrocredits != output || tier.CachedTokenPriceMicrocredits != cached || tier.UnitPriceMicrocredits != 0 || tier.PriceVersion != 2 || tier.CostPricing.UnitPriceMicrocredits != 1_000_000 {
				t.Fatalf("%+v", tier)
			}
		})
	}
}
