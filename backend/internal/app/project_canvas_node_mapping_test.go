package app

import (
	"errors"
	"testing"
	"time"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
)

func canvasNodeShotFixture(t *testing.T) (*Service, *gorm.DB, model.Project, model.ProjectUnit, model.CanvasProject, model.Shot, model.ShotArtifact) {
	t.Helper()
	service, db, project, unit, canvas := associationFixture(t)
	if err := db.AutoMigrate(&model.ProjectAssetFolder{}); err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&canvas).Update("payload_json", `{"id":"association-canvas","nodes":[{"id":"node-video","type":"video","title":"画布视频"},{"id":"node-text","type":"text","title":"说明"}],"connections":[],"viewport":{"x":7,"k":0.5},"unknown":{"keep":true}}`).Error; err != nil {
		t.Fatal(err)
	}
	shot, err := service.CreateProjectShot("user-1", project.ID, CreateProjectShotRequest{UnitID: unit.ID, Title: "镜头一", Description: "站在窗前", DurationMs: 3000})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.LinkCanvasUnit("user-1", project.ID, LinkCanvasUnitRequest{CanvasID: canvas.ID, UnitID: unit.ID, ExpectedCanvasRevision: &canvas.Revision}); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	resource := model.Resource{ID: "mapping-resource", UserID: "user-1", Kind: "video", Status: model.ResourceStatusReady, MimeType: "video/mp4", CreatedAt: now, UpdatedAt: now}
	if err := db.Create(&resource).Error; err != nil {
		t.Fatal(err)
	}
	artifact := model.ShotArtifact{ID: "mapping-artifact", ProjectID: project.ID, UnitID: unit.ID, ShotID: shot.ID, RevisionID: shot.CurrentRevisionID, Type: "video", Version: 1, ResourceID: resource.ID, Status: "ready", Selected: true, CreatedAt: now, UpdatedAt: now}
	if err := db.Create(&artifact).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.First(&canvas, "id = ?", canvas.ID).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.First(&project, "id = ?", project.ID).Error; err != nil {
		t.Fatal(err)
	}
	return service, db, project, unit, canvas, shot, artifact
}

func mappingRequest(project model.Project, unit model.ProjectUnit, canvas model.CanvasProject, shot model.Shot, artifact model.ShotArtifact) LinkCanvasNodeShotRequest {
	return LinkCanvasNodeShotRequest{UnitID: unit.ID, NodeID: "node-video", ShotID: shot.ID, ArtifactID: artifact.ID, ExpectedCanvasRevision: canvas.Revision, ExpectedProjectRevision: project.Revision}
}

func requireMappingConflict(t *testing.T, err error) {
	t.Helper()
	var appErr *AppError
	if !errors.As(err, &appErr) || appErr.Status != 409 {
		t.Fatalf("expected revision conflict, got %v", err)
	}
}

func TestCanvasNodeShotLinkPersistsWithoutRewritingCanvasOrShot(t *testing.T) {
	service, db, project, unit, canvas, shot, artifact := canvasNodeShotFixture(t)
	req := mappingRequest(project, unit, canvas, shot, artifact)
	link, err := service.LinkCanvasNodeShot("user-1", project.ID, canvas.ID, req)
	if err != nil {
		t.Fatal(err)
	}
	if link.NodeID != req.NodeID || link.ShotID != shot.ID || link.ShotRevisionID != shot.CurrentRevisionID || link.ArtifactID != artifact.ID {
		t.Fatalf("wrong mapping: %+v", link)
	}
	var afterCanvas model.CanvasProject
	var afterShot model.Shot
	var afterProject model.Project
	db.First(&afterCanvas, "id = ?", canvas.ID)
	db.First(&afterShot, "id = ?", shot.ID)
	db.First(&afterProject, "id = ?", project.ID)
	if afterCanvas.PayloadJSON != canvas.PayloadJSON || afterCanvas.Revision != canvas.Revision || afterShot.CurrentRevisionID != shot.CurrentRevisionID || afterShot.Description != shot.Description {
		t.Fatal("mapping rewrote canvas content or business shot")
	}
	if afterProject.Revision != project.Revision+1 {
		t.Fatal("mapping did not advance project revision exactly once")
	}
	again, err := service.LinkCanvasNodeShot("user-1", project.ID, canvas.ID, req)
	if err != nil || again.ID != link.ID {
		t.Fatalf("idempotent retry: %+v %v", again, err)
	}
	var count int64
	db.Model(&model.CanvasNodeShotLink{}).Count(&count)
	if count != 1 {
		t.Fatalf("duplicate mappings: %d", count)
	}
	db.First(&afterProject, "id = ?", project.ID)
	if afterProject.Revision != project.Revision+1 {
		t.Fatal("idempotent retry advanced revision")
	}
	links, err := service.CanvasNodeShotLinks("user-1", project.ID, canvas.ID)
	if err != nil || len(links) != 1 || links[0].ID != link.ID {
		t.Fatalf("read mappings: %+v %v", links, err)
	}
	detail, err := service.ProjectDetail("user-1", project.ID)
	if err != nil || len(detail.CanvasNodeShotLinks) != 1 {
		t.Fatalf("project detail did not expose mapping: %v", err)
	}
}

