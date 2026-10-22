import { nanoid } from "nanoid";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import { shortDramaStep } from "../short-drama-steps";
import { createCanvasNode } from "./canvas-project-domain";
import { nodeWorkflow, workflowAncestors, workflowSignature, workflowSourceSignaturesMatch } from "./canvas-short-drama-workflow";
import { layoutWorkflowImageGroups } from "./canvas-workflow-image-layout";
import { placeNewWorkflowGroup } from "./canvas-workflow-placement";
import { isStoryboardFrameStep } from "../short-drama-steps";

export function groupWorkflowImages(nodes: CanvasNodeData[], connections: CanvasConnection[], created: CanvasNodeData[]) {
    if (!created.length) return { nodes, connections, created };
    const first = nodeWorkflow(created[0])!;
    if (first.stage === "storyboard" && isStoryboardFrameStep(first.step)) {
        throw new Error("首帧、尾帧和关键帧请在分镜列表中生成，不能创建额外的镜头帧容器");
    }
    const sourceNodeId = first.stage === "assets" ? first.sourceNodeIds[0] : first.mediaSubjectId!;
    const source = nodes.find((node) => node.id === sourceNodeId)!;
    const signatures = first.assetImageSourceIds ? { ...first.assetSheet!.styleSignatures } : Object.fromEntries(workflowAncestors([sourceNodeId], nodes, first.pipelineId, connections).map((node) => [node.id, workflowSignature(node)]));
    const sameSources = (data: NonNullable<ReturnType<typeof nodeWorkflow>>) => Object.entries(signatures).every(([id, signature]) => data.sourceSignatures[id] === signature) &&
        (!first.assetImageSourceIds || workflowSourceSignaturesMatch(data, nodes));
    const existing = nodes.findLast((node) => {
        const data = nodeWorkflow(node);
        return node.type === CanvasNodeType.Frame && !node.metadata?.copiedFromNodeId && data?.role === "collection" && data.pipelineId === first.pipelineId && data.step === first.step && data.mediaGroup?.sourceNodeId === sourceNodeId && sameSources(data) && (first.assetImageSourceIds || Object.keys(data.sourceSignatures).length === Object.keys(signatures).length);
    });
    const orphans = nodes.filter((node) => {
        const data = nodeWorkflow(node);
        return !node.parentId && node.type === CanvasNodeType.Image && data?.pipelineId === first.pipelineId && data.step === first.step && data.mediaKind === "image" &&
            (first.stage === "assets" ? data.sourceNodeIds.includes(sourceNodeId) : data.mediaSubjectId === sourceNodeId) && sameSources(data);
    });
    const additions = [...orphans, ...created];
    const frame = existing || createCanvasNode(CanvasNodeType.Frame, created[0].position);
    if (!existing) frame.position = { ...created[0].position };
    const members = existing ? nodes.filter((node) => node.parentId === frame.id) : [];
    const placed = additions.map((node) => ({ ...node, parentId: frame.id }));
    const memberIds = [...members.map((node) => node.id), ...placed.map((node) => node.id)];
    const groupSignatures = first.assetImageSourceIds ? Object.assign({}, nodeWorkflow(existing)?.sourceSignatures, ...additions.map((node) => nodeWorkflow(node)!.sourceSignatures)) : signatures;
    const group: CanvasNodeData = { ...frame,
        title: existing?.title || `${source.title} · ${shortDramaStep(first.step)!.label}`,
        metadata: { ...frame.metadata, shortDrama: {
            stage: first.stage, step: first.step, pipelineId: first.pipelineId, role: "collection", mediaKind: "image", mediaGroup: { sourceNodeId },
            sourceNodeIds: memberIds, sourceSignatures: groupSignatures, collectionSourceIds: [sourceNodeId], parameters: first.parameters, episodeNumber: first.episodeNumber,
            version: nodeWorkflow(existing)?.version || nodeWorkflow(source)?.version || 1,
        } },
    };
    const placedById = new Map(placed.map((node) => [node.id, node]));
    const edges = connections.map((edge) => placedById.has(edge.toNodeId) ? { ...edge, toNodeId: group.id } : edge);
    for (const node of placed) for (const fromNodeId of nodeWorkflow(node)!.sourceNodeIds) {
        if (!edges.some((edge) => edge.fromNodeId === fromNodeId && edge.toNodeId === group.id)) edges.push({ id: nanoid(), fromNodeId, toNodeId: group.id });
    }
    const seen = new Set<string>();
    const laidOut = layoutWorkflowImageGroups([...nodes.map((node) => node.id === group.id ? group : placedById.get(node.id) || node), ...created.map((node) => placedById.get(node.id)!), ...(!existing ? [group] : [])], new Set([group.id]));
    const groupedNodes = placeNewWorkflowGroup(laidOut, group.id, nodes.filter(node => node.id !== group.id && node.parentId !== group.id && !placedById.has(node.id)), nodes.find(node => node.id === source.parentId) || source);
    const groupedById = new Map(groupedNodes.map((node) => [node.id, node]));
    return {
        nodes: groupedNodes,
        connections: edges.filter((edge) => { const key = `${edge.fromNodeId}:${edge.toNodeId}`; if (edge.toNodeId !== group.id) return true; if (seen.has(key)) return false; seen.add(key); return true; }),
        created: created.map((node) => groupedById.get(node.id)!),
    };
}
