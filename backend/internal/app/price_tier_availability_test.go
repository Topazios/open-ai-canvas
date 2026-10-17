package app

import (
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestLegacyTierSwitchesDoNotGateCatalogRoutingOrBilling(t *testing.T) {
	svc, db, _ := seedRepricingModels(t)
	if err := db.AutoMigrate(&model.SystemSetting{}); err != nil {
		t.Fatal(err)
	}
	config := mustEncodeModelCapabilityConfig(t, DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceChatCompletion), "a"))
	if err := db.Model(&model.ChannelModel{}).Where("id = ?", "a").Updates(map[string]any{"capability_config_json": config, "price_configured": false}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.ChannelModelPriceTier{}).Where("id = ?", "tier-a").Updates(map[string]any{"enabled": false, "price_configured": false}).Error; err != nil {
		t.Fatal(err)
	}
	cm, err := svc.repo.ChannelModelByKey("channel", "a")
	if err != nil {
		t.Fatal(err)
	}
	public, err := svc.sanitizeChannelModel(cm)
	if err != nil || !public.Available || len(public.PriceTiers) != 1 || !HasValidPrice(cm) || !channelModelHasActivePriceTier(*cm) {
		t.Fatalf("valid legacy tier unavailable: public=%+v err=%v", public, err)
	}
	matched := channelModelPriceTierForIntent(*cm, ModelRequestIntent{Capability: "text"})
	if matched == nil || matched.ID != "tier-a" || matched.UnitPriceMicrocredits != 9 {
		t.Fatalf("incorrect price match: %+v", matched)
	}
	order, err := svc.newBillingOrderWithPriceTier("user", "task", "request", "channel", "a", "text", "test", 1, tokenBillingEstimate{}, "tier-a")
	if err != nil || order.AmountMicrocredits != 9 || order.UnitPriceMicrocredits != 9 || order.PriceTierID != "tier-a" {
		t.Fatalf("billing amount changed: order=%+v err=%v", order, err)
	}
	if err := db.Model(&model.ChannelModel{}).Where("id = ?", "a").Update("enabled", false).Error; err != nil {
		t.Fatal(err)
	}
	catalog, err := svc.publicSystemChannelCatalog(nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, channel := range catalog {
		for _, item := range channel.Models {
			if item.ID == "a" {
				t.Fatal("disabled model is still visible")
			}
		}
	}
	if _, err := svc.newBillingOrderWithPriceTier("user", "task", "request", "channel", "a", "text", "test", 1, tokenBillingEstimate{}, "tier-a"); err == nil {
		t.Fatal("disabled model accepted a new order")
	}
}

func TestTierMatchingIgnoresSwitchesButRejectsInvalidPrices(t *testing.T) {
	cm := model.ChannelModel{Capability: "image", Protocol: model.ChannelInterfaceOpenAIImage, PriceTiers: []model.ChannelModelPriceTier{
		{ID: "fallback", BillingMode: "fixed_request", UnitPriceMicrocredits: 3},
		{ID: "specific", BillingMode: "fixed_request", UnitPriceMicrocredits: 7, SelectorJSON: `{"quality":"2k"}`},
	}}
	intent := ModelRequestIntent{Capability: "image", Options: map[string]any{"quality": "2k"}}
	if tier := channelModelPriceTierForIntent(cm, intent); tier == nil || tier.ID != "specific" || tier.UnitPriceMicrocredits != 7 {
		t.Fatalf("specific legacy tier did not win: %+v", tier)
	}
	cm.PriceTiers[1].UnitPriceMicrocredits = -1
	if tier := channelModelPriceTierForBilling(cm, "specific", "image"); tier != nil {
		t.Fatal("invalid pinned price accepted")
	}
	cm.PriceTiers[0].BillingMode = ""
	if HasValidPrice(&cm) || channelModelHasActivePriceTier(cm) || channelModelPriceTierForIntent(cm, intent) != nil {
		t.Fatal("invalid prices must not silently become free")
	}
	cm.PriceTiers[0].BillingMode = "fixed_request"
	cm.PriceTiers[0].UnitPriceMicrocredits = 0
	if !HasValidPrice(&cm) {
		t.Fatal("explicit free price rejected")
	}
}

func TestSavingLegacyTierSwitchesPreservesModelSwitchAndPrices(t *testing.T) {
	svc, db, admin := seedRepricingModels(t)
	off := false
	request := ChannelModelRequest{
		ModelKey: "a", Capability: "text", Protocol: string(model.ChannelInterfaceChatCompletion), Enabled: &off,
		CapabilityConfig: DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceChatCompletion), "a"),
		PriceTiers:       []ChannelModelPriceTierRequest{{BillingMode: "fixed_request", UnitPriceMicrocredits: 123, Enabled: &off, PriceConfigured: false}},
	}
	saved, err := svc.SaveAdminChannelModel(admin, "channel", "a", request)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Enabled || !saved.PriceConfigured || len(saved.PriceTiers) != 1 {
		t.Fatalf("model switch or pricing changed: %+v", saved)
	}
	var tier model.ChannelModelPriceTier
	if err := db.First(&tier, "channel_model_id = ?", "a").Error; err != nil {
		t.Fatal(err)
	}
	if !tier.Enabled || !tier.PriceConfigured || tier.UnitPriceMicrocredits != 123 {
		t.Fatalf("legacy tier flags survived save: %+v", tier)
	}
}
