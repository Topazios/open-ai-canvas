package database

import (
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestMigrateReasoningTokensPreservesUnknownAndExplicitZero(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:reasoning-usage-v47?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	if err = db.Exec(`CREATE TABLE api_call_logs (id TEXT PRIMARY KEY, output_tokens INTEGER)`).Error; err != nil {
		t.Fatal(err)
	}
	if err = db.Exec(`INSERT INTO api_call_logs(id,output_tokens) VALUES ('old',10)`).Error; err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		for _, item := range schemaMigrations {
			if item.version == 47 {
				if err = item.apply(db); err != nil {
					t.Fatal(err)
				}
			}
		}
	}
	var old model.ApiCallLog
	if err = db.First(&old, "id = ?", "old").Error; err != nil {
		t.Fatal(err)
	}
	if old.OutputTokens != 10 || old.ReasoningTokens != nil {
		t.Fatalf("rewrote historical usage: %+v", old)
	}
	if err = db.Exec(`INSERT INTO api_call_logs(id,output_tokens,reasoning_tokens) VALUES ('zero',10,0)`).Error; err != nil {
		t.Fatal(err)
	}
	var zero model.ApiCallLog
	if err = db.First(&zero, "id = ?", "zero").Error; err != nil {
		t.Fatal(err)
	}
	if zero.ReasoningTokens == nil || *zero.ReasoningTokens != 0 {
		t.Fatal("explicit zero became unknown")
	}
}
