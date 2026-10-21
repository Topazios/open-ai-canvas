import { CanvasNodeType, StoryboardStartFrameMode, type StoryboardFrame, type CanvasConnection, type CanvasNodeData, type StoryboardRow } from "@/types/canvas";
import { resolveProductionAssetReferences } from "./production-asset-references";
import { assetContentSignature, assetMediaSignature, isAssetReference } from "./canvas-workflow-asset-profile";
import { workflowSignatureMatches } from "./canvas-short-drama-workflow";

export const EPISODE_STORYBOARD_SIZE = { width: 1120, height: 640 };
export function storyboardRowIsReady(row: StoryboardRow) {
    return (!row.detailStatus || row.detailStatus === "ready") && Boolean((row.videoMotionPrompt || row.plotDescription).trim());
}
export function episodeStoryboardTiming(node: CanvasNodeData) {
    const parameters = node.metadata?.shortDrama?.parameters;
    const target = Number(parameters?.shotDurationSeconds);
    const tolerance = Number(parameters?.shotDurationToleranceSeconds ?? 3);
    if (!Number.isFinite(target) || target < 5 || target > 60 || !Number.isFinite(tolerance) || tolerance < 3 || tolerance > 5) return undefined;
    const min = Math.max(1, target - tolerance), max = Math.min(60, target + tolerance);
    const issue = (row: StoryboardRow) => {
        if (!Number.isFinite(row.durationSeconds) || row.durationSeconds <= 0) return "时长无效";
        const scene = row.sceneDurationSeconds;
        const unavoidable = typeof scene === "number" && Number.isFinite(scene) && scene > row.durationSeconds && Math.ceil((scene - 0.001) / max) > Math.floor((scene + 0.001) / min);
        if (node.metadata?.storyboard?.executionMode !== "episode" && row.timingException === "scene_tail" && row.durationSeconds < min && unavoidable) return "";
        return row.durationSeconds < min ? `低于 ${min} 秒` : row.durationSeconds > max ? `超过 ${max} 秒` : "";
    };
    return { target, tolerance, min, max, issue };
}
export function storyboardFrameHash(row: StoryboardRow) {
    return assetContentSignature(JSON.stringify([row.videoMotionPrompt || row.plotDescription, row.camera, row.continuityOut, row.durationSeconds, row.assetKeys]));
}
export function storyboardReferenceSignature(node: CanvasNodeData) {
    return assetContentSignature(JSON.stringify([node.type, node.metadata?.storageKey || node.metadata?.content]));
}
export function storyboardPreviousFrameSource(row: StoryboardRow, rows: StoryboardRow[]) {
    const previous = rows[rows.findIndex(item => item.id === row.id) - 1];
    if (!previous || row.startFrameMode === StoryboardStartFrameMode.Independent) return undefined;
    if (row.startFrameMode === StoryboardStartFrameMode.ReusePrevious) return previous;
    const scenes = (item: StoryboardRow) => [...new Set([...(item.assetKeys || []), ...episodeStoryboardCodes(item.videoMotionPrompt || item.plotDescription)].filter(code => code.startsWith("SCN-")).map(code => code.replace(/-V\d+$/, "")))];
    const before = scenes(previous), after = scenes(row);
    if (before.length && after.length && !before.some(code => after.includes(code))) return undefined;
    const continuity = (previous.continuityOut || "").replace(/(?:无需|无须|不需要|没有|无|不)(?:转场|闪回|时间跳跃|黑场|淡入|淡出|叠化)/g, "");
    if (/(?:转场|闪回|时间跳跃|黑场|淡入|淡出|叠化|切至|切到)/.test(continuity)) return undefined;
    return previous;
}
export function storyboardFrameIsCurrent(row: StoryboardRow, frame: StoryboardFrame, nodes: CanvasNodeData[]): boolean {
    if (frame.sourcePromptHash !== storyboardFrameHash(row)) return false;
    const snapshot = nodes.find(node => node.id === frame.imageNodeId)?.metadata?.storyboardFrame?.continuityReference;
    if (snapshot && !frame.sharedFrom) {
        const reference = nodes.find(node => node.id === snapshot.nodeId);
        const start = row.frames?.find(item => item.kind === "start");
        if (frame.kind === "start" || !reference || start?.imageNodeId !== reference.id || storyboardReferenceSignature(reference) !== snapshot.signature || !storyboardFrameIsCurrent(row, start, nodes)) return false;
    }
    if (!frame.sharedFrom) return true;
    const image = nodes.find(node => node.id === frame.imageNodeId);
    const binding = image?.metadata?.storyboardFrame;
    const rows = nodes.find(node => node.id === binding?.scriptId)?.metadata?.storyboard?.rows || [];
    const previous = storyboardPreviousFrameSource(row, rows);
    const end = previous?.frames?.find(item => item.kind === "end");
    return frame.kind === "start" && previous?.id === frame.sharedFrom.rowId
        && frame.sharedFrom.sourcePromptHash === storyboardFrameHash(previous)
        && binding?.rowId === previous.id && binding.frameId === end?.id
        && binding.sourcePromptHash === frame.sharedFrom.sourcePromptHash
        && end?.sourcePromptHash === frame.sharedFrom.sourcePromptHash && end.imageNodeId === frame.imageNodeId
        && storyboardFrameIsCurrent(previous, end, nodes);
}
export function episodeShotBoundaryImages(row: StoryboardRow, nodes: CanvasNodeData[]) {
    return (row.frames || []).filter(frame => frame.kind !== "key" && storyboardFrameIsCurrent(row, frame, nodes)).flatMap(frame => {
        const node = nodes.find(node => node.id === frame.imageNodeId && node.type === CanvasNodeType.Image && (node.metadata?.content || node.metadata?.storageKey));
        return node ? [{ kind: frame.kind, node }] : [];
    });
}

