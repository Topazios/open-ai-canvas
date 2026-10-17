package database

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"infinite-canvas/backend/internal/logging"

	"gorm.io/driver/postgres"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

type Config struct {
	Driver  string
	DSN     string
	DataDir string
}

func Open(config Config) (*gorm.DB, error) {
	driver := strings.ToLower(strings.TrimSpace(config.Driver))
	if driver == "" {
		driver = "sqlite"
	}
	switch driver {
	case "sqlite":
		dsn := strings.TrimSpace(config.DSN)
		if dsn == "" {
			if err := os.MkdirAll(config.DataDir, 0o755); err != nil {
				return nil, err
			}
			// SQLite can run model calls concurrently, but it still has one writer.
			// Keep one pooled connection so task progress, leases and terminal writes
			// queue behind each other instead of racing into SQLITE_BUSY/LOCKED.
			dsn = config.DataDir + "/open_ai_canvas.db?_busy_timeout=30000&_journal_mode=WAL&_foreign_keys=on&_synchronous=NORMAL"
		}
		return gorm.Open(sqlite.Open(dsn), &gorm.Config{Logger: logging.GormLogger()})
	case "postgres", "postgresql":
		dsn := strings.TrimSpace(config.DSN)
		if dsn == "" {
			return nil, errors.New("PostgreSQL 模式必须配置 DATABASE_URL")
		}
		return gorm.Open(postgres.Open(dsn), &gorm.Config{Logger: logging.GormLogger()})
	default:
		return nil, fmt.Errorf("不支持的数据库驱动：%s", driver)
	}
}

func ConfigurePool(db *gorm.DB) error {
	sqlDB, err := db.DB()
	if err != nil {
		return err
	}
	if db.Dialector.Name() == "postgres" {
		sqlDB.SetMaxOpenConns(30)
		sqlDB.SetMaxIdleConns(10)
		return nil
	}
	// Do not confuse database connection concurrency with task concurrency. The
	// worker still runs model calls according to the runtime policy; SQLite writes
	// are serialized here to keep a local generation queue reliable.
	sqlDB.SetMaxOpenConns(1)
	sqlDB.SetMaxIdleConns(1)
	return nil
}
