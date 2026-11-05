import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasEpisodeFrameGallery } from "@/components/canvas/canvas-episode-frame-gallery";
import { createCanvasNode, createStoryboardRow } from "@/lib/canvas/canvas-project-domain";
import { materializeStoryboardFrames, storyboardBoundaryFrames, storyboardFrameHash } from "@/lib/canvas/episode-storyboard-frames";
import { storyboardFrameTrack, storyboardFrameTrackKey, storyboardFrameTrackLabel, storyboardFrameTrackSelection, storyboardFrameTrackTargets } from "@/lib/canvas/storyboard-frame-track";
import { storyboardFramePrerequisite, storyboardContinuitySnapshot } from "@/lib/canvas/storyboard-frame-continuity";
import { storyboardFrameIsCurrent } from "@/lib/canvas/workflow-episode-storyboard";
import { CanvasNodeType, StoryboardFrameKind, StoryboardStartFrameMode, type CanvasNodeData } from "@/types/canvas";

const settings = { size: "16:9", quality: "standard", transparentBackground: "false" };
function fixture() {
    const rows = [1, 2, 3].map(number => createStoryboardRow(number, { id: `row-${number}`, sceneId: "S01", shotCode: `EP001-S01-00${number}`, videoMotionPrompt: `人物放下相机，镜头${number}`, durationSeconds: 10 }));
    const script = createCanvasNode(CanvasNodeType.Script, { x: 0, y: 0 }, { storyboard: { rows, visibleColumns: [], referenceNodeIds: [] }, shortDrama: { pipelineId: "p", stage: "storyboard", step: "direction.shots", role: "document", sourceNodeIds: [], sourceSignatures: {} } });
    return { rows, script, nodes: [script] };
}

test("shared boundary placeholders appear once, in sequence, with both shot roles", () => {
    const f = fixture();
    const track = storyboardFrameTrack(f.rows, f.nodes);
    expect(track.map(storyboardFrameTrackLabel)).toEqual(["首帧", "关键帧", "首尾帧", "关键帧", "首尾帧", "关键帧", "尾帧"]);
    expect(track[2].usages.map(usage => [usage.shot, usage.kind])).toEqual([["镜头 01", "end"], ["镜头 02", "start"]]);
    expect(track.filter(item => item.needsPlan)).toHaveLength(3);
    expect(storyboardFrameTrackTargets(track, [], "boundary")).toHaveLength(4);
    expect(storyboardFrameTrackTargets(track, [], "keyframes")).toHaveLength(3);
    expect(storyboardFrameTrackTargets(track, [])).toHaveLength(7);
});

test("scene changes and independent starts stay distinct, while camera changes share the boundary", () => {
    for (const patch of [{ sceneId: "S02" }, { sceneId: undefined, shotCode: "EP001-S02-002" }, { startFrameMode: StoryboardStartFrameMode.Independent }]) {
        const f = fixture();
        f.rows[0].camera = "正面";
        Object.assign(f.rows[1], patch);
        const track = storyboardFrameTrack(f.rows, f.nodes);
        expect(track.find(item => item.id === storyboardFrameTrackKey(f.rows[0].id, "end"))!.usages).toHaveLength(1);
        expect(track.some(item => item.id === storyboardFrameTrackKey(f.rows[1].id, "start"))).toBe(true);
    }
    const f = fixture();
    f.rows[0].camera = "正面近景";
    f.rows[1].camera = "侧面中景";
    const shared = storyboardFrameTrack(f.rows, f.nodes).find(item => item.id === storyboardFrameTrackKey(f.rows[0].id, "end"));
    expect(shared?.usages.map(usage => usage.kind)).toEqual(["end", "start"]);
});

