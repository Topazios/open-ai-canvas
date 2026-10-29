package database

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func TestConfigurePoolAllowsReadsAlongsideBusyConnection(t *testing.T) {
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
	if stats.MaxOpenConnections < 2 {
		t.Fatalf("SQLite max open connections = %d, want at least 2", stats.MaxOpenConnections)
	}

	busyConn, err := sqlDB.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer busyConn.Close()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := db.WithContext(ctx).Exec("SELECT 1").Error; err != nil {
		t.Fatalf("read was blocked by another checked-out connection: %v", err)
	}
}
