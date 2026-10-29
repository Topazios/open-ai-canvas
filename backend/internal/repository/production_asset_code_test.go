package repository

import (
	"errors"
	"math"
	"path/filepath"
	"sync"
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"infinite-canvas/backend/internal/model"
)

func productionCodeTestDatabase(t *testing.T, path string) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(path+"?_busy_timeout=10000&_journal_mode=WAL"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	pool, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	pool.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = pool.Close() })
	if err := db.AutoMigrate(&model.IDSequence{}); err != nil {
		t.Fatal(err)
	}
	return db
}

func TestProductionCodeParallelRangesPersistAcrossConnections(t *testing.T) {
	path := filepath.Join(t.TempDir(), "codes.db")
	repos := []*Repository{New(productionCodeTestDatabase(t, path)), New(productionCodeTestDatabase(t, path))}
	const workers, batch = 24, 10
	starts := make(chan int64, workers)
	namespaces := make(chan string, workers)
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(repo *Repository) {
			defer wg.Done()
			code, err := repo.ProductionDramaCode("shared-drama")
			if err != nil {
				t.Error(err)
				return
			}
			namespaces <- code
			first, err := repo.ReserveProductionCodeRange("asset:"+code+":character", batch)
			if err != nil {
				t.Error(err)
				return
			}
			starts <- first
		}(repos[i%len(repos)])
	}
	wg.Wait()
	close(starts)
	close(namespaces)
	for code := range namespaces {
		if code != "D001" {
			t.Fatalf("namespace changed across connections: %s", code)
		}
	}
	seen := map[int64]bool{}
	for first := range starts {
		for number := first; number < first+batch; number++ {
			if seen[number] {
				t.Fatalf("overlapping range at %d", number)
			}
			seen[number] = true
		}
	}
	if len(seen) != workers*batch {
		t.Fatalf("allocated %d codes", len(seen))
	}
	reopened := New(productionCodeTestDatabase(t, path))
	if code, err := reopened.ProductionDramaCode("shared-drama"); err != nil || code != "D001" {
		t.Fatalf("lost namespace: %s %v", code, err)
	}
	if first, err := reopened.ReserveProductionCodeRange("asset:D001:character", 1); err != nil || first != workers*batch+1 {
		t.Fatalf("lost sequence after reopening: %d %v", first, err)
	}
	if code, err := reopened.ProductionDramaCode("other-drama"); err != nil || code != "D002" {
		t.Fatalf("different drama reused namespace: %s %v", code, err)
	}
	if first, err := reopened.ReserveProductionCodeRange("asset:D001:environment", 1); err != nil || first != 1 {
		t.Fatalf("asset kinds must count independently: %d %v", first, err)
	}
}

func TestProductionCodeValidationOverflowAndRollback(t *testing.T) {
	db := productionCodeTestDatabase(t, filepath.Join(t.TempDir(), "codes.db"))
	repo := New(db)
	if _, err := repo.ProductionDramaCode(" "); err == nil {
		t.Fatal("empty drama accepted")
	}
	if _, err := repo.ReserveProductionCodeRange("", 1); err == nil {
		t.Fatal("empty range accepted")
	}
	for _, count := range []int64{0, -1} {
		if _, err := repo.ReserveProductionCodeRange("invalid", count); err == nil {
			t.Fatal("invalid count accepted")
		}
	}
	if first, err := repo.ReserveProductionCodeRange("large", math.MaxInt64); err != nil || first != 1 {
		t.Fatalf("initial large range failed: %d %v", first, err)
	}
	if _, err := repo.ReserveProductionCodeRange("large", 1); err == nil {
		t.Fatal("overflow accepted")
	}
	errRollback := errors.New("rollback")
	err := db.Transaction(func(tx *gorm.DB) error {
		repo := New(tx)
		if _, err := repo.ProductionDramaCode("rolled-back"); err != nil {
			return err
		}
		if _, err := repo.ReserveProductionCodeRange("rolled-back", 5); err != nil {
			return err
		}
		return errRollback
	})
	if !errors.Is(err, errRollback) {
		t.Fatal(err)
	}
	if code, err := repo.ProductionDramaCode("rolled-back"); err != nil || code != "D001" {
		t.Fatalf("rolled back mapping retained: %s %v", code, err)
	}
	if first, err := repo.ReserveProductionCodeRange("rolled-back", 1); err != nil || first != 1 {
		t.Fatalf("rolled back range retained: %d %v", first, err)
	}
}