test("frame selections resolve exact owner-frame pairs and never widen to every matching local id", () => {
    const f = fixture();
    const track = storyboardFrameTrack(f.rows, f.nodes);
    const selected = [storyboardFrameTrackKey(f.rows[1].id, "end")];
    const frameTargets = storyboardFrameTrackTargets(track, selected, "boundary");
    expect(frameTargets).toEqual([{ rowId: f.rows[1].id, frameId: "end" }]);
    expect(storyboardFrameTrackTargets(track, selected, "keyframes")).toEqual([]);
    const result = materializeStoryboardFrames(f.script, f.rows.map(row => ({ row, frames: storyboardBoundaryFrames(row) })), f.nodes, [], "image", settings, { frameTargets });
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0].rowId).toBe(f.rows[1].id);
    const image = result.nodes.find(node => node.id === result.targets[0].nodeId)!;
    expect(storyboardFramePrerequisite(image, result.nodes)).toEqual({ ready: true, reason: "" });
    const rows = result.nodes.find(node => node.id === f.script.id)!.metadata!.storyboard!.rows;
    expect(rows[0].frames).toBeUndefined();
    expect(rows[1].frames?.map(frame => frame.id)).toEqual(["end"]);
    expect(rows[2].frames?.find(frame => frame.id === "start")?.imageNodeId).toBe(image.id);
});

test("selecting both roles of a shared frame submits one task and rebinds unselected consumers", () => {
    const f = fixture();
    const first = materializeStoryboardFrames(f.script, f.rows.map(row => ({ row, frames: storyboardBoundaryFrames(row) })), f.nodes, [], "image", settings);
    const nodes = first.nodes.map(node => node.metadata?.storyboardFrame ? { ...node, metadata: { ...node.metadata, status: "success" as const, content: `data:image/png;base64,${node.id}` } } : node);
    const script = nodes.find(node => node.id === f.script.id)!;
    const rows = script.metadata!.storyboard!.rows;
    const old = rows[0].frames!.find(frame => frame.id === "end")!.imageNodeId;
    const targets = [{ rowId: rows[0].id, frameId: "end" }, { rowId: rows[1].id, frameId: "start" }];
    for (const frameTargets of [targets, [targets[0]], [targets[1]]]) {
        const requests = rows.filter(row => frameTargets.some(target => target.rowId === row.id)).map(row => ({ row, frames: storyboardBoundaryFrames(row) })).reverse();
        const result = materializeStoryboardFrames(script, requests, nodes, [], "image", settings, { regenerate: true, frameTargets });
        expect(result.targets).toHaveLength(1);
        expect(result.targets[0].rowId).toBe(rows[0].id);
        const updated = result.nodes.find(node => node.id === script.id)!.metadata!.storyboard!.rows;
        const end = updated[0].frames!.find(frame => frame.id === "end")!;
        const start = updated[1].frames!.find(frame => frame.id === "start")!;
        expect(start.imageNodeId).toBe(end.imageNodeId);
        expect(start.imageNodeId).not.toBe(old);
        expect(storyboardFrameIsCurrent(updated[1], start, result.nodes)).toBe(true);
        expect(result.nodes.find(node => node.id === old)?.metadata?.content).toBeTruthy();
        expect(updated[1].frames!.find(frame => frame.id === "end")).toEqual(rows[1].frames!.find(frame => frame.id === "end"));
    }
});

test("a tail can submit while its start is absent, running, failed or cancelled", () => {
    for (const state of [undefined, "running", "failed", "cancelled"] as const) {
        const f = fixture();
        const row = f.rows[0];
        let nodes: CanvasNodeData[] = f.nodes;
        let script = f.script;
        if (state) {
            const start = materializeStoryboardFrames(script, [{ row, frames: storyboardBoundaryFrames(row) }], nodes, [], "image", settings, { frameIds: ["start"] });
            nodes = start.nodes.map(node => node.metadata?.storyboardFrame ? { ...node, metadata: { ...node.metadata, taskStatus: state, status: state === "running" ? "loading" as const : state === "failed" ? "error" as const : "idle" as const } } : node);
            script = nodes.find(node => node.id === script.id)!;
        }
        const result = materializeStoryboardFrames(script, [{ row, frames: storyboardBoundaryFrames(row) }], nodes, [], "image", settings, { frameTargets: [{ rowId: row.id, frameId: "end" }] });
        expect(result.targets).toHaveLength(1);
        const image = result.nodes.find(node => node.id === result.targets[0].nodeId)!;
        expect(image.metadata?.storyboardFrame?.frameId).toBe("end");
        expect(storyboardFramePrerequisite(image, result.nodes)).toEqual({ ready: true, reason: "" });
        expect(storyboardFramePrerequisite(image, result.nodes.filter(node => node.id !== script.id)).ready).toBe(false);
    }
});

