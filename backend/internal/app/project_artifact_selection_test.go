package app

import (
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
)

func TestSelectShotArtifactSwitchesCurrentReadyVersion(t *testing.T) {
	service, db := newProjectWorkflowV2TestService(t)
	project, unit := seedWorkflowProject(t, db)
	shot, err := service.CreateProjectShot("user-1", project.ID, CreateProjectShotRequest{UnitID: unit.ID, Title: "SC.01", Description: "测试镜头", DurationMs: 3000})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	artifacts := []model.ShotArtifact{
		{ID: "artifact-v1", ProjectID: project.ID, UnitID: unit.ID, ShotID: shot.ID, RevisionID: shot.CurrentRevisionID, Type: "video", Version: 1, Status: "ready", Selected: true, CreatedAt: now, UpdatedAt: now},
		{ID: "artifact-v2", ProjectID: project.ID, UnitID: unit.ID, ShotID: shot.ID, RevisionID: shot.CurrentRevisionID, Type: "video", Version: 2, Status: "ready", CreatedAt: now, UpdatedAt: now},
	}
	if err := db.Create(&artifacts).Error; err != nil {
		t.Fatal(err)
	}
	selected, err := service.SelectShotArtifact("user-1", project.ID, shot.ID, "artifact-v2")
	if err != nil {
		t.Fatal(err)
	}
	if !selected.Selected {
		t.Fatal("selected artifact was not marked current")
	}
	var previous model.ShotArtifact
	if err := db.First(&previous, "id = ?", "artifact-v1").Error; err != nil {
		t.Fatal(err)
	}
	if previous.Selected {
		t.Fatal("previous artifact remained selected")
	}
}

func TestSelectShotArtifactRejectsStaleVersion(t *testing.T) {
	service, db := newProjectWorkflowV2TestService(t)
	project, unit := seedWorkflowProject(t, db)
	shot, err := service.CreateProjectShot("user-1", project.ID, CreateProjectShotRequest{UnitID: unit.ID, Title: "SC.01", Description: "测试镜头", DurationMs: 3000})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := service.CreateShotRevision("user-1", project.ID, shot.ID, ShotRevisionInput{PlotDescription: "新版本", DurationMs: 3000}); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	artifact := model.ShotArtifact{ID: "artifact-old", ProjectID: project.ID, UnitID: unit.ID, ShotID: shot.ID, RevisionID: shot.CurrentRevisionID, Type: "video", Version: 1, Status: "ready", CreatedAt: now, UpdatedAt: now}
	if err := db.Create(&artifact).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := service.SelectShotArtifact("user-1", project.ID, shot.ID, artifact.ID); err == nil {
		t.Fatal("stale artifact was accepted")
	}
}
