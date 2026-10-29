package app

import (
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
)

func TestProductionProjectIdentityBatchAllocation(t *testing.T) {
	s, _, _ := productionFixture(t)
	const workers, count = 20, 20
	results := make(chan *productionAssetIdentity, workers*count)
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			identities, err := newProductionAssetIdentities(s.repo, "shared-canvas", "shared-drama", "character", count)
			if err != nil {
				t.Error(err)
				return
			}
			for _, identity := range identities {
				results <- identity
			}
		}()
	}
	wg.Wait()
	close(results)
	codes, ids := map[string]bool{}, map[string]bool{}
	for identity := range results {
		if codes[identity.Code] || ids[identity.ID] || !productionAssetBaseCode.MatchString(identity.Code) {
			t.Fatalf("duplicate or invalid identity: %+v", identity)
		}
		codes[identity.Code], ids[identity.ID] = true, true
		if _, err := uuid.Parse(strings.TrimPrefix(identity.ID, "asset-")); err != nil {
			t.Fatal("internal identity must retain UUID", err)
		}
		if !strings.HasPrefix(identity.Code, "CHR-D001-") || len(identity.Code) != len("CHR-D001-001") {
			t.Fatalf("display code is not short: %s", identity.Code)
		}
	}
	if len(codes) != workers*count {
		t.Fatalf("allocated %d identities", len(codes))
	}
}

func TestProductionAllAssetKindsShareProjectNamespace(t *testing.T) {
	s, _, _ := productionFixture(t)
	namespace := ""
	for kind, prefix := range productionAssetPrefixes {
		identity, err := newProductionAssetIdentity(s.repo, "shared-canvas", "shared-drama", kind)
		if err != nil {
			t.Fatal(err)
		}
		parts := strings.Split(identity.Code, "-")
		if len(parts) != 3 || parts[0] != prefix || (namespace != "" && parts[1] != namespace) {
			t.Fatalf("wrong project namespace: %+v", identity)
		}
		namespace = parts[1]
		variant, err := newProductionVariantCode(s.repo, identity.Code)
		if variant != identity.Code+"-V01" {
			t.Fatalf("state code is not short: %s", variant)
		}
		if err != nil || !storyboardAssetCode.MatchString(variant) || regexpStoryboardVariant.ReplaceAllString(variant, "") != identity.Code {
			t.Fatalf("variant lost owner: %q %v", variant, err)
		}
		if got := bodyAssetCode.FindString("引用 @" + variant + " 后续"); got != variant {
			t.Fatalf("body parser dropped code: %q", got)
		}
		if got := productionPlanReferencePattern.FindString("引用 @" + variant + " 后续"); got != "@"+variant {
			t.Fatalf("plan parser dropped code: %q", got)
		}
		m := productionManifest{Plan: &productionPlan{Assets: []productionPlanAsset{{Identity: identity}}}}
		if err := productionValidatePlanReferences(m, map[string]any{}, nil, "@"+identity.Code); err != nil {
			t.Fatal(err)
		}
		foreign, _ := newProductionAssetIdentity(s.repo, "shared-canvas", "other-drama", kind)
		if strings.Split(foreign.Code, "-")[1] == namespace {
			t.Fatal("dramas on the same canvas share a namespace")
		}
		if productionValidatePlanReferences(m, map[string]any{}, nil, "@"+foreign.Code) == nil {
			t.Fatal("foreign project reference accepted")
		}
	}
	if _, err := newProductionAssetIdentity(s.repo, "", "shared-drama", "character"); err == nil {
		t.Fatal("empty project accepted")
	}
	if _, err := newProductionAssetIdentity(s.repo, "shared-canvas", "shared-drama", "unknown"); err == nil {
		t.Fatal("unknown kind accepted")
	}
	for _, code := range []string{"", "CHR-invalid", "CHR-0001-V0001"} {
		if _, err := newProductionVariantCode(s.repo, code); err == nil {
			t.Fatalf("invalid parent accepted: %s", code)
		}
	}
}
