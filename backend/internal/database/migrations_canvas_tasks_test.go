package database

import (
	"infinite-canvas/backend/internal/model"
	"testing"
)

func TestMigrateSchemaV46PreservesExistingTasks(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:canvas-task-v46?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, user_id TEXT, status TEXT, input_json TEXT)`).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec(`INSERT INTO tasks (id,user_id,status,input_json) VALUES ('old','user','succeeded','{"metadata":{"nodeId":"body"}}')`).Error; err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := schemaMigrations[45].apply(db); err != nil {
			t.Fatal(err)
		}
	}
	var task model.Task
	if err := db.First(&task, "id = ?", "old").Error; err != nil {
		t.Fatal(err)
	}
	if task.Status != model.TaskStatusSucceeded || task.RemovedAt != nil || task.NodeBoundAt != nil || task.InputJSON != `{"metadata":{"nodeId":"body"}}` {
		t.Fatal("migration changed existing task")
	}
	if !db.Migrator().HasIndex(&model.Task{}, "idx_tasks_removed_at") {
		t.Fatal("removal index missing")
	}
}