test("new start versions preserve independently completed tails and their original reference provenance", () => {
    const f = fixture();
    const first = materializeStoryboardFrames(f.script, [{ row: f.rows[0], frames: storyboardBoundaryFrames(f.rows[0]) }], f.nodes, [], "image", settings);
    let nodes = first.nodes.map(node => node.id === first.targets[0].nodeId ? { ...node, metadata: { ...node.metadata, status: "success" as const, content: "first-image" } } : node);
    const end = nodes.find(node => node.id === first.targets[1].nodeId)!;
    const snapshot = storyboardContinuitySnapshot(end, nodes);
    nodes = nodes.map(node => node.id === end.id ? { ...node, metadata: { ...node.metadata, status: "success" as const, content: "end-image", storyboardFrame: { ...node.metadata!.storyboardFrame!, continuityReference: snapshot } } } : node);
    const script = nodes.find(node => node.id === f.script.id)!;
    const row = script.metadata!.storyboard!.rows[0];
    const result = materializeStoryboardFrames(script, [{ row, frames: storyboardBoundaryFrames(row) }], nodes, [], "image", settings, { regenerate: true, frameTargets: [{ rowId: row.id, frameId: "start" }] });
    expect(result.targets).toHaveLength(1);
    const updated = result.nodes.find(node => node.id === script.id)!.metadata!.storyboard!.rows[0];
    expect(storyboardFrameIsCurrent(updated, updated.frames!.find(frame => frame.id === "end")!, result.nodes)).toBe(true);
});

test("gallery places per-frame selection above media and shows every consuming shot role", () => {
    const f = fixture();
    const track = storyboardFrameTrack(f.rows, f.nodes);
    const html = renderToStaticMarkup(<CanvasEpisodeFrameGallery row={f.rows[0]} nodes={f.nodes} trackItems={track.filter(item => item.rowId === f.rows[0].id)} onPreview={() => {}} onManage={() => {}} onToggle={() => {}} onGenerate={() => {}} />);
    expect(html.indexOf('type="checkbox"')).toBeLessThan(html.indexOf('class="canvas-episode-frame-tile-image"'));
    expect(html).toContain("镜头 01 尾帧");
    expect(html).toContain("镜头 02 首帧");
    expect(html).toContain("待生成");
    expect(html).not.toContain('disabled=""');
    expect(html.match(/class="canvas-episode-frame-tile-image"/g)).toHaveLength(3);
});

test("planned keyframes occupy their time-ordered slots without hiding pending boundaries", () => {
    const f = fixture(), row = f.rows[0];
    const plan = createCanvasNode(CanvasNodeType.Text, { x: 0, y: 0 }, { status: "success", content: JSON.stringify({ frames: [{ timeSeconds: 3, prompt: "抬手" }, { timeSeconds: 6, prompt: "放下相机" }] }), storyboardFramePlan: { scriptId: f.script.id, rowId: row.id, sourcePromptHash: storyboardFrameHash(row) } });
    row.framePlanNodeId = plan.id;
    const track = storyboardFrameTrack(f.rows, [...f.nodes, plan]);
    expect(track.slice(0, 4).map(item => [item.frame.kind, item.frame.timeSeconds])).toEqual([["start", 0], ["key", 3], ["key", 6], ["end", 10]]);
    const selected = [storyboardFrameTrackKey(row.id, "key-2")];
    expect(storyboardFrameTrackSelection(track, [storyboardFrameTrackKey(row.id, "key-plan")])).toEqual([storyboardFrameTrackKey(row.id, "key-1"), storyboardFrameTrackKey(row.id, "key-2")]);
    const frameTargets = storyboardFrameTrackTargets(track, selected, "keyframes");
    expect(frameTargets).toEqual([{ rowId: row.id, frameId: "key-2" }]);
    const result = materializeStoryboardFrames(f.script, [{ row, frames: track.filter(item => item.frame.kind === StoryboardFrameKind.Key && !item.needsPlan).map(item => item.frame) }], f.nodes, [], "image", settings, { frameTargets });
    expect(result.targets).toHaveLength(1);
    expect(result.nodes.find(node => node.id === result.targets[0].nodeId)?.metadata?.storyboardFrame?.frameId).toBe("key-2");
});
