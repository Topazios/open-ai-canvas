package app

import "testing"

func TestProductionParallelModelSelectionDoesNotMixRunDefaults(t *testing.T) {
	state := cloudAgentRuntime{}
	state.Request.ChannelID = "run-channel"
	state.Request.ChannelModelKey = "run-channel-model"
	state.Request.LogicalModelID = "run-logical-model"
	state.Request.Model = "run-model"

	work := productionParallelWork{
		GenerationModel:           "selected-model",
		GenerationChannelID:       "",
		GenerationChannelModelKey: "",
		GenerationLogicalModelID:  "selected-logical-model",
	}
	channelID, channelModelKey, logicalModelID, modelName := productionParallelModelSelection(work, state)
	if channelID != "" || channelModelKey != "" || logicalModelID != "selected-logical-model" || modelName != "selected-model" {
		t.Fatalf("selected model was mixed with run defaults: channel=%q channelModel=%q logical=%q model=%q", channelID, channelModelKey, logicalModelID, modelName)
	}

	work = productionParallelWork{}
	channelID, channelModelKey, logicalModelID, modelName = productionParallelModelSelection(work, state)
	if channelID != "run-channel" || channelModelKey != "run-channel-model" || logicalModelID != "run-logical-model" || modelName != "run-channel-model" {
		t.Fatalf("legacy work did not inherit the run model: channel=%q channelModel=%q logical=%q model=%q", channelID, channelModelKey, logicalModelID, modelName)
	}
}

func TestSelectedAssetGenerationSettingsPersistOnWork(t *testing.T) {
	s, _, runID := parallelPlanFixture(t)
	_, state := productionRuntimeState(t, s, runID)
	m, _, rows := orderedPlanState(t, s, runID)
	selection := &ProductionAssetModelSelection{Model: "test-text-model", LogicalModelID: "logical-text-model", ReasoningEffort: ReasoningEffort("high"), Instruction: "人物面部特征保持一致，按参考图布局补充三维尺寸。"}
	if err := applyProductionAssetGenerationSettings(&state, m, rows, []string{"character"}, selection); err != nil {
		t.Fatal(err)
	}
	productionRuntimeMutate(t, s, runID, func(current *cloudAgentRuntime) { current.ProductionParallel = state.ProductionParallel })
	_, state = productionRuntimeState(t, s, runID)
	work := state.ProductionParallel["character"]
	if work.GenerationInstruction != selection.Instruction || work.GenerationReasoningEffort != ReasoningEffort("high") || work.GenerationModel != selection.Model || work.GenerationLogicalModelID != selection.LogicalModelID || work.Dependencies == "" {
		t.Fatalf("generation settings were not persisted with the work item: %+v", work)
	}
	work.TaskID = "already-submitted"
	state.ProductionParallel["character"] = work
	changed := &ProductionAssetModelSelection{ReasoningEffort: ReasoningEffort("low"), Instruction: "do not replace submitted prompt"}
	if err := applyProductionAssetGenerationSettings(&state, m, rows, []string{"character"}, changed); err != nil {
		t.Fatal(err)
	}
	if state.ProductionParallel["character"].GenerationInstruction != selection.Instruction || state.ProductionParallel["character"].GenerationReasoningEffort != ReasoningEffort("high") {
		t.Fatal("submitted task settings were mutated after dispatch")
	}
}