func TestCanvasNodeShotLinkRejectsStaleOrForeignTargets(t *testing.T) {
	for _, scenario := range []string{"user", "canvas", "project-version", "unit", "node", "artifact-type", "artifact-unselected", "artifact-resource", "foreign-project", "foreign-shot", "foreign-resource", "deleted-unit", "missing-revision", "foreign-revision", "duplicate-node", "archived"} {
		t.Run(scenario, func(t *testing.T) {
			service, db, project, unit, canvas, shot, artifact := canvasNodeShotFixture(t)
			req := mappingRequest(project, unit, canvas, shot, artifact)
			userID := "user-1"
			switch scenario {
			case "user":
				userID = "other-user"
			case "canvas":
				req.ExpectedCanvasRevision--
			case "project-version":
				req.ExpectedProjectRevision--
			case "unit":
				req.UnitID = "other-unit"
			case "node":
				req.NodeID = "missing-node"
			case "artifact-type":
				req.NodeID = "node-text"
			case "artifact-unselected":
				if err := db.Model(&artifact).Update("selected", false).Error; err != nil {
					t.Fatal(err)
				}
			case "artifact-resource":
				if err := db.Model(&model.Resource{}).Where("id = ?", artifact.ResourceID).Update("status", model.ResourceStatusDeleted).Error; err != nil {
					t.Fatal(err)
				}
			case "foreign-project":
				if err := db.Model(&canvas).Update("project_id", "other-project").Error; err != nil {
					t.Fatal(err)
				}
			case "foreign-shot":
				if err := db.Model(&shot).Update("project_id", "other-project").Error; err != nil {
					t.Fatal(err)
				}
			case "foreign-resource":
				if err := db.Model(&model.Resource{}).Where("id = ?", artifact.ResourceID).Update("user_id", "other-user").Error; err != nil {
					t.Fatal(err)
				}
			case "deleted-unit":
				if err := db.Delete(&unit).Error; err != nil {
					t.Fatal(err)
				}
			case "missing-revision":
				req.ArtifactID = ""
				if err := db.Delete(&model.ShotRevision{}, "id = ?", shot.CurrentRevisionID).Error; err != nil {
					t.Fatal(err)
				}
			case "foreign-revision":
				req.ArtifactID = ""
				if err := db.Model(&model.ShotRevision{}).Where("id = ?", shot.CurrentRevisionID).Update("shot_id", "other-shot").Error; err != nil {
					t.Fatal(err)
				}
			case "duplicate-node":
				if err := db.Model(&canvas).Update("payload_json", `{"nodes":[{"id":"node-video","type":"video"},{"id":"node-video","type":"video"}]}`).Error; err != nil {
					t.Fatal(err)
				}
			case "archived":
				if err := db.Model(&project).Update("status", model.ProjectStatusArchived).Error; err != nil {
					t.Fatal(err)
				}
			}
			if _, err := service.LinkCanvasNodeShot(userID, project.ID, canvas.ID, req); err == nil {
				t.Fatal("invalid node mapping accepted")
			}
			var count int64
			db.Model(&model.CanvasNodeShotLink{}).Count(&count)
			if count != 0 {
				t.Fatal("rejected mapping wrote relation")
			}
			var stored model.Project
			db.First(&stored, "id = ?", project.ID)
			if stored.Revision != project.Revision {
				t.Fatal("rejected mapping advanced project revision")
			}
		})
	}
}