export function isEpisodeStoryboardVideo(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    return connections.some(edge => edge.toNodeId === nodeId && edge.relation === "storyboard-output" && nodes.some(node => node.id === edge.fromNodeId && node.metadata?.shortDrama?.step === "direction.shots"));
}

export function episodeStoryboardCodes(text: string) {
    return [...new Set(Array.from(text.matchAll(/\b(?:CHR|SCN|PRP|SPC|AUD)-\d+(?:-V\d+)?\b/g), match => match[0]))];
}

export function episodeStoryboardPromptPatch(row: StoryboardRow, prompt: string) {
    const previous = new Set(episodeStoryboardCodes(row.videoMotionPrompt || row.plotDescription));
    return { videoMotionPrompt: prompt, assetKeys: [...new Set([...(row.assetKeys || []).filter(code => !previous.has(code)), ...episodeStoryboardCodes(prompt)])] };
}

// Older checkpoints contain the same structured fields rendered as Markdown.
// Convert locally without another model call or changing the original document.
export function episodeStoryboardRows(node: CanvasNodeData): StoryboardRow[] {
    if (node.metadata?.storyboard?.rows?.length) return node.metadata.storyboard.rows;
    const text = node.metadata?.content || "";
    const sections = [...text.matchAll(/^###\s+([^\s·]+)\s*·\s*([\d.]+)秒\s*\r?\n([\s\S]*?)(?=^#{1,3}\s|$(?![\s\S]))/gm)];
    return sections.map((match, index) => {
        const fields = new Map([...match[3].matchAll(/^(画面|景别\/机位\/运动|对白|声音|连续性\/剪辑|资产|原文依据)：([\s\S]*?)(?=^(?:画面|景别\/机位\/运动|对白|声音|连续性\/剪辑|资产|原文依据)：|$(?![\s\S]))/gm)].map(field => [field[1], field[2].trim()]));
        const visual = fields.get("画面") || "";
        const camera = fields.get("景别/机位/运动") || "";
        const dialogue = fields.get("对白") || "";
        const sound = fields.get("声音") || "";
        const continuity = fields.get("连续性/剪辑") || "";
        const assetKeys = episodeStoryboardCodes([visual, fields.get("资产"), dialogue].join("\n"));
        return {
            id: `${node.id}:${match[1]}`, shotCode: match[1], shotNumber: index + 1, durationSeconds: Number(match[2]),
            plotDescription: visual, camera, dialogue, audioEffects: sound, continuityOut: continuity, assetKeys,
            imageGenerationPrompt: [visual, camera].filter(Boolean).join("\n"),
            videoMotionPrompt: [`镜头 ${match[1]} · ${match[2]}秒`, `画面：${visual}`, `镜头：${camera}`, dialogue ? `对白：${dialogue}` : "", sound ? `声音：${sound}` : "", `衔接：${continuity}`].filter(Boolean).join("\n"),
            characters: [], narrativeIntent: "", viewerPOV: "", performanceBlocking: "", shotSize: "", emotion: "", lightingAndAtmosphere: "", motion: "", timeBeats: "", mustHave: [], optionalDetails: [], negativePrompt: "", assetBindings: [], status: "idle",
        };
    });
}

export function materializeEpisodeStoryboard(node: CanvasNodeData): CanvasNodeData {
    if (node.metadata?.shortDrama?.step !== "direction.shots" || node.metadata.shortDrama.role === "collection" || node.type === CanvasNodeType.Script) return node;
    // Do not mutate the active agent's target while an older backend is writing it.
    if (node.metadata.status === "loading") return node;
    const rows = episodeStoryboardRows(node);
    if (!rows.length) return node;
    return { ...node, type: CanvasNodeType.Script, ...EPISODE_STORYBOARD_SIZE,
        metadata: { ...node.metadata, storyboard: { rows, visibleColumns: ["shotNumber", "videoMotionPrompt", "assets"], referenceNodeIds: [] } } };
}

/** Only traverse the selected branch; identical codes in other versions are irrelevant. */
export function episodeStoryboardSources(script: CanvasNodeData, nodes: CanvasNodeData[]) {
    const byId = new Map(nodes.map(node => [node.id, node]));
    const visited = new Set<string>();
    const visit = (id: string) => {
        if (visited.has(id)) return;
        const node = byId.get(id);
        if (!node || node.metadata?.shortDrama?.pipelineId !== script.metadata?.shortDrama?.pipelineId) return;
        visited.add(id);
        node.metadata?.shortDrama?.sourceNodeIds.forEach(visit);
        node.metadata?.shortDrama?.collectionSourceIds?.forEach(visit);
        // Plan assets live in sibling subgroups of the same pinned plan root.
        Object.values(node.metadata?.shortDrama?.planGroups || {}).forEach(visit);
    };
    script.metadata?.shortDrama?.sourceNodeIds.forEach(visit);
    return [...visited].map(id => byId.get(id)!);
}

export function episodeStoryboardImages(script: CanvasNodeData, nodes: CanvasNodeData[]) {
    const owners = new Set(episodeStoryboardSources(script, nodes).map(node => node.id));
    return nodes.filter(node => node.type === CanvasNodeType.Image && node.metadata?.shortDrama?.pipelineId === script.metadata?.shortDrama?.pipelineId && owners.has(node.metadata?.shortDrama?.mediaSubjectId || ""));
}

export function resolveEpisodeShotAssets(script: CanvasNodeData, row: StoryboardRow, nodes: CanvasNodeData[]) {
    if (!storyboardRowIsReady(row)) throw new Error("镜头详情尚未完成，请等待分镜信息和资产引用生成");
    const codes = [...new Set([...(row.assetKeys || []), ...episodeStoryboardCodes(row.videoMotionPrompt || row.plotDescription)])];
    const bases = new Set(codes.map(code => code.replace(/-V\d+$/, "")));
    const sources = episodeStoryboardSources(script, nodes).filter(node => bases.has(node.metadata?.shortDrama?.assetIdentity?.code || node.metadata?.shortDrama?.assetKey || ""));
    const resolved = resolveProductionAssetReferences("", sources, codes);
    const media = new Map<string, CanvasNodeData>();
    for (const source of resolved.nodes) {
        const data = source.metadata!.shortDrama!;
        const refs = data.assetProfile?.references.filter(ref => ref.selected) || [];
        if (refs.length && data.assetProfile?.indexContent !== assetContentSignature(source.metadata?.content || "")) throw new Error(`资产 ${data.assetIdentity?.code} 已修改，请核对参考图`);
        const variants = codes.filter(code => code.replace(/-V\d+$/, "") === data.assetIdentity?.code && /-V\d+$/.test(code));
        const selected = refs.filter(ref => {
            const variant = data.assetProfile?.variants.find(variant => variant.code === ref.variant || variant.name === ref.variant);
            return !variant || variants.includes(variant.code || "");
        });
        // Generated sheets already identify their exact source asset. Explicit
        // user selections take priority; otherwise use that source's latest sheet.
        if (!refs.length) {
            const images = nodes.filter(node => node.type === CanvasNodeType.Image && node.metadata?.shortDrama?.pipelineId === data.pipelineId && node.metadata.shortDrama.mediaSubjectId === source.id && isAssetReference(node));
            const current = images.filter(node => {
                const signature = node.metadata!.shortDrama!.sourceSignatures[source.id];
                return Boolean(signature && workflowSignatureMatches(source, signature));
            });
            if (images.length && !current.length) throw new Error(`资产 ${data.assetIdentity?.code} 的图片来源已变化，请重新生成参考图`);
            const version = Math.max(0, ...current.map(node => node.metadata!.shortDrama!.version || 1));
            const latest = current.filter(node => (node.metadata!.shortDrama!.version || 1) === version);
            if (latest.length > 1) throw new Error(`资产 ${data.assetIdentity?.code} 存在同版参考图冲突，请在资产详情选定版本`);
            if (latest[0]) media.set(latest[0].id, latest[0]);
        }
        for (const ref of selected) {
            const node = nodes.find(node => node.id === ref.nodeId);
            if (!node || !isAssetReference(node) || assetMediaSignature(node) !== ref.signature) throw new Error(`资产 ${data.assetIdentity?.code} 的已选参考版本已变化或不可用`);
            media.set(node.id, node);
        }
    }
    return { ...resolved, media: [...media.values()], referenceNodeIds: [...resolved.nodes.map(node => node.id), ...media.keys()] };
}
