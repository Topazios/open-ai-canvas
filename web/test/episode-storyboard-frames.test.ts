import { expect, test } from "bun:test";
import { createCanvasNode, createStoryboardRow } from "@/lib/canvas/canvas-project-domain";
import { failedStoryboardBoundaryImageCount, failedStoryboardBoundaryImages, materializeStoryboardFrames, parseStoryboardKeyframes, shotKeyframes, storyboardBoundaryFrames, storyboardDisplayFrames, storyboardFrameHash, storyboardKeyframePrompt } from "@/lib/canvas/episode-storyboard-frames";
import { episodeShotBoundaryImages, storyboardPreviousFrameSource } from "@/lib/canvas/workflow-episode-storyboard";
import { storyboardRowReferenceNodeIds } from "@/lib/canvas/canvas-storyboard-materializer";
import { buildNodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import { CanvasNodeType, StoryboardStartFrameMode, type CanvasNodeData, type CanvasGenerationBatch } from "@/types/canvas";
import { generationBatchCandidates } from "@/lib/canvas/canvas-generation-batch";
import { freshRuntimeLimits } from "@/services/runtime-limits";
import { installRuntimeLimits } from "./fixtures/runtime-limits";
import { assetContentSignature, assetMediaSignature } from "@/lib/canvas/canvas-workflow-asset-profile";
import { buildCanvasCustomNodeScopes } from "@/pages/canvas/use-canvas-scoped-node-renderers";

const settings = { size: "16:9", quality: "standard", transparentBackground: "false" };
function fixture() {
    const rows = [1, 2].map(number => createStoryboardRow(number, { id: `shot-${number}`, shotCode: `S1-00${number}`, durationSeconds: 10, videoMotionPrompt: `镜头${number}：推门走进房间，转身放下相机。`, assetKeys: [] }));
    const script = createCanvasNode(CanvasNodeType.Script, { x: 100, y: 100 }, { storyboard: { rows, visibleColumns: [], referenceNodeIds: [] }, shortDrama: { pipelineId: "p", stage: "storyboard", step: "direction.shots", role: "document", sourceNodeIds: [], sourceSignatures: {}, episodeNumber: 2 } });
    const irrelevant = createCanvasNode(CanvasNodeType.Text, { x: 0, y: 0 }, { content: "不得带入的全量正文和其他集" });
    return { script, rows, nodes: [script, irrelevant] };
}
const boundaries = (f: ReturnType<typeof fixture>) => f.rows.map(row => ({ row, frames: storyboardBoundaryFrames(row) }));

test("ready tails wait when their shared start cannot yet be materialized", () => {
    const f = fixture();
    f.rows[0] = { ...f.rows[0], detailStatus: "planned", videoMotionPrompt: "", plotDescription: "", plannedGoal: "入场" };
    f.script.metadata!.storyboard!.rows = f.rows;
    expect(storyboardDisplayFrames(f.rows[0], f.nodes)).toEqual([]);
    expect(() => materializeStoryboardFrames(f.script, [{ row: f.rows[0], frames: storyboardBoundaryFrames(f.rows[0]) }], f.nodes, [], "image", settings)).toThrow();
    const result = materializeStoryboardFrames(f.script, [{ row: f.rows[1], frames: storyboardBoundaryFrames(f.rows[1]) }], f.nodes, [], "image", settings);
    expect(result.targets).toHaveLength(0);
    expect(result.nodes.find(node => node.id === f.script.id)!.metadata!.storyboard!.rows[1].frames!.some(frame => frame.kind === "start")).toBe(false);
});

test("first and last frame prompts use current shot and different static moments", () => {
    const { rows } = fixture();
    const frames = storyboardBoundaryFrames(rows[0]);
    expect(frames.map(frame => [frame.kind, frame.timeSeconds])).toEqual([["start", 0], ["end", 10]]);
    expect(frames[0].prompt).toContain("起始姿态"); expect(frames[1].prompt).toContain("最终姿态");
    for (const frame of frames) expect(frame.prompt).toContain(rows[0].videoMotionPrompt);
    expect(storyboardFrameHash({ ...rows[0], durationSeconds: 12 })).not.toBe(frames[0].sourcePromptHash);
});

test("keyframes accept multiple chronological static moments and reject invalid or invented assets", () => {
    const row = { ...fixture().rows[0], videoMotionPrompt: "CHR-0001推门走进房间", assetKeys: ["CHR-0001"] };
    const valid = JSON.stringify({ frames: [{ timeSeconds: 0, prompt: "CHR-0001正要推门" }, { timeSeconds: 8, prompt: "CHR-0001已经进门" }] });
    expect(parseStoryboardKeyframes(valid, row).map(frame => frame.id)).toEqual(["key-1", "key-2"]);
    expect(parseStoryboardKeyframes("```json\n" + valid + "\n```", row)).toHaveLength(2);
    for (const frames of [[], [{ timeSeconds: 11, prompt: "画面" }], [{ timeSeconds: 1, prompt: "画面" }, { timeSeconds: 1, prompt: "同一时间" }], [{ timeSeconds: 2, prompt: "CHR-9999出现" }], Array.from({ length: 9 }, (_, i) => ({ timeSeconds: i, prompt: "画面" }))]) expect(() => parseStoryboardKeyframes(JSON.stringify({ frames }), row)).toThrow();
    expect(() => parseStoryboardKeyframes("null", row)).toThrow();
    expect(storyboardKeyframePrompt(row)).toContain(row.videoMotionPrompt);
});

test("batch frames persist in one ordered grid and only include the individual shot context", () => {
    const f = fixture();
    const result = materializeStoryboardFrames(f.script, boundaries(f), f.nodes, [], "image-model", settings);
    expect(result.targets).toHaveLength(3);
    const group = result.nodes.find(node => node.metadata?.storyboardFramesGroup)!;
    const images = result.nodes.filter(node => node.parentId === group.id);
    expect(images).toHaveLength(3); expect(images.every(node => node.width === 280 && node.height === 280)).toBe(true);
    expect(images[0].position.y).toBe(images[1].position.y);
    expect(images[0].position.x).toBeLessThan(images[1].position.x);
    for (const image of images) {
        const ready = result.nodes.map(node => node.metadata?.storyboardFrame ? { ...node, metadata: { ...node.metadata, content: "data:image/png;base64,AA==", status: "success" as const } } : node);
        const context = buildNodeGenerationContext(image.id, ready, result.connections, image.metadata!.composerContent!, []);
        expect(context.prompt).not.toContain("不得带入");
        expect(context.prompt).not.toContain(image.metadata!.storyboardFrame!.rowId === "shot-1" ? "镜头2：" : "镜头1：");
        expect(image.metadata!.shortDrama!.mediaKind).toBe("image");
    }
    const persisted = JSON.parse(JSON.stringify(result.nodes)) as CanvasNodeData[];
    const script = persisted.find(node => node.id === f.script.id)!;
    expect(script.metadata!.storyboard!.rows.every(row => row.frames?.length === 2)).toBe(true);
    const resumed = materializeStoryboardFrames(script, boundaries(f), persisted, result.connections, "image-model", settings);
    expect(resumed.nodes.filter(node => node.metadata?.storyboardFramesGroup)).toHaveLength(1);
    expect(resumed.targets.map(target => target.nodeId)).toEqual(result.targets.map(target => target.nodeId));
});

test("completed, failed and waiting frames are never silently billed again; edits create another version", () => {
    const f = fixture();
    const result = materializeStoryboardFrames(f.script, boundaries(f), f.nodes, [], "image-model", settings);
    const script = result.nodes.find(node => node.id === f.script.id)!;
    const ids = result.targets.map(target => target.nodeId);
    const nodes = result.nodes.map(node => node.id === ids[0] ? { ...node, metadata: { ...node.metadata, status: "success" as const, content: "data:image/png;base64,AA==" } } : node.id === ids[1] ? { ...node, metadata: { ...node.metadata, status: "error" as const, taskId: "failed-paid-task", taskStatus: "failed" as const } } : node);
    script.metadata!.generationBatches = [{ id: "queued", mode: "storyboard_image", projectId: "p", sourceNodeId: script.id, status: "queued", createdAt: "", updatedAt: "", items: ids.slice(2).map(nodeId => ({ id: nodeId, nodeId, rowId: "shot-2", status: "waiting", retryCount: 0 })) }];
    expect(materializeStoryboardFrames(script, boundaries(f), nodes, result.connections, "another-model", settings).targets).toHaveLength(0);
    const edited = { ...f.rows[0], videoMotionPrompt: "改为窗前拿起相机" };
    const changed = materializeStoryboardFrames(script, [{ row: edited, frames: storyboardBoundaryFrames(edited) }], nodes, result.connections, "image-model", settings);
    expect(changed.targets).toHaveLength(2);
    expect(changed.targets.every(target => !ids.includes(target.nodeId))).toBe(true);
    expect(changed.nodes.some(node => node.id === ids[0] && node.metadata?.content)).toBe(true);
});

test("pre-submission frame failures can be resubmitted in place without duplicating images", () => {
    const f = fixture();
    const first = materializeStoryboardFrames(f.script, boundaries(f), f.nodes, [], "image-model", settings);
    const failed = first.nodes.map(node => node.metadata?.storyboardFrame ? { ...node, metadata: { ...node.metadata, status: "error" as const, errorDetails: "提示词超长" } } : node);
    const script = failed.find(node => node.id === f.script.id)!;
    const retry = materializeStoryboardFrames(script, boundaries(f), failed, first.connections, "image-model", settings);
    expect(retry.targets.map(target => target.nodeId)).toEqual(first.targets.map(target => target.nodeId));
    expect(retry.nodes.filter(node => node.metadata?.storyboardFrame)).toHaveLength(3);
    expect(retry.nodes.filter(node => node.metadata?.storyboardFrame).every(node => node.metadata?.status === "idle" && !node.metadata.errorDetails)).toBe(true);
});

test("explicit boundary retry deduplicates shared failures and preserves successful and running images", () => {
    const f = fixture();
    const first = materializeStoryboardFrames(f.script, boundaries(f), f.nodes, [], "image-model", settings);
    const [done, failed, running] = first.targets;
    const nodes = first.nodes.map(node => node.id === done.nodeId ? { ...node, metadata: { ...node.metadata, status: "success" as const, content: "saved-image", taskId: "done", taskStatus: "succeeded" as const } } : node.id === failed.nodeId ? { ...node, metadata: { ...node.metadata, status: "error" as const, taskId: "failed", taskStatus: "failed" as const, errorDetails: "模型服务响应超时，请稍后重试" } } : node.id === running.nodeId ? { ...node, metadata: { ...node.metadata, status: "loading" as const, taskId: "running", taskStatus: "running" as const } } : node);
    const script = nodes.find(node => node.id === f.script.id)!;
    expect(failedStoryboardBoundaryImages(script, nodes).map(node => node.id)).toEqual([failed.nodeId]);
    const retried = materializeStoryboardFrames(script, boundaries(f), nodes, first.connections, "retry-model", settings, { failedOnly: true });
    expect(retried.targets.map(target => target.nodeId)).toEqual([failed.nodeId]);
    expect(retried.nodes.filter(node => node.metadata?.storyboardFrame)).toHaveLength(3);
    for (const id of [done.nodeId, running.nodeId]) expect(retried.nodes.find(node => node.id === id)).toEqual(nodes.find(node => node.id === id));
    expect(retried.nodes.find(node => node.id === failed.nodeId)?.metadata).toMatchObject({ model: "retry-model", status: "idle" });
    expect(retried.nodes.find(node => node.id === failed.nodeId)?.metadata?.taskId).toBeUndefined();
    const rows = retried.nodes.find(node => node.id === script.id)!.metadata!.storyboard!.rows;
    expect(rows[1].frames?.find(frame => frame.kind === "start")?.imageNodeId).toBe(failed.nodeId);
});

test("failed boundary count includes blocked failed frames while retry selection stays deduplicated", () => {
    const f = fixture();
    const first = materializeStoryboardFrames(f.script, boundaries(f), f.nodes, [], "image-model", settings);
    const [root, descendant, independent] = first.targets;
    const nodes = first.nodes.map(node => {
        if (node.id === root.nodeId || node.id === descendant.nodeId || node.id === independent.nodeId) return { ...node, metadata: { ...node.metadata, status: "error" as const, taskStatus: "failed" as const, taskId: `failed-${node.id}`, errorDetails: node.id === descendant.nodeId ? "首帧生成失败，请先重试首帧" : "生成失败" } };
        return node;
    });
    const script = nodes.find(node => node.id === f.script.id)!;
    expect(failedStoryboardBoundaryImageCount(script, nodes)).toBe(3);
    expect(failedStoryboardBoundaryImages(script, nodes).map(node => node.id)).toEqual([root.nodeId, independent.nodeId]);
    const retry = materializeStoryboardFrames(script, boundaries(f), nodes, first.connections, "image-model", settings, { failedOnly: true });
    expect(retry.targets.map(target => target.nodeId)).toContain(root.nodeId);
    expect(retry.targets.map(target => target.nodeId)).toContain(independent.nodeId);
    expect(new Set(retry.targets.map(target => target.nodeId)).size).toBe(retry.targets.length);
});

test("failed-only retry excludes queued targets and stale versions without creating frames", () => {
    const f = fixture();
    expect(materializeStoryboardFrames(f.script, boundaries(f), f.nodes, [], "image-model", settings, { failedOnly: true }).targets).toEqual([]);
    const first = materializeStoryboardFrames(f.script, boundaries(f), f.nodes, [], "image-model", settings);
    const nodes = first.nodes.map(node => node.metadata?.storyboardFrame ? { ...node, metadata: { ...node.metadata, status: "error" as const, taskStatus: "failed" as const, taskId: `failed-${node.id}` } } : node);
    const script = nodes.find(node => node.id === f.script.id)!;
    script.metadata!.generationBatches = [{ id: "queued-retry", projectId: "p", sourceNodeId: script.id, mode: "storyboard_image", status: "queued", createdAt: "", updatedAt: "", items: first.targets.map(target => ({ ...target, id: target.nodeId, status: "waiting", retryCount: 0 })) }];
    expect(failedStoryboardBoundaryImages(script, nodes)).toEqual([]);
    expect(materializeStoryboardFrames(script, boundaries(f), nodes, first.connections, "image-model", settings, { failedOnly: true }).targets).toEqual([]);
    script.metadata!.generationBatches = [];
    script.metadata!.storyboard!.rows = script.metadata!.storyboard!.rows.map(row => ({ ...row, videoMotionPrompt: "已修改的镜头内容" }));
    expect(failedStoryboardBoundaryImages(script, nodes)).toEqual([]);
    const requests = script.metadata!.storyboard!.rows.map(row => ({ row, frames: storyboardBoundaryFrames(row) }));
    expect(materializeStoryboardFrames(script, requests, nodes, first.connections, "image-model", settings, { failedOnly: true }).targets).toEqual([]);
});

test("frame requests project visual asset sections without carrying story or voice dossiers", () => {
    for (const [kind, field, visual] of [
        ["character", "年龄感、体型、面部与辨识特征", "青年，灰色短发，左眼下有痣"],
        ["environment", "空间布局、尺度与固定陈设", "狭长走廊，东侧木门，西侧窗户"],
        ["prop", "道具形状、尺寸、比例与辨识特征", "黑色方形相机，银色圆形镜头"],
    ] as const) {
        const f = fixture();
        const code = kind === "character" ? "CHR-0001" : kind === "environment" ? "SCN-0001" : "PRP-0001";
        const content = `## ${field}\n${visual}\n\n## 人物经历与关键成因\n${"与静态画面无关的全剧经历。".repeat(4000)}\n\n## 声线音色、质感与辨识点\n不得混入的声音细节`;
        const asset = createCanvasNode(CanvasNodeType.Text, { x: 0, y: 0 }, { status: "success", content, shortDrama: { ...f.script.metadata!.shortDrama!, step: "story.plan", assetIdentity: { id: "identity", code, kind } } });
        f.script.metadata!.shortDrama!.sourceNodeIds = [asset.id];
        f.rows[0].assetKeys = [code];
        const result = materializeStoryboardFrames(f.script, [{ row: f.rows[0], frames: storyboardBoundaryFrames(f.rows[0]) }], [...f.nodes, asset], [], "image-model", settings);
        for (const target of result.targets) {
            const image = result.nodes.find(node => node.id === target.nodeId)!;
            const ready = result.nodes.map(node => node.metadata?.storyboardFrame ? { ...node, metadata: { ...node.metadata, content: "data:image/png;base64,AA==", status: "success" as const } } : node);
            const context = buildNodeGenerationContext(image.id, ready, result.connections, image.metadata!.composerContent!, []);
            expect(context.prompt).toContain(visual);
            expect(context.prompt).toContain(code);
            expect(context.prompt).not.toContain("全剧经历");
            expect(context.prompt).not.toContain("声音细节");
            expect(context.prompt.length).toBeLessThan(2600);
        }
        expect(asset.metadata!.content).toBe(content);
    }
});

test("prompt upgrades preserve completed and in-flight legacy boundary nodes and retry failures in place", () => {
    const f = fixture();
    const first = materializeStoryboardFrames(f.script, boundaries(f), f.nodes, [], "image-model", settings);
    const [done, failed, running] = first.targets;
    const nodes = first.nodes.map(node => {
        if (node.id === f.script.id) return { ...node, metadata: { ...node.metadata, storyboard: { ...node.metadata!.storyboard!, rows: node.metadata!.storyboard!.rows.map(row => ({ ...row, frames: row.frames?.map(frame => ({ ...frame, prompt: "旧版自动提示词，混合多个动作" })) })) } } };
        if (!node.metadata?.storyboardFrame) return node;
        return { ...node, metadata: { ...node.metadata, composerContent: "旧版自动提示词，混合多个动作", taskId: `original-${node.id}`, taskStatus: node.id === done.nodeId ? "succeeded" as const : node.id === failed.nodeId ? "failed" as const : "running" as const, status: node.id === done.nodeId ? "success" as const : node.id === failed.nodeId ? "error" as const : "loading" as const, content: node.id === done.nodeId ? "saved" : undefined } };
    });
    const script = nodes.find(node => node.id === f.script.id)!;
    const unchanged = materializeStoryboardFrames(script, boundaries(f), nodes, first.connections, "image-model", settings);
    expect(unchanged.targets).toHaveLength(0);
    const retried = materializeStoryboardFrames(script, boundaries(f), nodes, first.connections, "image-model", settings, { failedOnly: true });
    expect(retried.targets.map(item => item.nodeId)).toEqual([failed.nodeId]);
    expect(retried.nodes.filter(node => node.metadata?.storyboardFrame)).toHaveLength(3);
    for (const id of [done.nodeId, running.nodeId]) expect(retried.nodes.find(node => node.id === id)).toEqual(nodes.find(node => node.id === id));
    const context = buildNodeGenerationContext(failed.nodeId, nodes, first.connections, "旧版自动提示词，混合多个动作", []);
    expect(context.prompt).not.toContain("旧版自动提示词");
    expect(context.prompt).toContain("镜头空间与构图");
    expect(context.prompt).toContain("最终姿态");
    expect(nodes.find(node => node.id === failed.nodeId)?.metadata?.taskId).toBe(`original-${failed.nodeId}`);
});

test("frame image labels map to their selected asset identities without changing reference order", () => {
    const f = fixture();
    const asset = createCanvasNode(CanvasNodeType.Text, { x: 0, y: 0 }, { status: "success", content: "## 年龄感、体型、面部与辨识特征\n成年，短发", shortDrama: { ...f.script.metadata!.shortDrama!, assetIdentity: { id: "identity", code: "CHR-0001", kind: "character" } } });
    const image = createCanvasNode(CanvasNodeType.Image, { x: 0, y: 0 }, { status: "success", content: "data:image/png;base64,AA==", shortDrama: { ...asset.metadata!.shortDrama!, mediaKind: "image", mediaSubjectId: asset.id, sourceSignatures: { [asset.id]: "" } } });
    // Use explicit selection so this also covers uploaded references without a media owner.
    image.metadata!.shortDrama = undefined;
    asset.metadata!.shortDrama!.assetProfile = { indexContent: assetContentSignature(asset.metadata!.content!), aliases: [], occurrences: [], sounds: [], conflicts: [], variants: [], references: [{ nodeId: image.id, variant: "基准", selected: true, signature: assetMediaSignature(image) }] };
    f.script.metadata!.shortDrama!.sourceNodeIds = [asset.id];
    f.rows[0].assetKeys = ["CHR-0001"];
    const result = materializeStoryboardFrames(f.script, [{ row: f.rows[0], frames: storyboardBoundaryFrames(f.rows[0]) }], [...f.nodes, asset, image], [], "image-model", settings);
    const frame = result.nodes.find(node => node.id === result.targets[0].nodeId)!;
    const context = buildNodeGenerationContext(frame.id, result.nodes, result.connections, frame.metadata!.composerContent!, []);
    expect(context.referenceImages.map(image => image.id)).toEqual([image.id]);
    expect(context.prompt).toContain("@图片1：CHR-0001");
    expect(context.prompt).toContain("只取外观");
});

test("stale keyframe extraction cannot feed image tasks and current first/end automatically feed video", () => {
    const f = fixture(), row = f.rows[0];
    const plan = createCanvasNode(CanvasNodeType.Text, { x: 0, y: 0 }, { status: "success", content: JSON.stringify({ frames: [{ timeSeconds: 3, prompt: "举起相机的瞬间" }] }), storyboardFramePlan: { scriptId: f.script.id, rowId: row.id, sourcePromptHash: storyboardFrameHash(row) } });
    expect(shotKeyframes({ ...row, framePlanNodeId: plan.id }, [plan]).frames).toHaveLength(1);
    expect(shotKeyframes({ ...row, videoMotionPrompt: "已经改了", framePlanNodeId: plan.id }, [plan]).error).toContain("已修改");
    const result = materializeStoryboardFrames(f.script, boundaries(f), f.nodes, [], "image-model", settings);
    const nodes = result.nodes.map(node => node.metadata?.storyboardFrame ? { ...node, metadata: { ...node.metadata, status: "success" as const, content: "data:image/png;base64,AA==" } } : node);
    const script = nodes.find(node => node.id === f.script.id)!;
    const currentRow = script.metadata!.storyboard!.rows[0];
    expect(episodeShotBoundaryImages(currentRow, nodes).map(frame => frame.kind)).toEqual(["start", "end"]);
    expect(storyboardRowReferenceNodeIds(script, currentRow, nodes, result.connections, true)).toEqual(currentRow.frames!.map(frame => frame.imageNodeId!));
    expect(episodeShotBoundaryImages({ ...currentRow, durationSeconds: 12 }, nodes)).toEqual([]);
});

test("paused frames remain resumable in place while failed frames need explicit retry", () => {
    const f = fixture(), result = materializeStoryboardFrames(f.script, boundaries(f), f.nodes, [], "image-model", settings);
    const script = result.nodes.find(node => node.id === f.script.id)!;
    const [paused, failed] = result.targets;
    const nodes = result.nodes.map(node => node.id === paused.nodeId ? { ...node, metadata: { ...node.metadata, taskId: "cancelled", taskStatus: "cancelled" as const, status: "idle" as const } } : node.id === failed.nodeId ? { ...node, metadata: { ...node.metadata, taskId: "failed", taskStatus: "failed" as const, status: "error" as const } } : node);
    const resumed = materializeStoryboardFrames(script, boundaries(f), nodes, result.connections, "image-model", settings);
    expect(resumed.targets.some(target => target.nodeId === paused.nodeId)).toBe(true);
    expect(resumed.targets.some(target => target.nodeId === failed.nodeId)).toBe(false);
    expect(resumed.nodes.filter(node => node.metadata?.storyboardFrame)).toHaveLength(3);
});

test("adjacent boundaries share one image and task, including failure and cancelled resume", () => {
    const f = fixture(), result = materializeStoryboardFrames(f.script, boundaries(f), f.nodes, [], "image-model", settings);
    const script = result.nodes.find(node => node.id === f.script.id)!;
    const [a, b] = script.metadata!.storyboard!.rows;
    const end = a.frames!.find(frame => frame.kind === "end")!, start = b.frames!.find(frame => frame.kind === "start")!;
    expect(start.imageNodeId).toBe(end.imageNodeId);
    expect(start.sharedFrom).toEqual({ rowId: a.id, sourcePromptHash: storyboardFrameHash(a) });
    const complete = result.nodes.map(node => node.metadata?.storyboardFrame ? { ...node, metadata: { ...node.metadata, status: "success" as const, content: "image" } } : node);
    expect(episodeShotBoundaryImages(b, complete)[0].node.id).toBe(end.imageNodeId!);
    expect(storyboardRowReferenceNodeIds(script, b, complete, result.connections, true)).toEqual(b.frames!.map(frame => frame.imageNodeId!));
    for (const taskStatus of ["failed", "cancelled"] as const) {
        const nodes = complete.map(node => node.id === end.imageNodeId ? { ...node, metadata: { ...node.metadata, content: undefined, taskStatus, status: "error" as const, taskId: "shared-task" } } : node);
        const resumed = materializeStoryboardFrames(script, boundaries(f), nodes, result.connections, "image-model", settings);
        expect(resumed.targets.map(target => target.nodeId)).toEqual(taskStatus === "cancelled" ? [end.imageNodeId!] : []);
    }
});

test("shared frames reject upstream edits, removed or reordered shots and independent overrides", () => {
    const f = fixture(), result = materializeStoryboardFrames(f.script, boundaries(f), f.nodes, [], "image-model", settings);
    const script = result.nodes.find(node => node.id === f.script.id)!;
    const [a, b] = script.metadata!.storyboard!.rows;
    const nodes = result.nodes.map(node => node.metadata?.storyboardFrame ? { ...node, metadata: { ...node.metadata, content: "image" } } : node);
    const withRows = (rows: typeof f.rows) => nodes.map(node => node.id === script.id ? { ...script, metadata: { ...script.metadata, storyboard: { ...script.metadata!.storyboard!, rows } } } : node);
    for (const rows of [[{ ...a, videoMotionPrompt: "新的动作" }, b], [b, a], [b]]) expect(episodeShotBoundaryImages(b, withRows(rows)).map(frame => frame.kind)).toEqual(["end"]);
    const independent = { ...b, startFrameMode: StoryboardStartFrameMode.Independent };
    expect(episodeShotBoundaryImages(independent, withRows([a, independent])).map(frame => frame.kind)).toEqual(["end"]);
    const changedScript = withRows([a, independent]).find(node => node.id === script.id)!;
    const changed = materializeStoryboardFrames(changedScript, [{ row: independent, frames: storyboardBoundaryFrames(independent) }], withRows([a, independent]), result.connections, "image-model", settings);
    expect(changed.targets).toHaveLength(1);
    expect(changed.targets[0].nodeId).not.toBe(a.frames!.find(frame => frame.kind === "end")!.imageNodeId!);
    expect(changed.nodes.some(node => node.id === b.frames![0].imageNodeId)).toBe(true);
});

test("automatic exceptions and explicit continuity choices respect first shot boundaries", () => {
    const f = fixture(), [a, b] = f.rows;
    expect(storyboardPreviousFrameSource(a, f.rows)).toBeUndefined();
    expect(storyboardPreviousFrameSource(b, f.rows)?.id).toBe(a.id);
    const before = { ...a, assetKeys: ["SCN-001"] }, after = { ...b, assetKeys: ["SCN-002"] };
    expect(storyboardPreviousFrameSource(after, [before, after])).toBeUndefined();
    expect(storyboardPreviousFrameSource(b, [{ ...a, continuityOut: "闪回到童年" }, b])).toBeUndefined();
    expect(storyboardPreviousFrameSource(b, [{ ...a, continuityOut: "无需转场，动作连续" }, b])?.id).toBe(a.id);
    const forced = { ...after, startFrameMode: StoryboardStartFrameMode.ReusePrevious };
    expect(storyboardPreviousFrameSource(forced, [before, forced])?.id).toBe(a.id);
    f.rows[1] = { ...b, startFrameMode: StoryboardStartFrameMode.Independent };
    f.script.metadata!.storyboard!.rows = f.rows;
    expect(materializeStoryboardFrames(f.script, boundaries(f), f.nodes, [], "image-model", settings).targets).toHaveLength(4);
});

test("requesting later shot boundaries alone also materializes its preceding end once", () => {
    const f = fixture(), row = f.rows[1];
    const result = materializeStoryboardFrames(f.script, [{ row, frames: storyboardBoundaryFrames(row) }], f.nodes, [], "image-model", settings);
    expect(result.targets).toHaveLength(3);
    expect(result.targets.map(target => target.rowId)).toEqual([f.rows[0].id, f.rows[0].id, row.id]);
    const rows = result.nodes.find(node => node.id === f.script.id)!.metadata!.storyboard!.rows;
    expect(rows[1].frames![0].imageNodeId).toBe(rows[0].frames!.find(frame => frame.kind === "end")!.imageNodeId!);
});

test("existing independent images are preserved when linking completed adjacent frames without paid work", () => {
    const f = fixture();
    f.rows[1] = { ...f.rows[1], startFrameMode: StoryboardStartFrameMode.Independent };
    f.script.metadata!.storyboard!.rows = f.rows;
    const legacy = materializeStoryboardFrames(f.script, boundaries(f), f.nodes, [], "image-model", settings);
    const nodes = legacy.nodes.map(node => node.id === f.script.id ? { ...node, metadata: { ...node.metadata, storyboard: { ...node.metadata!.storyboard!, rows: node.metadata!.storyboard!.rows.map(row => ({ ...row, startFrameMode: StoryboardStartFrameMode.Auto })) } } } : node.metadata?.storyboardFrame ? { ...node, metadata: { ...node.metadata, content: "old-image", status: "success" as const } } : node);
    const script = nodes.find(node => node.id === f.script.id)!;
    const requests = script.metadata!.storyboard!.rows.map(row => ({ row, frames: storyboardBoundaryFrames(row) })).reverse();
    const linked = materializeStoryboardFrames(script, requests, nodes, legacy.connections, "image-model", settings);
    expect(linked.targets).toEqual([]);
    expect(linked.nodes.filter(node => node.metadata?.storyboardFrame && node.metadata.content)).toHaveLength(4);
    const [a, b] = linked.nodes.find(node => node.id === script.id)!.metadata!.storyboard!.rows;
    expect(b.frames![0].imageNodeId).toBe(a.frames![1].imageNodeId!);
});

test("keyframe extraction uses independent global text slots and survives batch pause/reload", () => {
    installRuntimeLimits({ text: 3, image: 4, video: 2 }, 0);
    const f = fixture();
    const nodes = Array.from({ length: 5 }, (_, i) => ({ ...createCanvasNode(CanvasNodeType.Text, { x: 0, y: 0 }), id: `plan-${i}` }));
    const batch: CanvasGenerationBatch = { id: "keyframes", projectId: "p", sourceNodeId: f.script.id, mode: "storyboard_keyframes", status: "queued", createdAt: "", updatedAt: "", items: nodes.map(node => ({ id: node.id, rowId: "shot", nodeId: node.id, status: "waiting", retryCount: 0 })) };
    f.script.metadata!.generationBatches = [batch];
    const selected = generationBatchCandidates([f.script, ...nodes], "p", freshRuntimeLimits()!, [{ type: "canvas_text", status: "running" }, { type: "canvas_image", status: "running" }], { image: 4, video: 2, text: 1 });
    expect(selected).toHaveLength(1); expect(selected[0].batch.mode).toBe("storyboard_keyframes");
    batch.paused = true;
    expect(generationBatchCandidates(JSON.parse(JSON.stringify([f.script, ...nodes])), "p", freshRuntimeLimits()!, [], { image: 0, video: 0 })).toEqual([]);
});

test("gallery displays boundary placeholders and current extracted frames while rejecting stale images", () => {
    const f = fixture(), row = f.rows[0];
    expect(storyboardDisplayFrames(row, f.nodes).map(frame => frame.kind)).toEqual(["start", "end"]);
    const plan = createCanvasNode(CanvasNodeType.Text, { x: 0, y: 0 }, { status: "success", content: JSON.stringify({ frames: [{ timeSeconds: 3, prompt: "举起相机" }, { timeSeconds: 6, prompt: "放下相机" }] }), storyboardFramePlan: { scriptId: f.script.id, rowId: row.id, sourcePromptHash: storyboardFrameHash(row) } });
    const extracted = { ...row, framePlanNodeId: plan.id };
    f.script.metadata!.storyboard!.rows[0] = extracted;
    const boundariesResult = materializeStoryboardFrames(f.script, boundaries(f), [...f.nodes, plan], [], "image-model", settings);
    const script = boundariesResult.nodes.find(node => node.id === f.script.id)!;
    const current = script.metadata!.storyboard!.rows[0];
    const withKeys = materializeStoryboardFrames(script, [{ row: current, frames: shotKeyframes(current, boundariesResult.nodes).frames }], boundariesResult.nodes, boundariesResult.connections, "image-model", settings);
    const persisted = withKeys.nodes.find(node => node.id === script.id)!.metadata!.storyboard!.rows[0];
    const visible = storyboardDisplayFrames(persisted, withKeys.nodes);
    expect(visible.map(frame => frame.kind)).toEqual(["start", "end", "key", "key"]);
    expect(visible.every(frame => frame.imageNodeId)).toBe(true);
    const changed = storyboardDisplayFrames({ ...persisted, videoMotionPrompt: "剧情修改" }, withKeys.nodes);
    expect(changed).toHaveLength(2);
    expect(changed.every(frame => !frame.imageNodeId)).toBe(true);
});

test("scoped canvas rendering keeps the source table needed to validate a shared first frame", () => {
    const f = fixture(), result = materializeStoryboardFrames(f.script, boundaries(f), f.nodes, [], "image-model", settings);
    const nodes = result.nodes.map(node => node.metadata?.storyboardFrame ? { ...node, metadata: { ...node.metadata, content: "image" } } : node);
    const script = nodes.find(node => node.id === f.script.id)!;
    const scope = buildCanvasCustomNodeScopes({ nodes, visibleNodes: [script], connections: result.connections, mentionReferencesByNodeId: new Map(), configInputsById: new Map(), runningNodeId: null }).get(script.id)!;
    expect(scope.nodes.some(node => node.id === script.id)).toBe(true);
    expect(scope.nodes.some(node => node.id === f.nodes[1].id)).toBe(false);
    expect(episodeShotBoundaryImages(script.metadata!.storyboard!.rows[1], scope.nodes)).toHaveLength(2);
});
