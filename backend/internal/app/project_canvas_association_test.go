package app

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
)

func associationFixture(t *testing.T) (*Service, *gorm.DB, model.Project, model.ProjectUnit, model.CanvasProject) {
	t.Helper()
	service, db := newProjectWorkflowV2TestService(t)
	if err := db.AutoMigrate(&model.CanvasUnitLink{}, &model.CanvasNodeShotLink{}, &model.CanvasSnapshot{}, &model.CanvasSnapshotResource{}); err != nil {
		t.Fatal(err)
	}
	project, unit := seedWorkflowProject(t, db)
	canvas := model.CanvasProject{ID: "association-canvas", UserID: "user-1", Revision: 4, Title: "Existing canvas", PayloadJSON: `{"id":"association-canvas","nodes":[{"id":"original","content":"Draft","position":{"x":13,"y":25}}],"connections":[{"id":"edge"}],"timeline":{"clips":[{"id":"manual"}]},"unknown":{"integer":9007199254740993},"viewport":{"x":5,"k":0.5}}`, CreatedAt: time.Now(), UpdatedAt: time.Now()}
	if err := db.Create(&canvas).Error; err != nil {
		t.Fatal(err)
	}
	return service, db, project, unit, canvas
}

func TestCanvasAssociationPreservesDocumentAndRetryIdentity(t *testing.T) {
	service, db, project, unit, canvas := associationFixture(t)
	request := LinkCanvasUnitRequest{CanvasID: canvas.ID, UnitID: unit.ID, ExpectedCanvasRevision: &canvas.Revision}
	link, err := service.LinkCanvasUnit("user-1", project.ID, request)
	if err != nil {
		t.Fatal(err)
	}
	var saved model.CanvasProject
	if err := db.First(&saved, "id = ?", canvas.ID).Error; err != nil {
		t.Fatal(err)
	}
	if saved.ProjectID != project.ID || saved.Revision != canvas.Revision+1 {
		t.Fatalf("unexpected association: %+v", saved)
	}
	var before, after map[string]json.RawMessage
	if err := json.Unmarshal([]byte(canvas.PayloadJSON), &before); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(saved.PayloadJSON), &after); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"nodes", "connections", "timeline", "unknown", "viewport"} {
		if !reflect.DeepEqual(before[key], after[key]) {
			t.Fatalf("rewrote %s", key)
		}
	}
	if string(after["projectId"]) != `"`+project.ID+`"` {
		t.Fatal("document ownership was not updated")
	}
	var snapshots []model.CanvasSnapshot
	if err := db.Where("canvas_id = ?", canvas.ID).Find(&snapshots).Error; err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 1 || snapshots[0].Revision != canvas.Revision || snapshots[0].Reason != "before_project_association" {
		t.Fatalf("missing association history: %+v", snapshots)
	}
	repeated, err := service.LinkCanvasUnit("user-1", project.ID, request)
	if err != nil || repeated.ID != link.ID {
		t.Fatalf("retry identity: %+v %v", repeated, err)
	}
	var reloaded model.CanvasProject
	db.First(&reloaded, "id = ?", canvas.ID)
	if reloaded.Revision != saved.Revision {
		t.Fatal("idempotent retry rewrote the canvas")
	}
	var count int64
	db.Model(&model.CanvasUnitLink{}).Count(&count)
	if count != 1 {
		t.Fatalf("duplicate links: %d", count)
	}
	var retrySnapshots int64
	db.Model(&model.CanvasSnapshot{}).Where("canvas_id = ?", canvas.ID).Count(&retrySnapshots)
	if retrySnapshots != 1 {
		t.Fatalf("idempotent retry created history: %d", retrySnapshots)
	}
}

func TestCanvasAssociationRejectsStalePreview(t *testing.T) {
	service, db, project, unit, canvas := associationFixture(t)
	stale := canvas.Revision - 1
	_, err := service.LinkCanvasUnit("user-1", project.ID, LinkCanvasUnitRequest{CanvasID: canvas.ID, UnitID: unit.ID, ExpectedCanvasRevision: &stale})
	var conflict *AppError
	if !errors.As(err, &conflict) || conflict.Status != 409 {
		t.Fatalf("expected HTTP conflict: %v", err)
	}
	var saved model.CanvasProject
	db.First(&saved, "id = ?", canvas.ID)
	if saved.ProjectID != "" || saved.PayloadJSON != canvas.PayloadJSON || saved.Revision != canvas.Revision {
		t.Fatal("stale preview changed canvas")
	}
	var count int64
	db.Model(&model.CanvasUnitLink{}).Count(&count)
	if count != 0 {
		t.Fatal("stale preview wrote link")
	}
}