func TestCanvasNodeShotLinkOldUnlinkCannotRemoveReboundMapping(t *testing.T) {
	service, db, project, unit, canvas, shot, artifact := canvasNodeShotFixture(t)
	link, err := service.LinkCanvasNodeShot("user-1", project.ID, canvas.ID, mappingRequest(project, unit, canvas, shot, artifact))
	if err != nil {
		t.Fatal(err)
	}
	old := UnlinkCanvasNodeShotRequest{ExpectedLinkID: link.ID, ExpectedProjectRevision: project.Revision + 1}
	request := mappingRequest(project, unit, canvas, shot, artifact)
	request.ArtifactID = ""
	_, err = service.LinkCanvasNodeShot("user-1", project.ID, canvas.ID, request)
	requireMappingConflict(t, err)
	request.ExpectedProjectRevision++
	rebound, err := service.LinkCanvasNodeShot("user-1", project.ID, canvas.ID, request)
	if err != nil {
		t.Fatal(err)
	}
	requireMappingConflict(t, service.UnlinkCanvasNodeShot("user-1", project.ID, canvas.ID, link.NodeID, old))
	var stored model.CanvasNodeShotLink
	if err := db.First(&stored, "id = ?", link.ID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.ID != rebound.ID || stored.ArtifactID != "" {
		t.Fatal("old unlink changed the new mapping")
	}
}

func TestCanvasNodeShotLinkRevisionFailureRollsBackInsertUpdateAndUnlink(t *testing.T) {
	for _, operation := range []string{"insert", "update", "unlink"} {
		t.Run(operation, func(t *testing.T) {
			service, db, project, unit, canvas, shot, artifact := canvasNodeShotFixture(t)
			request := mappingRequest(project, unit, canvas, shot, artifact)
			var before model.CanvasNodeShotLink
			var err error
			if operation != "insert" {
				before, err = service.LinkCanvasNodeShot("user-1", project.ID, canvas.ID, request)
				if err != nil {
					t.Fatal(err)
				}
				project.Revision++
				request.ExpectedProjectRevision = project.Revision
			}
			if err := db.Exec(`CREATE TRIGGER reject_mapping_revision BEFORE UPDATE ON projects BEGIN SELECT RAISE(ABORT, 'synthetic revision failure'); END;`).Error; err != nil {
				t.Fatal(err)
			}
			if operation == "unlink" {
				err = service.UnlinkCanvasNodeShot("user-1", project.ID, canvas.ID, before.NodeID, UnlinkCanvasNodeShotRequest{ExpectedLinkID: before.ID, ExpectedProjectRevision: project.Revision})
			} else {
				if operation == "update" {
					request.ArtifactID = ""
				}
				_, err = service.LinkCanvasNodeShot("user-1", project.ID, canvas.ID, request)
			}
			if err == nil {
				t.Fatal("revision failure was ignored")
			}
			links, err := service.CanvasNodeShotLinks("user-1", project.ID, canvas.ID)
			if err != nil {
				t.Fatal(err)
			}
			if operation == "insert" {
				if len(links) != 0 {
					t.Fatal("failed insert remained")
				}
			} else if len(links) != 1 || links[0].ID != before.ID || links[0].ArtifactID != before.ArtifactID {
				t.Fatal("failed write did not restore original relation")
			}
			var stored model.Project
			if err := db.First(&stored, "id = ?", project.ID).Error; err != nil {
				t.Fatal(err)
			}
			if stored.Revision != project.Revision {
				t.Fatal("failed write changed project revision")
			}
		})
	}
}

func TestCanvasNodeShotLinkDeletedShotRemainsReviewableWithoutResurrection(t *testing.T) {
	service, db, project, unit, canvas, shot, artifact := canvasNodeShotFixture(t)
	request := mappingRequest(project, unit, canvas, shot, artifact)
	link, err := service.LinkCanvasNodeShot("user-1", project.ID, canvas.ID, request)
	if err != nil {
		t.Fatal(err)
	}
	if err := service.DeleteProjectShot("user-1", project.ID, shot.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.LinkCanvasNodeShot("user-1", project.ID, canvas.ID, request); err == nil {
		t.Fatal("deleted shot was accepted on retry")
	}
	links, err := service.CanvasNodeShotLinks("user-1", project.ID, canvas.ID)
	if err != nil || len(links) != 1 || links[0].ID != link.ID {
		t.Fatalf("lost reviewable relation: %v", err)
	}
	var count int64
	if err := db.Model(&model.Shot{}).Where("id = ?", shot.ID).Count(&count).Error; err != nil || count != 0 {
		t.Fatalf("shot resurrected: %v", err)
	}
	var current model.Project
	if err := db.First(&current, "id = ?", project.ID).Error; err != nil {
		t.Fatal(err)
	}
	if err := service.UnlinkCanvasNodeShot("user-1", project.ID, canvas.ID, link.NodeID, UnlinkCanvasNodeShotRequest{ExpectedLinkID: link.ID, ExpectedProjectRevision: current.Revision}); err != nil {
		t.Fatal(err)
	}
}

func TestCanvasNodeShotLinkManyCanvasesAndChapterUnlinkAreScoped(t *testing.T) {
	service, db, project, unit, canvas, shot, artifact := canvasNodeShotFixture(t)
	if _, err := service.LinkCanvasNodeShot("user-1", project.ID, canvas.ID, mappingRequest(project, unit, canvas, shot, artifact)); err != nil {
		t.Fatal(err)
	}
	second := canvas
	second.ID = "second-canvas"
	if err := db.Create(&second).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.CanvasUnitLink{ID: "second-unit-link", ProjectID: project.ID, CanvasID: second.ID, UnitID: unit.ID}).Error; err != nil {
		t.Fatal(err)
	}
	project.Revision++
	if _, err := service.LinkCanvasNodeShot("user-1", project.ID, second.ID, mappingRequest(project, unit, second, shot, artifact)); err != nil {
		t.Fatal(err)
	}
	if err := service.UnlinkCanvasUnit("user-1", project.ID, canvas.ID, unit.ID); err != nil {
		t.Fatal(err)
	}
	firstLinks, err := service.CanvasNodeShotLinks("user-1", project.ID, canvas.ID)
	if err != nil || len(firstLinks) != 0 {
		t.Fatalf("chapter unlink left mappings: %v", err)
	}
	secondLinks, err := service.CanvasNodeShotLinks("user-1", project.ID, second.ID)
	if err != nil || len(secondLinks) != 1 || secondLinks[0].ShotID != shot.ID {
		t.Fatalf("other canvas mapping changed: %v", err)
	}
	if err := db.First(&model.Shot{}, "id = ?", shot.ID).Error; err != nil {
		t.Fatal("unlink deleted shot", err)
	}
}

func TestCanvasNodeShotLinkUnlinkIsScopedAndLeavesShot(t *testing.T) {
	service, db, project, unit, canvas, shot, artifact := canvasNodeShotFixture(t)
	link, err := service.LinkCanvasNodeShot("user-1", project.ID, canvas.ID, mappingRequest(project, unit, canvas, shot, artifact))
	if err != nil {
		t.Fatal(err)
	}
	var current model.Project
	db.First(&current, "id = ?", project.ID)
	if err := service.UnlinkCanvasNodeShot("user-1", project.ID, canvas.ID, link.NodeID, UnlinkCanvasNodeShotRequest{ExpectedLinkID: "wrong", ExpectedProjectRevision: current.Revision}); err == nil {
		t.Fatal("different mapping identity was removed")
	}
	if err := service.UnlinkCanvasNodeShot("other-user", project.ID, canvas.ID, link.NodeID, UnlinkCanvasNodeShotRequest{ExpectedLinkID: link.ID, ExpectedProjectRevision: current.Revision}); err == nil {
		t.Fatal("foreign user removed mapping")
	}
	request := UnlinkCanvasNodeShotRequest{ExpectedLinkID: link.ID, ExpectedProjectRevision: current.Revision}
	if err := service.UnlinkCanvasNodeShot("user-1", project.ID, canvas.ID, link.NodeID, request); err != nil {
		t.Fatal(err)
	}
	if err := service.UnlinkCanvasNodeShot("user-1", project.ID, canvas.ID, link.NodeID, request); err != nil {
		t.Fatal(err)
	}
	var count int64
	db.Model(&model.CanvasNodeShotLink{}).Count(&count)
	if count != 0 {
		t.Fatal("mapping remains after unlink")
	}
	if err := db.First(&model.Shot{}, "id = ?", shot.ID).Error; err != nil {
		t.Fatal("unlink removed business shot", err)
	}
	db.First(&current, "id = ?", project.ID)
	if current.Revision != project.Revision+2 {
		t.Fatal("unlink/retry project revision mismatch")
	}
}

func TestCanvasNodeShotLinkFailedWriteRollsBackProjectRevision(t *testing.T) {
	service, db, project, unit, canvas, shot, artifact := canvasNodeShotFixture(t)
	if err := db.Exec(`CREATE TRIGGER reject_node_mapping BEFORE INSERT ON canvas_node_shot_links BEGIN SELECT RAISE(ABORT, 'synthetic mapping failure'); END;`).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := service.LinkCanvasNodeShot("user-1", project.ID, canvas.ID, mappingRequest(project, unit, canvas, shot, artifact)); err == nil {
		t.Fatal("write unexpectedly succeeded")
	}
	var stored model.Project
	db.First(&stored, "id = ?", project.ID)
	if stored.Revision != project.Revision {
		t.Fatal("failed write advanced project revision")
	}
	var count int64
	db.Model(&model.CanvasNodeShotLink{}).Count(&count)
	if count != 0 {
		t.Fatal("failed write left a mapping")
	}
}

func TestCanvasNodeShotLinkCanRebindAfterShotRevisionWithoutAdoptingOldArtifact(t *testing.T) {
	service, db, project, unit, canvas, shot, artifact := canvasNodeShotFixture(t)
	link, err := service.LinkCanvasNodeShot("user-1", project.ID, canvas.ID, mappingRequest(project, unit, canvas, shot, artifact))
	if err != nil {
		t.Fatal(err)
	}
	updatedShot, _, err := service.CreateShotRevision("user-1", project.ID, shot.ID, ShotRevisionInput{PlotDescription: "换成新构图", DurationMs: 3000})
	if err != nil {
		t.Fatal(err)
	}
	var current model.Project
	db.First(&current, "id = ?", project.ID)
	request := LinkCanvasNodeShotRequest{UnitID: unit.ID, NodeID: link.NodeID, ShotID: shot.ID, ArtifactID: artifact.ID, ExpectedCanvasRevision: canvas.Revision, ExpectedProjectRevision: current.Revision}
	if _, err := service.LinkCanvasNodeShot("user-1", project.ID, canvas.ID, request); err == nil {
		t.Fatal("obsolete artifact accepted")
	}
	request.ArtifactID = ""
	rebound, err := service.LinkCanvasNodeShot("user-1", project.ID, canvas.ID, request)
	if err != nil {
		t.Fatal(err)
	}
	if rebound.ID != link.ID || rebound.ShotRevisionID != updatedShot.CurrentRevisionID || rebound.ArtifactID != "" {
		t.Fatalf("wrong refreshed mapping: %+v", rebound)
	}
	var count int64
	db.Model(&model.CanvasNodeShotLink{}).Count(&count)
	if count != 1 {
		t.Fatal("rebind duplicated mapping")
	}
}
