package app

import (
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestCanvasNodeShotViewsReadPinnedContentAndResourceState(t *testing.T) {
	for _, scenario := range []string{"current", "resource-deleted", "resource-not-ready", "resource-foreign", "shot-revised", "revision-missing", "artifact-unselected", "artifact-foreign", "node-type", "node-deleted", "shot-deleted", "unit-deleted"} {
		t.Run(scenario, func(t *testing.T) {
			service, db, project, unit, canvas, shot, artifact := canvasNodeShotFixture(t)
			link, err := service.LinkCanvasNodeShot("user-1", project.ID, canvas.ID, mappingRequest(project, unit, canvas, shot, artifact))
			if err != nil {
				t.Fatal(err)
			}
			want := "current"
			switch scenario {
			case "resource-deleted":
				err = db.Delete(&model.Resource{}, "id = ?", artifact.ResourceID).Error
				want = "resource_unavailable"
			case "resource-not-ready":
				err = db.Model(&model.Resource{}).Where("id = ?", artifact.ResourceID).Update("status", "pending").Error
				want = "resource_unavailable"
			case "resource-foreign":
				err = db.Model(&model.Resource{}).Where("id = ?", artifact.ResourceID).Update("user_id", "other-user").Error
				want = "resource_unavailable"
			case "shot-revised":
				err = db.Model(&model.Shot{}).Where("id = ?", shot.ID).Update("current_revision_id", "new-revision").Error
				want = "shot_revised"
			case "revision-missing":
				err = db.Delete(&model.ShotRevision{}, "id = ?", shot.CurrentRevisionID).Error
				want = "revision_missing"
			case "artifact-unselected":
				err = db.Model(&model.ShotArtifact{}).Where("id = ?", artifact.ID).Update("selected", false).Error
				want = "artifact_changed"
			case "artifact-foreign":
				err = db.Model(&model.ShotArtifact{}).Where("id = ?", artifact.ID).Update("shot_id", "other-shot").Error
				want = "artifact_changed"
			case "node-type":
				err = db.Model(&model.CanvasProject{}).Where("id = ?", canvas.ID).Update("payload_json", `{"nodes":[{"id":"node-video","type":"text"}]}`).Error
				want = "node_type_changed"
			case "node-deleted":
				err = db.Model(&model.CanvasProject{}).Where("id = ?", canvas.ID).Update("payload_json", `{"nodes":[]}`).Error
				want = "node_missing"
			case "shot-deleted":
				err = db.Delete(&model.Shot{}, "id = ?", shot.ID).Error
				want = "shot_missing"
			case "unit-deleted":
				err = db.Delete(&model.ProjectUnit{}, "id = ?", unit.ID).Error
				want = "unit_missing"
			}
			if err != nil {
				t.Fatal(err)
			}
			var before model.CanvasProject
			if err := db.First(&before, "id = ?", canvas.ID).Error; err != nil {
				t.Fatal(err)
			}
			links, views, err := service.CanvasNodeShotMappingViews("user-1", project.ID, canvas.ID)
			if err != nil || len(links) != 1 || len(views) != 1 {
				t.Fatalf("read: %v %+v %+v", err, links, views)
			}
			view := views[0]
			if view.State != want || view.LinkID != link.ID {
				t.Fatalf("got %+v, want %s", view, want)
			}
			if want == "resource_unavailable" && view.ResourceAvailable {
				t.Fatal("unavailable resource offered as ready")
			}
			if scenario == "current" && (!view.ResourceAvailable || view.Artifact == nil || view.Revision == nil || view.Revision.ID != link.ShotRevisionID) {
				t.Fatalf("missing projection: %+v", view)
			}
			if scenario == "shot-revised" && (view.Revision == nil || view.Revision.ID != link.ShotRevisionID) {
				t.Fatal("read silently adopted a new shot revision")
			}
			if scenario == "artifact-foreign" && view.Artifact != nil {
				t.Fatal("foreign artifact exposed")
			}
			if scenario == "shot-deleted" && (view.Artifact != nil || view.Revision != nil) {
				t.Fatal("deleted shot content exposed")
			}
			var after model.CanvasProject
			if err := db.First(&after, "id = ?", canvas.ID).Error; err != nil {
				t.Fatal(err)
			}
			if before.PayloadJSON != after.PayloadJSON || before.Revision != after.Revision {
				t.Fatal("projection rewrote canvas")
			}
			var stored model.Project
			if err := db.First(&stored, "id = ?", project.ID).Error; err != nil {
				t.Fatal(err)
			}
			if stored.Revision != project.Revision+1 {
				t.Fatal("projection changed project version")
			}
		})
	}
}

func TestCanvasNodeShotViewsFailClosedAndKeepEmptyResults(t *testing.T) {
	service, db, project, unit, canvas, shot, artifact := canvasNodeShotFixture(t)
	_, views, err := service.CanvasNodeShotMappingViews("user-1", project.ID, canvas.ID)
	if err != nil || views == nil || len(views) != 0 {
		t.Fatalf("empty read: %+v %v", views, err)
	}
	if _, _, err := service.CanvasNodeShotMappingViews("other-user", project.ID, canvas.ID); err == nil {
		t.Fatal("foreign user could read projection")
	}
	if _, err := service.LinkCanvasNodeShot("user-1", project.ID, canvas.ID, mappingRequest(project, unit, canvas, shot, artifact)); err != nil {
		t.Fatal(err)
	}
	if err := db.Migrator().DropTable(&model.Resource{}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := service.CanvasNodeShotMappingViews("user-1", project.ID, canvas.ID); err == nil {
		t.Fatal("database failure became a valid projection")
	}
}

func TestCanvasNodeShotViewsShareBusinessContentAcrossCanvases(t *testing.T) {
	service, db, project, unit, canvas, shot, artifact := canvasNodeShotFixture(t)
	if _, err := service.LinkCanvasNodeShot("user-1", project.ID, canvas.ID, mappingRequest(project, unit, canvas, shot, artifact)); err != nil {
		t.Fatal(err)
	}
	second := canvas
	second.ID = "second-projection-canvas"
	if err := db.Create(&second).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.CanvasUnitLink{ID: "second-unit-link", ProjectID: project.ID, UnitID: unit.ID, CanvasID: second.ID}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.First(&project, "id = ?", project.ID).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := service.LinkCanvasNodeShot("user-1", project.ID, second.ID, mappingRequest(project, unit, second, shot, artifact)); err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.Shot{}).Where("id = ?", shot.ID).Update("title", "Shared business title").Error; err != nil {
		t.Fatal(err)
	}
	for _, canvasID := range []string{canvas.ID, second.ID} {
		_, views, err := service.CanvasNodeShotMappingViews("user-1", project.ID, canvasID)
		if err != nil || len(views) != 1 {
			t.Fatalf("%s: %v", canvasID, err)
		}
		if views[0].ShotTitle != "Shared business title" || views[0].Revision == nil || views[0].Revision.ID != shot.CurrentRevisionID || views[0].Artifact == nil || views[0].Artifact.ID != artifact.ID {
			t.Fatalf("divergent business content: %+v", views[0])
		}
	}
}