func TestCanvasAssociationRollsBackOwnershipWhenLinkInsertFails(t *testing.T) {
	service, db, project, unit, canvas := associationFixture(t)
	if err := db.Exec(`CREATE TRIGGER reject_canvas_link BEFORE INSERT ON canvas_unit_links BEGIN SELECT RAISE(ABORT, 'synthetic link failure'); END;`).Error; err != nil {
		t.Fatal(err)
	}
	_, err := service.LinkCanvasUnit("user-1", project.ID, LinkCanvasUnitRequest{CanvasID: canvas.ID, UnitID: unit.ID, ExpectedCanvasRevision: &canvas.Revision})
	if err == nil {
		t.Fatal("write unexpectedly succeeded")
	}
	var saved model.CanvasProject
	var savedProject model.Project
	db.First(&saved, "id = ?", canvas.ID)
	db.First(&savedProject, "id = ?", project.ID)
	if saved.ProjectID != "" || saved.Revision != canvas.Revision || saved.PayloadJSON != canvas.PayloadJSON || savedProject.Revision != project.Revision {
		t.Fatal("failure left partial ownership or revision")
	}
	if err := db.Exec(`DROP TRIGGER reject_canvas_link`).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := service.LinkCanvasUnit("user-1", project.ID, LinkCanvasUnitRequest{CanvasID: canvas.ID, UnitID: unit.ID, ExpectedCanvasRevision: &canvas.Revision}); err != nil {
		t.Fatal(err)
	}
}

func TestCanvasAssociationRejectsForeignOwnershipAndUnits(t *testing.T) {
	for _, scenario := range []string{"user", "canvas-owner", "unit", "reassign", "malformed"} {
		t.Run(scenario, func(t *testing.T) {
			service, db, project, unit, canvas := associationFixture(t)
			userID := "user-1"
			switch scenario {
			case "user":
				userID = "other-user"
			case "canvas-owner":
				db.Model(&canvas).Update("user_id", "other-user")
			case "unit":
				db.Model(&unit).Update("project_id", "other-project")
			case "reassign":
				db.Model(&canvas).Update("project_id", "other-project")
			case "malformed":
				db.Model(&canvas).Update("payload_json", "null")
			}
			if _, err := service.LinkCanvasUnit(userID, project.ID, LinkCanvasUnitRequest{CanvasID: canvas.ID, UnitID: unit.ID}); err == nil {
				t.Fatal("invalid association accepted")
			}
			var count int64
			db.Model(&model.CanvasUnitLink{}).Count(&count)
			if count != 0 {
				t.Fatal("invalid association wrote a link")
			}
		})
	}
}

func TestCanvasAssociationSecondChapterNeedsCurrentVersion(t *testing.T) {
	service, db, project, unit, canvas := associationFixture(t)
	second := unit
	second.ID = "second-unit"
	if err := db.Create(&second).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := service.LinkCanvasUnit("user-1", project.ID, LinkCanvasUnitRequest{CanvasID: canvas.ID, UnitID: unit.ID, ExpectedCanvasRevision: &canvas.Revision}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.LinkCanvasUnit("user-1", project.ID, LinkCanvasUnitRequest{CanvasID: canvas.ID, UnitID: second.ID, ExpectedCanvasRevision: &canvas.Revision}); err == nil {
		t.Fatal("old second-chapter preview accepted")
	}
	currentRevision := canvas.Revision + 1
	if _, err := service.LinkCanvasUnit("user-1", project.ID, LinkCanvasUnitRequest{CanvasID: canvas.ID, UnitID: second.ID, ExpectedCanvasRevision: &currentRevision}); err != nil {
		t.Fatal(err)
	}
	var count int64
	db.Model(&model.CanvasUnitLink{}).Count(&count)
	if count != 2 {
		t.Fatalf("expected two explicit chapter links, got %d", count)
	}
}
