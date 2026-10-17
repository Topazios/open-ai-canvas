package database

import (
	"path/filepath"
	"testing"
)

func TestConfigurePoolSerializesSQLiteWrites(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: filepath.Join(t.TempDir(), "canvas.db")})
	if err != nil {
		t.Fatal(err)
	}
	if err := ConfigurePool(db); err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	defer sqlDB.Close()
	stats := sqlDB.Stats()
	if stats.MaxOpenConnections != 1 {
		t.Fatalf("SQLite max open connections = %d, want 1", stats.MaxOpenConnections)
	}
}
