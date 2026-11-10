import { nanoid } from "nanoid";
import { CanvasNodeType, type CanvasConnection, type CanvasGenerationBatch, type CanvasGenerationBatchItem, type CanvasNodeData, type StoryboardRow } from "@/types/canvas";
import { createCanvasNode } from "./canvas-project-domain";
import { materializeStoryboardFrames, shotKeyframes, storyboardBoundaryFrames, storyboardFrameHash, storyboardFrameRequested, storyboardKeyframePrompt, type StoryboardFrameGenerationOptions } from "./episode-storyboard-frames";
import { storyboardRowIsReady } from "./workflow-episode-storyboard";
import { ShortDramaStep } from "../short-drama-steps";

export type StoryboardFrameBatchTarget = Pick<CanvasGenerationBatchItem, "rowId" | "nodeId" | "frameGeneration">;

/** Resolve placeholder selections before filtering, without widening other selected rows. */
export function storyboardFrameRequests(rows: StoryboardRow[], nodes: CanvasNodeData[], kind: "all" | "boundary" | "keyframes", options: StoryboardFrameGenerationOptions) {
    for (const target of options.frameTargets || []) {
        const row = rows.find(row => row.id === target.rowId);
        if (!row || target.sourcePromptHash && target.sourcePromptHash !== storyboardFrameHash(row)) {
            throw new Error("所选画面的分镜已更新或删除，请重新勾选后生成");
        }
    }
    const planRows: StoryboardRow[] = [];
    const resolved = { ...options, frameTargets: options.frameTargets ? [...options.frameTargets] : undefined, frameIds: options.frameIds ? [...options.frameIds] : undefined };
    const requests = rows.map(row => {
        if (!storyboardRowIsReady(row)) throw new Error(`镜头 ${row.shotCode || row.shotNumber} 详情尚未完成`);
        const keys = shotKeyframes(row, nodes);
        const needsKeys = kind !== "boundary" && (storyboardFrameRequested(row.id, "key-plan", options) || keys.frames.some(frame => storyboardFrameRequested(row.id, frame.id, options)));
        if (needsKeys && !keys.complete) planRows.push(row);
        if (needsKeys && keys.frames.length && !keys.error && storyboardFrameRequested(row.id, "key-plan", options)) {
            resolved.frameTargets?.push(...keys.frames.map(frame => ({ rowId: row.id, frameId: frame.id })));
            resolved.frameIds?.push(...keys.frames.map(frame => frame.id));
        }
        const frames = [...(kind === "keyframes" ? [] : storyboardBoundaryFrames(row)), ...(kind === "boundary" || keys.error ? [] : keys.frames)];
        return { row, frames: frames.filter(frame => storyboardFrameRequested(row.id, frame.id, resolved)) };
    });
    return { requests, planRows, options: resolved };
}

export function materializeStoryboardKeyframePlans(scriptId: string, rows: StoryboardRow[], nodes: CanvasNodeData[], textModel: string, image: Omit<NonNullable<CanvasGenerationBatchItem["frameGeneration"]>, "sourcePromptHash">) {
    let next = nodes;
    const targets: StoryboardFrameBatchTarget[] = [];
    for (const requested of rows) {
        const script = next.find(node => node.id === scriptId)!;
        const row = script.metadata!.storyboard!.rows.find(row => row.id === requested.id)!;
        const sourcePromptHash = storyboardFrameHash(row);
        const frameGeneration = { ...image, sourcePromptHash };
        const existing = next.find(node => node.id === row.framePlanNodeId);
        const activeBatch = script.metadata?.generationBatches?.findLast(batch => !batch.paused && batch.items.some(item => item.nodeId === existing?.id && ["waiting", "submitting", "queued", "running"].includes(item.status)));
        if (existing?.metadata?.storyboardFramePlan?.sourcePromptHash === sourcePromptHash && activeBatch) {
            // Attach to the persisted extraction already in flight; never submit it twice.
            next = next.map(node => node.id !== scriptId ? node : { ...node, metadata: { ...node.metadata, generationBatches: node.metadata?.generationBatches?.map(batch => batch.id !== activeBatch.id ? batch : { ...batch, items: batch.items.map(item => item.nodeId !== existing.id ? item : { ...item, frameGeneration }) }) } });
            continue;
        }
        const prompt = storyboardKeyframePrompt(row);
        const plan = createCanvasNode(CanvasNodeType.Text, script.position, {
            prompt, composerContent: prompt, model: textModel, textCount: 1, status: "idle",
            storyboardFramePlan: { scriptId, rowId: row.id, sourcePromptHash, intermediateOnly: true },
            shortDrama: { stage: "storyboard", step: ShortDramaStep.Keyframes, pipelineId: script.metadata!.shortDrama!.pipelineId, role: "document", sourceNodeIds: [scriptId], sourceSignatures: {}, episodeNumber: script.metadata?.shortDrama?.episodeNumber },
        });
        plan.title = `${row.shotCode || row.shotNumber} · 关键帧提取`;
        next = [...next.map(node => node.id !== scriptId ? node : { ...node, metadata: { ...node.metadata, storyboard: { ...node.metadata!.storyboard!, rows: node.metadata!.storyboard!.rows.map(item => item.id !== row.id ? item : { ...item, framePlanNodeId: plan.id }) } } }), plan];
        targets.push({ rowId: row.id, nodeId: plan.id, frameGeneration });
    }
    return { nodes: next, targets };
}

