import { StoryboardFrameKind, type CanvasNodeData, type StoryboardFrame, type StoryboardRow } from "@/types/canvas";
import { shotKeyframes, storyboardBoundaryFrames, storyboardDisplayFrames, storyboardFrameHash, storyboardFrameLabels, type StoryboardFrameTarget } from "./episode-storyboard-frames";
import { storyboardPreviousFrameSource, storyboardRowIsReady } from "./workflow-episode-storyboard";

export type StoryboardFrameTrackItem = {
    id: string;
    rowId: string;
    frame: StoryboardFrame;
    ready: boolean;
    needsPlan: boolean;
    usages: { rowId: string; shot: string; code?: string; kind: StoryboardFrameKind }[];
};

export const storyboardFrameTrackKey = (rowId: string, frameId: string) => JSON.stringify([rowId, frameId]);

/** One item per physical frame, with all consuming shot roles, even before generation. */
export function storyboardFrameTrack(rows: StoryboardRow[], nodes: CanvasNodeData[]): StoryboardFrameTrackItem[] {
    const items = new Map<string, StoryboardFrameTrackItem>();
    for (const row of rows) {
        const ready = storyboardRowIsReady(row);
        const frames = ready ? storyboardDisplayFrames(row, nodes) : storyboardBoundaryFrames(row);
        const keys = frames.filter(frame => frame.kind === StoryboardFrameKind.Key).sort((a, b) => a.timeSeconds - b.timeSeconds);
        const needsPlan = !shotKeyframes(row, nodes).complete;
        if (needsPlan) keys.push({ id: "key-plan", kind: StoryboardFrameKind.Key, timeSeconds: 0, prompt: "", sourcePromptHash: storyboardFrameHash(row) });
        const ordered = [...frames.filter(frame => frame.kind === StoryboardFrameKind.Start), ...keys, ...frames.filter(frame => frame.kind === StoryboardFrameKind.End)];
        for (const frame of ordered) {
            const owner = frame.kind === StoryboardFrameKind.Start ? storyboardPreviousFrameSource(row, rows) : undefined;
            const id = storyboardFrameTrackKey(owner?.id || row.id, owner ? StoryboardFrameKind.End : frame.id);
            const usage = { rowId: row.id, shot: `镜头 ${String(row.shotNumber).padStart(2, "0")}`, code: row.shotCode, kind: frame.kind };
            const existing = items.get(id);
            if (existing) existing.usages.push(usage);
            else items.set(id, { id, rowId: row.id, frame, ready, needsPlan: frame.kind === StoryboardFrameKind.Key && needsPlan, usages: [usage] });
        }
    }
    return [...items.values()];
}

export function storyboardFrameTrackLabel(item: StoryboardFrameTrackItem) {
    const roles = new Set(item.usages.map(usage => usage.kind));
    return roles.has(StoryboardFrameKind.Start) && roles.has(StoryboardFrameKind.End) ? "首尾帧" : storyboardFrameLabels[item.frame.kind];
}

export function storyboardFrameTrackSlotCount(items: StoryboardFrameTrackItem[]) {
    return items.filter(item => item.frame.kind !== StoryboardFrameKind.Key).length
        + new Set(items.filter(item => item.frame.kind === StoryboardFrameKind.Key).map(item => item.rowId)).size;
}

export function storyboardFrameTrackSelection(items: StoryboardFrameTrackItem[], selectedIds: string[]) {
    const selected = new Set(selectedIds);
    return items.filter(item => selected.has(item.id) || item.frame.kind === StoryboardFrameKind.Key && selected.has(storyboardFrameTrackKey(item.rowId, "key-plan"))).map(item => item.id);
}

export function storyboardFrameTrackTargets(items: StoryboardFrameTrackItem[], selectedIds: string[], kind: "all" | "boundary" | "keyframes" = "all"): StoryboardFrameTarget[] {
    const selected = new Set(selectedIds);
    return items.filter(item => selected.has(item.id) && (kind === "all" || (kind === "keyframes" ? item.frame.kind === StoryboardFrameKind.Key : item.frame.kind !== StoryboardFrameKind.Key)))
        .map(item => ({ rowId: item.rowId, frameId: item.frame.id, sourcePromptHash: item.frame.sourcePromptHash }));
}
