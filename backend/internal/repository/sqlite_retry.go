package repository

import (
	"errors"
	"github.com/mattn/go-sqlite3"
)

// Only SQLite busy/locked errors guarantee that a failed transaction can be
// replayed locally. Never retry ambiguous network/commit failures this way.
func IsTransientSQLiteWrite(err error) bool {
	var sqliteErr sqlite3.Error
	return errors.As(err, &sqliteErr) && (sqliteErr.Code == sqlite3.ErrBusy || sqliteErr.Code == sqlite3.ErrLocked)
}