/** Consume durable extraction intents once. Cancelled, deleted or obsolete work cannot spawn images. */
export function continueStoryboardFrameGeneration(nodes: CanvasNodeData[], connections: CanvasConnection[], projectId: string) {
    let next = nodes;
    let nextConnections = connections;
    for (const original of nodes) for (const batch of original.metadata?.generationBatches || []) {
        if (batch.projectId !== projectId || batch.mode !== "storyboard_keyframes" || batch.paused || batch.status === "cancelled") continue;
        for (const item of batch.items) {
            const intent = item.frameGeneration;
            if (!intent || item.status !== "succeeded") continue;
            const script = next.find(node => node.id === original.id)!;
            const row = script.metadata?.storyboard?.rows.find(row => row.id === item.rowId);
            const plan = next.find(node => node.id === item.nodeId);
            const latestBatch = script.metadata?.generationBatches?.findLast(entry => entry.items.some(target => target.nodeId === item.nodeId));
            let error: string | undefined;
            let images: CanvasGenerationBatch | undefined;
            const binding = plan?.metadata?.storyboardFramePlan;
            if (latestBatch?.id !== batch.id || !row || row.framePlanNodeId !== item.nodeId || !binding || binding.scriptId !== script.id || binding.rowId !== row.id || binding.sourcePromptHash !== intent.sourcePromptHash || plan?.metadata?.taskStatus === "cancelled" || storyboardFrameHash(row) !== intent.sourcePromptHash) {
                error = "关键帧提取已取消、删除或分镜已变化，请重新生成画面";
            } else {
                const keys = shotKeyframes(row, next);
                try {
                    if (!keys.complete) throw new Error(keys.error || "关键帧提取尚未完成，请稍后重试");
                    const frameTargets = keys.frames.map(frame => ({ rowId: row.id, frameId: frame.id, sourcePromptHash: intent.sourcePromptHash }));
                    const result = materializeStoryboardFrames(script, [{ row, frames: keys.frames }], next, nextConnections, intent.model, intent.settings, { regenerate: intent.regenerate, frameTargets });
                    next = result.nodes;
                    nextConnections = result.connections;
                    if (result.targets.length) {
                        const now = new Date().toISOString();
                        images = { id: nanoid(), sourceNodeId: script.id, projectId, mode: "storyboard_image", status: "queued", items: result.targets.map(target => ({ ...target, id: nanoid(), status: "waiting", retryCount: 0 })), createdAt: now, updatedAt: now };
                    }
                } catch (cause) { error = cause instanceof Error ? cause.message : "关键帧生图准备失败"; }
            }
            next = next.map(node => node.id !== script.id ? node : { ...node, metadata: { ...node.metadata, generationBatches: [
                ...(node.metadata?.generationBatches || []).map(entry => entry.id !== batch.id ? entry : { ...entry, ...(error ? { status: "partial_failed" as const } : {}), items: entry.items.map(target => target.id !== item.id ? target : { ...target, frameGeneration: undefined, ...(error ? { status: "failed" as const, errorDetails: error } : {}) }) }),
                ...(images ? [images] : []),
            ] } });
        }
    }
    return { nodes: next, connections: nextConnections };
}
