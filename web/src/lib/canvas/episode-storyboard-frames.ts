import { CanvasNodeType, StoryboardFrameKind, type CanvasConnection, type CanvasNodeData, type StoryboardFrame, type StoryboardRow } from "@/types/canvas";
import { createCanvasNode } from "./canvas-project-domain";
import { storyboardComposerContent } from "./canvas-storyboard-materializer";
import { resolveEpisodeShotAssets, episodeStoryboardCodes, storyboardFrameHash, storyboardPreviousFrameSource, storyboardFrameIsCurrent, storyboardReferenceSignature, storyboardRowIsReady } from "./workflow-episode-storyboard";
export { storyboardFrameHash } from "./workflow-episode-storyboard";
import { ShortDramaStep } from "../short-drama-steps";
import { globalSettingsPrompt } from "../short-drama-settings";
import { isCanvasNodeGenerating } from "./canvas-node-task-state";
import { synchronizeGenerationSpec } from "./generation-contract";
import { storyboardCompositionRule, storyboardFrameBoundaryPrompt } from "./storyboard-frame-composition";
import { reconcileStoryboardFramesGroups } from "./storyboard-frame-groups";
import { resetGenerationTaskMetadata } from "./canvas-task-state";
import { storyboardFrameWaitingReason } from "./storyboard-frame-continuity";

export type StoryboardFrameTarget = { rowId: string; frameId: string; sourcePromptHash?: string };
export type StoryboardFrameGenerationOptions = { failedOnly?: boolean; regenerate?: boolean; frameIds?: string[]; rowIds?: string[]; frameTargets?: StoryboardFrameTarget[] };

export function storyboardFrameRequested(rowId: string, frameId: string, options: StoryboardFrameGenerationOptions) {
    return (!options.rowIds || options.rowIds.includes(rowId))
        && (!options.frameIds || options.frameIds.includes(frameId))
        && (!options.frameTargets || options.frameTargets.some(target => target.rowId === rowId && target.frameId === frameId));
}

