import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type Position } from "@/types/canvas";
import { createClientId } from "../client-id";
import { ShortDramaStep } from "../short-drama-steps";
import { ProductionSoundKind, projectVoiceCalibration, soundDesignMaterial } from "../production-sound";
import { createCanvasNode } from "./canvas-project-domain";
import { nodeWorkflow, workflowParameters, workflowSignature, type WorkflowGenerationRequest } from "./canvas-short-drama-workflow";
import { layoutCanvasGridGroups } from "./canvas-group-grid";
import { placeNewWorkflowGroup } from "./canvas-workflow-placement";

export function workflowSoundSubjects(request: Pick<WorkflowGenerationRequest, "sourceNodeIds" | "pipelineId">, nodes: CanvasNodeData[]) {
    const selected = new Set(request.sourceNodeIds);
    for (const node of nodes) if (selected.has(node.id)) Object.values(nodeWorkflow(node)?.planGroups || {}).forEach(id => selected.add(id));
    return nodes.filter(node => node.type === CanvasNodeType.Text && nodeWorkflow(node)?.pipelineId === request.pipelineId &&
        nodeWorkflow(node)?.assetIdentity?.kind === "sound" && nodeWorkflow(node)?.assetProfile?.soundKind === ProductionSoundKind.Voice && (selected.has(node.id) || selected.has(node.parentId || "")) &&
        Boolean(node.metadata?.content?.trim()) && !["loading", "error"].includes(node.metadata?.status || ""));
}

export function createWorkflowSounds(request: WorkflowGenerationRequest, nodes: CanvasNodeData[], connections: CanvasConnection[], center: Position) {
    if (request.step !== ShortDramaStep.VoiceSamples) throw new Error("请选择声音资产试听步骤");
    if (!request.model.trim()) throw new Error("请选择音频模型");
    const settings = request.soundSettings;
    if (!settings || !Object.values(ProductionSoundKind).includes(settings.kind)) throw new Error("请选择声音类别");
    if (settings.kind !== ProductionSoundKind.Voice) throw new Error("语音合成不能代替音效或音乐；请在声音资产关联实际音频");
    if (!settings.text.trim()) throw new Error(settings.kind === ProductionSoundKind.Voice ? "请填写项目统一校准文本" : "请填写声音事件描述");
    if (settings.kind === ProductionSoundKind.Voice && !settings.voice.trim()) throw new Error("请选择模型支持的声线标识");
    const text = projectVoiceCalibration(request.globalSettings);
    if (!text || settings.text.trim() !== text) throw new Error("项目统一试听文本已变化，请重新打开生成设置");
    const available = workflowSoundSubjects(request, nodes);
    const ids = request.imageSubjectIds || [];
    if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !available.some(node => node.id === id))) throw new Error("请选择已完成的声音资产");
    const subjects = ids.map(id => available.find(node => node.id === id)!);
    if (subjects.some(node => nodeWorkflow(node)?.assetProfile?.soundKind && nodeWorkflow(node)?.assetProfile?.soundKind !== settings.kind)) throw new Error("声音类别不一致，请分别选择对应类型的声音资产");
    const parentId = subjects[0].parentId;
    const sourceId = parentId && subjects.every(subject => subject.parentId === parentId) ? parentId : request.sourceNodeIds[0];
    const previous = nodes.findLast(node => node.type === CanvasNodeType.Frame && nodeWorkflow(node)?.step === request.step && nodeWorkflow(node)?.mediaGroup?.sourceNodeId === sourceId && nodeWorkflow(node)?.pipelineId === request.pipelineId);
    const frame = previous || createCanvasNode(CanvasNodeType.Frame, center);
    const created = subjects.map(subject => {
        const data = nodeWorkflow(subject)!;
        const version = 1 + Math.max(0, ...nodes.filter(node => nodeWorkflow(node)?.step === request.step && nodeWorkflow(node)?.mediaSubjectId === subject.id).map(node => nodeWorkflow(node)?.version || 1));
        const voice = request.soundVoices?.[subject.id] || settings.voice;
        const instructions = [soundDesignMaterial(subject.metadata!.content!), settings.instructions, request.instruction].filter(Boolean).join("\n\n");
        const node = createCanvasNode(CanvasNodeType.Audio, center, { model: request.model, generationMode: "audio", status: "idle", prompt: text,
            audioVoice: voice, audioFormat: settings.format, audioSpeed: settings.speed, audioInstructions: instructions,
            shortDrama: { stage: "assets", step: request.step, pipelineId: request.pipelineId, role: "document", mediaKind: "audio", mediaSubjectId: subject.id,
                assetIdentity: data.assetIdentity, sourceNodeIds: [subject.id], sourceSignatures: { [subject.id]: workflowSignature(subject) },
                soundSample: { ...settings, voice, instructions }, parameters: { ...workflowParameters([subject], request.globalSettings), instruction: request.instruction }, version, operationId: createClientId(), submission: "planned" },
        });
        node.parentId = frame.id; node.title = `${subject.title} · 试听 · 第 ${version} 版`; return node;
    });
    const all = [...nodes.filter(node => node.parentId === frame.id), ...created];
    const group: CanvasNodeData = { ...frame, title: previous?.title || "声音资产试听", width: previous?.width || 920,
        metadata: { ...frame.metadata, shortDrama: { stage: "assets", step: request.step, pipelineId: request.pipelineId, role: "collection", mediaKind: "audio",
            sourceNodeIds: all.map(node => node.id), sourceSignatures: {}, collectionSourceIds: [sourceId], mediaGroup: { sourceNodeId: sourceId, layout: "grid" } } } };
    let next = layoutCanvasGridGroups([...nodes.filter(node => node.id !== group.id), group, ...created], new Set([group.id]));
    if (!previous) next = placeNewWorkflowGroup(next, group.id, nodes, nodes.find(node => node.id === sourceId));
    const edges = [...connections];
    for (const id of new Set([sourceId, ...subjects.map(subject => subject.id)])) {
        if (!edges.some(edge => edge.fromNodeId === id && edge.toNodeId === group.id)) edges.push({ id: createClientId(), fromNodeId: id, toNodeId: group.id });
    }
    return { nodes: next, connections: edges, created: created.map(node => next.find(entry => entry.id === node.id)!) };
}
