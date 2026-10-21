import { expect, test } from "bun:test";
import { createCanvasNode, createStoryboardRow } from "@/lib/canvas/canvas-project-domain";
import { episodeStoryboardPromptPatch, episodeStoryboardRows, episodeStoryboardTiming, materializeEpisodeStoryboard, resolveEpisodeShotAssets, storyboardRowIsReady } from "@/lib/canvas/workflow-episode-storyboard";
import { assetContentSignature, assetMediaSignature } from "@/lib/canvas/canvas-workflow-asset-profile";
import { reconcileStoryboardTargetConnections, storyboardComposerContent } from "@/lib/canvas/canvas-storyboard-materializer";
import { buildNodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { workflowSignature } from "@/lib/canvas/canvas-short-drama-workflow";

function fixture() {
    const data = (step: "story.plan" | "direction.shots", sourceNodeIds: string[]) => ({ stage: step === "story.plan" ? "story" as const : "storyboard" as const, step, pipelineId: "branch", role: "document" as const, sourceNodeIds, sourceSignatures: {} });
    const image = { ...createCanvasNode(CanvasNodeType.Image, { x: 0, y: 0 }, { status: "success", content: "data:image/png;base64,AA==" }), id: "selected-image" };
    const asset = { ...createCanvasNode(CanvasNodeType.Text, { x: 0, y: 0 }, { content: "林岚穿灰色外套，声线低沉。", status: "success", shortDrama: data("story.plan", []) }), id: "asset" };
    asset.metadata!.shortDrama!.assetIdentity = { id: "identity", code: "CHR-0001", kind: "character" };
    asset.metadata!.shortDrama!.assetProfile = { aliases: [], occurrences: [], variants: [], sounds: [], conflicts: [], indexContent: assetContentSignature(asset.metadata!.content!), references: [{ nodeId: image.id, variant: "基准", signature: assetMediaSignature(image), selected: true }] };
    const script = { ...createCanvasNode(CanvasNodeType.Script, { x: 0, y: 0 }, { status: "success", shortDrama: data("direction.shots", [asset.id]), storyboard: { rows: [], visibleColumns: [], referenceNodeIds: [] } }), id: "episode-table" };
    const row = createStoryboardRow(1, { id: "episode-table:S1-001", shotCode: "S1-001", durationSeconds: 5, videoMotionPrompt: "CHR-0001 推门进入室内。", assetKeys: ["CHR-0001"] });
    script.metadata!.storyboard!.rows = [row];
    const foreign = structuredClone(asset); foreign.id = "other-version"; foreign.metadata!.content = "不得混入的其他版本";
    const unrelated = createCanvasNode(CanvasNodeType.Text, { x: 0, y: 0 }, { content: "不得带入的全量正文与资产库", shortDrama: data("story.plan", []) });
    return { script, asset, image, foreign, unrelated, row, nodes: [script, asset, image, foreign, unrelated] as CanvasNodeData[] };
}

test("episode lanes do not exempt old per-scene short tails", () => {
	const f = fixture();
	f.script.metadata!.shortDrama!.parameters = { shotDurationSeconds: 25, shotDurationToleranceSeconds: 3 };
	f.script.metadata!.storyboard!.executionMode = "episode";
	const timing = episodeStoryboardTiming(f.script)!;
	expect(timing.issue({ ...f.row, durationSeconds: 11, sceneDurationSeconds: 33, timingException: "scene_tail" })).toBe("低于 22 秒");
	expect(timing.issue({ ...f.row, durationSeconds: 26, sceneDurationSeconds: 52 })).toBe("");
});

test("planned shot slots are preserved but cannot resolve media context before details complete", () => {
    const f = fixture();
    const planned = { ...f.row, detailStatus: "planned" as const, plannedGoal: "入场", videoMotionPrompt: "", plotDescription: "" };
    f.script.metadata!.storyboard!.rows = [planned];
    expect(episodeStoryboardRows(f.script)).toEqual([planned]);
    expect(materializeEpisodeStoryboard(f.script)).toBe(f.script);
    expect(storyboardRowIsReady(planned)).toBe(false);
    expect(() => resolveEpisodeShotAssets(f.script, planned, f.nodes)).toThrow();
    expect(storyboardRowIsReady({ ...f.row, detailStatus: "queued" })).toBe(false);
    expect(storyboardRowIsReady({ ...f.row, detailStatus: "ready" })).toBe(true);
});

test("existing Markdown is converted in place with stable shot codes and complete prompts", () => {
    const node = createCanvasNode(CanvasNodeType.Text, { x: 30, y: 50 }, { status: "success", content: "## S1 场景\n### S1-001 · 5.0秒\n画面：CHR-0001推门\n景别/机位/运动：中景固定\n对白：回来了\n声音：门响\n连续性/剪辑：保持视线\n资产：CHR-0001\n原文依据：第1–2段\n### S1-002 · 4.0秒\n画面：PRP-0001落地\n景别/机位/运动：特写\n对白：无\n声音：落地声\n连续性/剪辑：动作相接\n资产：PRP-0001\n原文依据：第3段", shortDrama: { stage: "storyboard", step: "direction.shots", pipelineId: "p", role: "document", sourceNodeIds: [], sourceSignatures: {} } });
    expect(episodeStoryboardRows(node).map(row => row.shotCode)).toEqual(["S1-001", "S1-002"]);
    const converted = materializeEpisodeStoryboard(node);
    expect(converted.type).toBe(CanvasNodeType.Script);
    expect(converted.id).toBe(node.id); expect(converted.position).toEqual(node.position);
    expect(converted.metadata!.content).toBe(node.metadata!.content);
    expect(converted.metadata!.storyboard!.rows[0].videoMotionPrompt).toContain("声音：门响");
    expect(converted.metadata!.storyboard!.rows[1].assetKeys).toEqual(["PRP-0001"]);
    expect(materializeEpisodeStoryboard(converted)).toBe(converted);
    expect(materializeEpisodeStoryboard({ ...node, metadata: { ...node.metadata, status: "loading" } }).type).toBe(CanvasNodeType.Text);
});

test("saved out-of-range durations stay visible as issues and only unavoidable tails are exempt", () => {
    const f = fixture();
    f.script.metadata!.shortDrama!.parameters = { episodeCount: 1, minutesPerEpisode: "1-2", shotDurationSeconds: 10, shotDurationToleranceSeconds: 3 };
    const timing = episodeStoryboardTiming(f.script)!;
    expect(timing.issue(f.row)).toBe("低于 7 秒");
    expect(timing.issue({ ...f.row, durationSeconds: 13 })).toBe("");
    expect(timing.issue({ ...f.row, durationSeconds: 14 })).toBe("超过 13 秒");
    expect(timing.issue({ ...f.row, durationSeconds: 5, timingException: "scene_tail", sceneDurationSeconds: 5 })).toBe("低于 7 秒");
    expect(timing.issue({ ...f.row, durationSeconds: 5, timingException: "scene_tail", sceneDurationSeconds: 12 })).toBe("低于 7 秒");
    expect(timing.issue({ ...f.row, durationSeconds: NaN })).toBe("时长无效");
    expect(episodeStoryboardTiming({ ...f.script, metadata: {} })).toBeUndefined();
    f.script.metadata!.shortDrama!.parameters.shotDurationSeconds = 30;
    expect(episodeStoryboardTiming(f.script)!.issue({ ...f.row, durationSeconds: 4, timingException: "scene_tail", sceneDurationSeconds: 34 })).toBe("");
});

test("numbered shot references include the pinned text and selected base image, never unrelated versions", () => {
    const f = fixture();
    const assets = resolveEpisodeShotAssets(f.script, f.row, f.nodes);
    expect(assets.nodes.map(node => node.id)).toEqual([f.asset.id]);
    expect(assets.media.map(node => node.id)).toEqual([f.image.id]);
    const video = createCanvasNode(CanvasNodeType.Video, { x: 0, y: 0 }, {});
    const graph = [...f.nodes, video];
    const edges = reconcileStoryboardTargetConnections([], f.script, f.row, video.id, assets.referenceNodeIds);
    const prompt = storyboardComposerContent(f.row.videoMotionPrompt, assets.referenceNodeIds, graph);
    const context = buildNodeGenerationContext(video.id, graph, edges, prompt, []);
    expect(context.referenceImages).toHaveLength(1);
    expect(context.prompt).toContain("灰色外套");
    expect(context.prompt).not.toContain("不得混入");
    expect(context.prompt).not.toContain("不得带入");
});

test("editing a prompt replaces its explicit asset codes and preserves source-inferred references", () => {
    const row = fixture().row;
    row.assetKeys!.push("SCN-0001");
    const patch = episodeStoryboardPromptPatch(row, "CHR-0002推门进入室内。");
    expect(patch.assetKeys).toEqual(["SCN-0001", "CHR-0002"]);
    expect(episodeStoryboardPromptPatch({ ...row, ...patch }, "空镜头").assetKeys).toEqual(["SCN-0001"]);
});

test("missing, conflicting and changed reference versions fail before paid submission", () => {
    const f = fixture();
    expect(() => resolveEpisodeShotAssets(f.script, { ...f.row, assetKeys: ["CHR-9999"] }, f.nodes)).toThrow("未完成");
    f.image.metadata!.content = "data:image/png;base64,NEW=";
    expect(() => resolveEpisodeShotAssets(f.script, f.row, f.nodes)).toThrow("参考版本");
    f.script.metadata!.shortDrama!.sourceNodeIds.push(f.foreign.id);
    expect(() => resolveEpisodeShotAssets(f.script, f.row, f.nodes)).toThrow("多个版本");
});

test("generated asset sheets resolve automatically from the pinned source with explicit selection taking priority", () => {
    const f = fixture();
    f.asset.metadata!.shortDrama!.assetProfile!.references = [];
    const sheet = (id: string, version: number, owner = f.asset) => ({
        ...f.image, id, metadata: { ...f.image.metadata, shortDrama: {
            ...f.asset.metadata!.shortDrama!, mediaKind: "image" as const, mediaSubjectId: owner.id,
            sourceSignatures: { [owner.id]: workflowSignature(owner) }, version,
        } },
    });
    const first = sheet("sheet-1", 1), latest = sheet("sheet-2", 2), unrelated = sheet("foreign-sheet", 5, f.foreign);
    const nodes = [...f.nodes, first, latest, unrelated];
    expect(resolveEpisodeShotAssets(f.script, f.row, nodes).media.map(node => node.id)).toEqual([latest.id]);
    f.asset.metadata!.content += "手动修改";
    expect(() => resolveEpisodeShotAssets(f.script, f.row, nodes)).toThrow("图片来源已变化");
    f.asset.metadata!.content = "林岚穿灰色外套，声线低沉。";
    expect(() => resolveEpisodeShotAssets(f.script, f.row, [...nodes, sheet("duplicate", 2)])).toThrow("同版参考图冲突");
    f.asset.metadata!.shortDrama!.assetProfile!.references = [{ nodeId: f.image.id, variant: "基准", signature: assetMediaSignature(f.image), selected: true }];
    expect(resolveEpisodeShotAssets(f.script, f.row, nodes).media.map(node => node.id)).toEqual([f.image.id]);
});