export const storyboardFrameLabels = { start: "首帧", end: "尾帧", key: "关键帧" };
export function storyboardBoundaryFrames(row: StoryboardRow): StoryboardFrame[] {
    const sourcePromptHash = storyboardFrameHash(row);
    return ([StoryboardFrameKind.Start, StoryboardFrameKind.End] as const).map((kind) => ({
        id: kind,
        kind,
        timeSeconds: kind === StoryboardFrameKind.Start ? 0 : row.durationSeconds,
        sourcePromptHash,
        prompt: storyboardFrameBoundaryPrompt(row, kind),
    }));
}
export const storyboardKeyframeOutput = {
    name: "shot_keyframes",
    strict: true,
    schema: {
        type: "object",
        additionalProperties: false,
        required: ["frames"],
        properties: {
            frames: { type: "array", minItems: 0, maxItems: 8, items: { type: "object", additionalProperties: false, required: ["timeSeconds", "prompt"], properties: { timeSeconds: { type: "number" }, prompt: { type: "string" } } } },
        },
    },
};
export function storyboardKeyframePrompt(row: StoryboardRow) {
    return [
        "只根据下面这个镜头判断是否需要首尾帧以外的中间关键画面，允许0至8张，默认不额外提取。不要按时长、固定间隔或比例取样，不凑数。",
        "只有首尾帧无法表达且会影响生成理解的中间状态才提取，例如不可省略的道具交接、遮挡后的空间关系变化、明确的新信息揭示。普通走动、推拉运镜、微小表情变化和首尾状态的近似重复不构成提取理由。30秒镜头也可能完全不需要中间关键帧。若没有必要的独立中间状态，返回{\"frames\":[]}，这是正常完成而不是失败。",
        "每项是独立可生图的单幅静态画面提示词，包含主体资产编号、姿态表情、空间、构图、光线和必要连续性。保留原有资产编号，不创造剧情、人物或新编号。",
        storyboardCompositionRule,
        "先从本镜头确定统一空间与取景基准，再按时间点写各幅静态状态；每幅保留主体画面左右、纵深、裁切和占幅，发生明确移动或运镜才变化。景别不能只写名词，需给出可见身体范围和主体约占画幅高度。取第N秒已发生的状态，不把整段动作、起幅与落幅混写；信息不足按已有关系作最少且前后一致的构图补充，不改剧情或人物体型。",
        `timeSeconds为镜头内相对秒数，必须大于0且小于${row.durationSeconds}，严格递增。不得重复首帧、尾帧及近似相同的画面。不要拆解其他镜头，不查全剧或资产库。`,
        `已覆盖的首帧状态：${storyboardFrameBoundaryPrompt(row, StoryboardFrameKind.Start)}\n已覆盖的尾帧状态：${storyboardFrameBoundaryPrompt(row, StoryboardFrameKind.End)}`,
        '只输出JSON：{"frames":[{"timeSeconds":2,"prompt":"单幅画面提示词"}]}，不输出说明。',
        `镜头 ${row.shotCode || row.shotNumber} · ${row.durationSeconds}秒\n${row.videoMotionPrompt || row.plotDescription}`,
    ].join("\n\n");
}
export function parseStoryboardKeyframes(text: string, row: StoryboardRow, intermediateOnly = true): StoryboardFrame[] {
    const raw = JSON.parse(text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1"));
    if (!raw || !Array.isArray(raw.frames) || raw.frames.length > 8) throw new Error("关键帧结果应包含0至8幅有效画面，请重新提取");
    const allowedCodes = new Set([...(row.assetKeys || []), ...episodeStoryboardCodes(row.videoMotionPrompt || row.plotDescription)]);
    let previous = -1;
    const seen = new Set<string>();
    const frames: StoryboardFrame[] = raw.frames.map((frame: { timeSeconds?: number; prompt?: string }, index: number) => {
        if (
            !frame ||
            typeof frame.prompt !== "string" ||
            !frame.prompt.trim() ||
            frame.prompt.length > 12000 ||
            typeof frame.timeSeconds !== "number" ||
            !Number.isFinite(frame.timeSeconds) ||
            frame.timeSeconds < 0 ||
            frame.timeSeconds > row.durationSeconds ||
            frame.timeSeconds <= previous
        )
            throw new Error("关键帧缺少画面描述或时间点不符合镜头范围，请重新提取");
        previous = frame.timeSeconds;
        if (episodeStoryboardCodes(frame.prompt).some((code) => !allowedCodes.has(code))) throw new Error("关键帧包含当前镜头以外的资产编号，请重新提取");
        return { id: `key-${index + 1}`, kind: StoryboardFrameKind.Key, prompt: frame.prompt.trim(), timeSeconds: frame.timeSeconds, sourcePromptHash: storyboardFrameHash(row) };
    });
    if (!intermediateOnly) return frames;
    return frames.filter(frame => {
        const prompt = frame.prompt.replace(/\s+/g, "");
        if (frame.timeSeconds === 0 || frame.timeSeconds === row.durationSeconds || seen.has(prompt)) return false;
        seen.add(prompt);
        return true;
    });
}
export function shotKeyframes(row: StoryboardRow, nodes: CanvasNodeData[]): { frames: StoryboardFrame[]; plan?: CanvasNodeData; error: string; complete: boolean } {
    const plan = nodes.find((node) => node.id === row.framePlanNodeId);
    if (!plan || plan.metadata?.status !== "success") return { frames: [], plan, error: "", complete: false };
    if (plan.metadata.storyboardFramePlan?.sourcePromptHash !== storyboardFrameHash(row)) return { frames: [], plan, error: "分镜提示词已修改，请重新提取关键帧", complete: false };
    try {
        return { frames: parseStoryboardKeyframes(plan.metadata.content || "", row, plan.metadata.storyboardFramePlan?.intermediateOnly !== false), plan, error: "", complete: true };
    } catch (error) {
        return { frames: [], plan, error: error instanceof Error ? error.message : "关键帧解析失败", complete: false };
    }
}
export function storyboardDisplayFrames(row: StoryboardRow, nodes: CanvasNodeData[]): StoryboardFrame[] {
    if (!storyboardRowIsReady(row)) return [];
    const boundaries = storyboardBoundaryFrames(row).map((frame) => row.frames?.find((saved) => saved.id === frame.id && storyboardFrameIsCurrent(row, saved, nodes)) || frame);
    const keys = shotKeyframes(row, nodes).frames.map((frame) => ({ ...frame, imageNodeId: row.frames?.find((saved) => saved.id === frame.id && saved.prompt === frame.prompt && storyboardFrameIsCurrent(row, saved, nodes))?.imageNodeId }));
    return [...boundaries, ...keys];
}
function storyboardFrameQueue(script: CanvasNodeData) {
    const latest = new Map((script.metadata?.generationBatches || []).flatMap((batch) => batch.items.map((item) => [item.nodeId, { status: item.status, paused: batch.paused }] as const)));
    return {
        active: new Set([...latest].filter(([, item]) => !item.paused && ["waiting", "submitting", "queued", "running"].includes(item.status)).map(([id]) => id)),
        cancelled: new Set([...latest].filter(([, item]) => item.status === "cancelled").map(([id]) => id)),
    };
}
export function failedStoryboardBoundaryImages(script: CanvasNodeData, nodes: CanvasNodeData[]): CanvasNodeData[] {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const { active, cancelled } = storyboardFrameQueue(script);
    const result = new Map<string, CanvasNodeData>();
    for (const row of script.metadata?.storyboard?.rows || [])
        for (const frame of storyboardDisplayFrames(row, nodes)) {
            const image = frame.kind !== StoryboardFrameKind.Key && frame.imageNodeId ? byId.get(frame.imageNodeId) : undefined;
            if (
                image &&
                !active.has(image.id) &&
                !cancelled.has(image.id) &&
                !isCanvasNodeGenerating(image) &&
                image.metadata?.taskStatus !== "cancelled" &&
                !image.metadata?.content &&
                !image.metadata?.storageKey &&
                storyboardFrameWaitingReason(image, nodes) === undefined &&
                (image.metadata?.status === "error" || image.metadata?.taskStatus === "failed")
            )
                result.set(image.id, image);
        }
    return [...result.values()];
}

export function failedStoryboardBoundaryImagesForRow(script: CanvasNodeData, rowId: string, nodes: CanvasNodeData[]): CanvasNodeData[] {
    const row = script.metadata?.storyboard?.rows.find((item) => item.id === rowId);
    if (!row) return [];
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const { active, cancelled } = storyboardFrameQueue(script);
    const result = new Map<string, CanvasNodeData>();
    for (const frame of storyboardDisplayFrames(row, nodes)) {
        if (frame.kind === StoryboardFrameKind.Key || !frame.imageNodeId) continue;
        const image = byId.get(frame.imageNodeId);
        if (!image || active.has(image.id) || cancelled.has(image.id) || isCanvasNodeGenerating(image)) continue;
        if (image.metadata?.taskStatus === "cancelled" || image.metadata?.content || image.metadata?.storageKey) continue;
        if (storyboardFrameWaitingReason(image, nodes) !== undefined) continue;
        if (image.metadata?.status === "error" || image.metadata?.taskStatus === "failed") result.set(image.id, image);
    }
    return [...result.values()];
}
export function generatedStoryboardBoundaryImagesForRow(script: CanvasNodeData, rowId: string, nodes: CanvasNodeData[]): CanvasNodeData[] {
    const row = script.metadata?.storyboard?.rows.find((item) => item.id === rowId);
    if (!row) return [];
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const result = new Map<string, CanvasNodeData>();
    for (const frame of storyboardDisplayFrames(row, nodes)) {
        if (frame.kind === StoryboardFrameKind.Key || !frame.imageNodeId) continue;
        const image = byId.get(frame.imageNodeId);
        if (image && (image.metadata?.content || image.metadata?.storageKey)) result.set(image.id, image);
    }
    return [...result.values()];
}
export function failedStoryboardBoundaryImageCount(script: CanvasNodeData, nodes: CanvasNodeData[]): number {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const { active, cancelled } = storyboardFrameQueue(script);
    const failed = new Set<string>();
    for (const row of script.metadata?.storyboard?.rows || [])
        for (const frame of storyboardDisplayFrames(row, nodes)) {
            if (frame.kind === StoryboardFrameKind.Key || !frame.imageNodeId || failed.has(frame.imageNodeId)) continue;
            const image = byId.get(frame.imageNodeId);
            if (
                image &&
                !active.has(image.id) &&
                !cancelled.has(image.id) &&
                !isCanvasNodeGenerating(image) &&
                image.metadata?.taskStatus !== "cancelled" &&
                !image.metadata?.content &&
                !image.metadata?.storageKey &&
                (image.metadata?.status === "error" || image.metadata?.taskStatus === "failed")
            )
                failed.add(image.id);
        }
    return failed.size;
}
export function materializeStoryboardFrames(
    script: CanvasNodeData,
    requests: { row: StoryboardRow; frames: StoryboardFrame[] }[],
    nodes: CanvasNodeData[],
    connections: CanvasConnection[],
    model: string,
    settings: { size: string; quality: string; transparentBackground: string },
    options: StoryboardFrameGenerationOptions = {},
) {
    const reconciled = reconcileStoryboardFramesGroups(nodes, connections);
    let next = [...reconciled.nodes];
    const targets: { rowId: string; nodeId: string }[] = [];
    const { active } = storyboardFrameQueue(script);
    const rowPatches = new Map<string, StoryboardFrame[]>();
    const rows = (script.metadata?.storyboard?.rows || []).map((row) => requests.find((request) => request.row.id === row.id)?.row || row);
    const requestedFrames = new Set(requests.flatMap(({ row, frames }) => frames.filter((frame) => storyboardFrameRequested(row.id, frame.id, options)).map((frame) => {
        const owner = frame.kind === StoryboardFrameKind.Start ? storyboardPreviousFrameSource(row, rows) : undefined;
        return owner ? `${owner.id}:end` : `${row.id}:${frame.id}`;
    })));
    const processed = new Set<string>();
    const blockedRows = new Set<string>();
    const failedIds = options.failedOnly ? new Set(failedStoryboardBoundaryImages(script, nodes).map((node) => node.id)) : undefined;
    const materialize = (row: StoryboardRow, frames: StoryboardFrame[], dependency = false, forceRegenerate = false) => {
        const selected = dependency ? frames : frames.filter(frame => storyboardFrameRequested(row.id, frame.id, options));
        if (!selected.length) return;
        if (!storyboardRowIsReady(row)) throw new Error("当前或前序镜头详情尚未完成，请等待对应分镜生成后制作画面");
        const merged = rowPatches.get(row.id) || [...(script.metadata?.storyboard?.rows.find((item) => item.id === row.id)?.frames || row.frames || [])];
        rowPatches.set(row.id, merged);
        const store = (value: StoryboardFrame) => {
            const index = merged.findIndex((item) => item.id === value.id);
            if (index < 0) merged.push(value);
            else merged[index] = value;
        };
        for (const frame of selected) {
            if (frame.sourcePromptHash !== storyboardFrameHash(row)) throw new Error("分镜内容已变化，请重新提取画面");
            const key = `${row.id}:${frame.id}`;
            if (processed.has(key)) continue;
            processed.add(key);
            const source = frame.kind === StoryboardFrameKind.Start ? storyboardPreviousFrameSource(row, rows) : undefined;
            if (source) {
                // A shared boundary is owned by the previous shot; wait for its details.
                if (!storyboardRowIsReady(source)) {
                    blockedRows.add(row.id);
                    continue;
                }
                // The preceding end owns the only image/task; this start is a versioned alias.
                materialize(
                    source,
                    storyboardBoundaryFrames(source).filter((item) => item.kind === StoryboardFrameKind.End),
                    true,
                    options.regenerate && requestedFrames.has(`${source.id}:end`),
                );
                const end = rowPatches.get(source.id)?.find((item) => item.kind === StoryboardFrameKind.End);
                if (!end?.imageNodeId) continue;
                store({ ...frame, prompt: end.prompt, imageNodeId: end.imageNodeId, sharedFrom: { rowId: source.id, sourcePromptHash: end.sourcePromptHash } });
                continue;
            }
            const previous = merged.find((item) => item.id === frame.id);
            let existing = !previous?.sharedFrom ? next.find((node) => node.id === previous?.imageNodeId && node.type === CanvasNodeType.Image) : undefined;
            const snapshot = existing?.metadata?.storyboardFrame?.continuityReference;
            if (snapshot && (existing?.metadata?.content || existing?.metadata?.storageKey)) {
                const anchor = next.find((node) => node.id === snapshot.nodeId);
                if (!anchor || storyboardReferenceSignature(anchor) !== snapshot.signature) existing = undefined;
            }
            if (failedIds && (!existing || !failedIds.has(existing.id))) continue;
            const sameFrame = previous?.sourcePromptHash === frame.sourcePromptHash && (frame.kind !== StoryboardFrameKind.Key || previous.prompt === frame.prompt);
            const metadata = existing?.metadata;
            const failed = metadata?.status === "error" || metadata?.taskStatus === "failed";
            const completed = Boolean(metadata?.content || metadata?.storageKey);
            const regenerate = options.regenerate && (forceRegenerate || requestedFrames.has(`${row.id}:${frame.id}`)) && !active.has(existing?.id || "") && !isCanvasNodeGenerating(existing);
            const reusable =
                existing && (active.has(existing.id) || Boolean(metadata?.content || metadata?.storageKey) || (!failed && metadata?.taskStatus !== "cancelled" && (metadata?.status === "loading" || Boolean(metadata?.taskId && !options.failedOnly))));
            if (sameFrame && existing && reusable && !(regenerate && completed)) {
                store({ ...frame, imageNodeId: existing.id });
                continue;
            }
            const refs = resolveEpisodeShotAssets(script, row, nodes);
            const image = existing && sameFrame && !(regenerate && completed) ? existing : createCanvasNode(CanvasNodeType.Image, script.position, {});
            const prompt = [globalSettingsPrompt(script.metadata?.shortDrama?.parameters?.globalSettings, "storyboard", "image"), frame.prompt].filter(Boolean).join("\n\n");
            const prepared: CanvasNodeData = {
                ...image,
                parentId: undefined,
                width: 280,
                height: 280,
                title: `${row.shotCode || row.shotNumber} · ${storyboardFrameLabels[frame.kind]}${frame.kind === StoryboardFrameKind.Key ? ` ${frame.timeSeconds}秒` : ""}`,
                metadata: {
                    ...resetGenerationTaskMetadata(image.metadata),
                    ...settings,
                    model,
                    count: 1,
                    generationMode: "image",
                    manualSize: true,
                    freeResize: false,
                    prompt,
                    composerContent: storyboardComposerContent(prompt, refs.referenceNodeIds, nodes),
                    storyboardFrame: { scriptId: script.id, rowId: row.id, frameId: frame.id, sourcePromptHash: frame.sourcePromptHash },
                    shortDrama: {
                        stage: "storyboard",
                        step: frame.kind === StoryboardFrameKind.Start ? ShortDramaStep.StartFrame : frame.kind === StoryboardFrameKind.End ? ShortDramaStep.EndFrame : ShortDramaStep.Keyframes,
                        pipelineId: script.metadata!.shortDrama!.pipelineId,
                        role: "document",
                        mediaKind: "image",
                        mediaSubjectId: script.id,
                        mediaShotId: row.shotCode || row.id,
                        sourceNodeIds: [script.id],
                        sourceSignatures: {},
                        episodeNumber: script.metadata?.shortDrama?.episodeNumber,
                    },
                },
            };
            const selected = synchronizeGenerationSpec(prepared, { model, ...settings, count: 1, prompt, composerContent: prepared.metadata?.composerContent });
            next = next.some((node) => node.id === image.id) ? next.map((node) => (node.id === image.id ? selected : node)) : [...next, selected];
            store({ ...frame, imageNodeId: image.id });
            targets.push({ rowId: row.id, nodeId: image.id });
        }
    };
    for (const { row, frames } of requests) materialize(row, frames);
    // Update every consumer when a shared boundary changes, including shots outside
    // the selection. Only the owner owns an image task; starts are versioned aliases.
    for (const row of rows) {
        if (!storyboardRowIsReady(row)) continue;
        const owner = storyboardPreviousFrameSource(row, rows);
        const end = owner && rowPatches.get(owner.id)?.find(frame => frame.kind === StoryboardFrameKind.End);
        if (!owner || !end?.imageNodeId || end.sourcePromptHash !== storyboardFrameHash(owner)) continue;
        const start = storyboardBoundaryFrames(row)[0];
        const alias = { ...start, prompt: end.prompt, imageNodeId: end.imageNodeId, sharedFrom: { rowId: owner.id, sourcePromptHash: end.sourcePromptHash } };
        const frames = rowPatches.get(row.id) || [...(row.frames || [])];
        const index = frames.findIndex(frame => frame.kind === StoryboardFrameKind.Start);
        if (index < 0) frames.push(alias);
        else frames[index] = alias;
        rowPatches.set(row.id, frames);
    }
    next = next.map((node) =>
        node.id === script.id
            ? { ...node, metadata: { ...node.metadata, storyboard: { ...node.metadata!.storyboard!, rows: node.metadata!.storyboard!.rows.map((row) => (rowPatches.has(row.id) ? { ...row, frames: rowPatches.get(row.id) } : row)) } } }
            : node,
    );
    return { nodes: next, connections: reconciled.connections, targets, blockedRows: [...blockedRows] };
}
