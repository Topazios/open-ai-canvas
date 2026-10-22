import { expect, test } from "bun:test";
import { createCanvasNode, createStoryboardRow } from "@/lib/canvas/canvas-project-domain";
import { selectStoryboardFrameModel, storyboardFrameGenerationConfig, storyboardFrameNodeSelection } from "@/lib/canvas/storyboard-frame-model";
import { materializeStoryboardFrames, storyboardBoundaryFrames } from "@/lib/canvas/episode-storyboard-frames";
import { buildGenerationConfig } from "@/lib/canvas/canvas-project-generation";
import { synchronizeGenerationSpec } from "@/lib/canvas/generation-contract";
import { defaultConfig, normalizeConfigSnapshot, resolveModelRequestConfig } from "@/stores/use-config-store";
import { systemChannelModelChannels } from "@/lib/user-session";
import { defaultModelCapabilityConfig } from "@/lib/model-capabilities";
import { CanvasNodeType } from "@/types/canvas";

function fixture() {
    const modelKey = "fixture-image";
    const channels = systemChannelModelChannels(["selected", "previous"].map((id, index) => ({ id, name: id, displayName: id, models: [{
        id: `${id}-image`, modelKey, displayName: modelKey, channelLabel: id, description: "", icon: "", capability: "image" as const,
        protocol: "openai-image" as const, available: true, pricingMode: "provider" as const, priceLabel: "",
        capabilityConfig: defaultModelCapabilityConfig("openai-image", modelKey),
        priceTiers: [{ id: `${id}-tier`, selector: {}, resolution: "*", videoSeconds: 0, billingMode: "per_call" as const, unitPriceMicrocredits: index ? 1 : 100, inputTokenPriceMicrocredits: 0, outputTokenPriceMicrocredits: 0, cachedTokenPriceMicrocredits: 0 }],
    }] })));
    const config = normalizeConfigSnapshot({ config: { ...defaultConfig, channels, model: `selected::${modelKey}`, imageModel: `selected::${modelKey}` } }).config;
    const row = createStoryboardRow(1, { id: "shot", shotCode: "EP01-S01-001", durationSeconds: 10, videoMotionPrompt: "人物推门进入房间", assetKeys: [] });
    const script = createCanvasNode(CanvasNodeType.Script, { x: 0, y: 0 }, { storyboard: { rows: [row], visibleColumns: [], referenceNodeIds: [] }, shortDrama: { pipelineId: "p", stage: "storyboard", step: "direction.shots", role: "document", sourceNodeIds: [], sourceSignatures: {}, episodeNumber: 1 } });
    const image = synchronizeGenerationSpec(createCanvasNode(CanvasNodeType.Image, { x: 0, y: 0 }, { model: `previous::${modelKey}`, status: "error", taskId: "old-failed", taskStatus: "failed", storyboardFrame: { scriptId: script.id, rowId: row.id, frameId: "end", sourcePromptHash: "old" } }), { model: `previous::${modelKey}` });
    return { config, script, image, row, selected: `selected::${modelKey}`, previous: `previous::${modelKey}` };
}

test("episode selection replaces legacy and canonical channels on waiting/failed frames while preserving paid work", () => {
    const f = fixture();
    const running = { ...f.image, id: "running", metadata: { ...f.image.metadata, taskStatus: "running" as const } };
    const done = { ...f.image, id: "done", metadata: { ...f.image.metadata, taskStatus: "succeeded" as const, content: "saved-image" } };
    const recovering = { ...f.image, id: "recovering", metadata: { ...f.image.metadata, taskCanRecoverMedia: true } };
    const other = { ...f.image, id: "other", metadata: { ...f.image.metadata, storyboardFrame: { ...f.image.metadata!.storyboardFrame!, scriptId: "other-script" } } };
    const next = selectStoryboardFrameModel([f.script, f.image, running, done, recovering, other], f.script.id, "image", f.selected);
    const selected = next.find(node => node.id === f.image.id)!;
    expect(selected.metadata?.generationSpec?.modelSelection).toEqual({ kind: "channel", channelId: "selected", modelKey: "fixture-image" });
    expect(selected.metadata?.taskId).toBe("old-failed");
    expect(resolveModelRequestConfig(buildGenerationConfig(f.config, selected, "image"), f.selected).channelId).toBe("selected");
    for (const unchanged of [running, done, recovering, other]) expect(next.find(node => node.id === unchanged.id)).toBe(unchanged);
    const script = next.find(node => node.id === f.script.id)!;
    expect(storyboardFrameGenerationConfig({ ...f.config, imageModel: f.previous }, script, "image").model).toBe(f.selected);
    expect(storyboardFrameGenerationConfig(f.config, undefined, "image").model).toBe(f.selected);
});

test("failed-only rematerialization updates canonical selection instead of reviving the previous channel", () => {
    const f = fixture(), settings = { size: "1024x1024", quality: "auto", transparentBackground: "false" };
    const request = [{ row: f.row, frames: storyboardBoundaryFrames(f.row) }];
    const original = materializeStoryboardFrames(f.script, request, [f.script], [], f.previous, settings);
    const failed = original.nodes.map(node => node.metadata?.storyboardFrame ? { ...node, metadata: { ...node.metadata, taskId: `failed-${node.id}`, taskStatus: "failed" as const, status: "error" as const } } : node);
    const script = failed.find(node => node.id === f.script.id)!;
    const retry = materializeStoryboardFrames(script, request, failed, original.connections, f.selected, settings, { failedOnly: true });
    expect(retry.targets).toHaveLength(original.targets.length);
    for (const target of retry.targets) {
        const node = retry.nodes.find(node => node.id === target.nodeId)!;
        const selected = buildGenerationConfig(f.config, node, "image");
        expect(selected.model).toBe(f.selected);
        expect(resolveModelRequestConfig(selected, selected.model).channelId).toBe("selected");
    }
});

test("a deferred tail and single retry resolve the current episode channel when actually dispatched", () => {
    const f = fixture();
    const resolved = storyboardFrameNodeSelection(f.config, f.image, [f.script, f.image]);
    expect(resolved.metadata?.model).toBe(f.selected);
    expect(f.image.metadata?.model).toBe(f.previous);
    const pinned = selectStoryboardFrameModel([f.script, f.image], f.script.id, "image", f.previous);
    const resolvedPinned = storyboardFrameNodeSelection(f.config, f.image, pinned);
    expect(resolvedPinned.metadata?.model).toBe(f.previous);
    expect(() => storyboardFrameNodeSelection(f.config, f.image, [])).toThrow("分镜列表已删除");
});
