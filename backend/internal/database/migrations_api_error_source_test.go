package database

import (
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestMigrateAPICallErrorSourceLeavesHistoricalFactsUntouched(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:api-error-source-v48?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	if err = db.Exec(`CREATE TABLE api_call_logs (id TEXT PRIMARY KEY, status TEXT, error_code TEXT, output_tokens INTEGER)`).Error; err != nil {
		t.Fatal(err)
	}
	if err = db.Exec(`INSERT INTO api_call_logs VALUES ('old','failed','output_limit_exceeded',16383)`).Error; err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		for _, item := range schemaMigrations {
			if item.version == 48 {
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
	if old.Status != model.ApiCallStatusFailed || old.ErrorCode != "output_limit_exceeded" || old.OutputTokens != 16383 || old.ErrorSource != "" {
		t.Fatalf("migration rewrote historical evidence: %+v", old)
	}
}
