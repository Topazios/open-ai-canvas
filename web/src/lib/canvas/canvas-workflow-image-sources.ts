import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import { assetSheetKind } from "../asset-reference-sheet";
import { ShortDramaStep, shortDramaStep, type ShortDramaWorkflowData } from "../short-drama-steps";
import { nodeWorkflow, workflowSignatureMatches, type WorkflowGenerationRequest } from "./canvas-short-drama-workflow";
import { workflowSourceMatches } from "./canvas-production-sources";
import { workflowImageSubjects } from "./canvas-workflow-images";

type ImageSourceRequest = Pick<WorkflowGenerationRequest, "step" | "pipelineId" | "sourceNodeIds" | "imageSubjectIds"> &
    Pick<Partial<ShortDramaWorkflowData>, "mediaSubjectId" | "assetImageSourceIds">;

export function workflowAssetImageSources(request: ImageSourceRequest, nodes: CanvasNodeData[], connections?: CanvasConnection[]) {
    const step = shortDramaStep(request.step);
    if (!step || !assetSheetKind(step.id)) throw new Error("请选择资产生图步骤");
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const source = byId.get(request.sourceNodeIds[0]), sourceData = nodeWorkflow(source);
    if (request.sourceNodeIds.length !== 1 || !source || sourceData?.pipelineId !== request.pipelineId || !workflowSourceMatches(source, step.requires[0], nodes)) throw new Error("请选择当前流程对应类别的资产来源");
    const candidates = workflowImageSubjects(request, nodes);
    const ids = request.mediaSubjectId ? [...new Set([request.mediaSubjectId, ...(request.assetImageSourceIds || []).filter((id) => candidates.some((node) => node.id === id))])] : request.imageSubjectIds || candidates.map((node) => node.id);
    if (!ids.length || new Set(ids).size !== ids.length || ids.some((id) => !candidates.some((node) => node.id === id))) throw new Error("请选择当前来源中已完成的生成对象");
    const subjects = ids.map((id) => byId.get(id)!);
    const endpoint = (id: string) => {
        const node = byId.get(id), parent = node?.parentId ? byId.get(node.parentId) : undefined;
        return nodeWorkflow(parent)?.role === "collection" ? parent!.id : id;
    };
    const linked = (from: string, to: string) => !connections || endpoint(from) === endpoint(to) || connections.some((edge) =>
        edge.fromNodeId === from && edge.toNodeId === to || endpoint(edge.fromNodeId) === endpoint(from) && endpoint(edge.toNodeId) === endpoint(to));
    const validateGroup = (node: CanvasNodeData) => {
        const data = nodeWorkflow(node)!;
        if (data.pipelineId !== request.pipelineId) throw new Error("资产分组不属于当前制作流程");
        if (data.planGroup) {
            const root = byId.get(data.planGroup.rootFrameId);
            if (nodeWorkflow(root)?.pipelineId !== request.pipelineId || nodeWorkflow(root)?.planGroups?.[data.planGroup.kind] !== node.id) throw new Error("资产分组与制作方案关联已变化");
            if (!linked(root!.id, node.id)) throw new Error("资产分组的方案来源连线已移除");
        }
    };
    if (sourceData.role === "collection") validateGroup(source);
    const guidelines = new Map<string, CanvasNodeData>();
    const seen = new Set<string>();
    // Collections are routing information. Their task state and growing member
    // lists are not inputs to an already completed asset's image generation.
    const discover = (id: string) => {
        if (seen.has(id)) return;
        seen.add(id);
        const node = byId.get(id), data = nodeWorkflow(node);
        if (!node || data?.pipelineId !== request.pipelineId) return;
        if (data.role !== "collection" && (data.bibleSection || data.step === ShortDramaStep.Style)) {
            if (node.metadata?.content?.trim() && !data.assetOutput && node.metadata?.status !== "loading" && node.metadata?.status !== "error" &&
                (!data.bibleSection || ["style", "art_direction", "generation"].includes(data.bibleSection))) guidelines.set(id, node);
            return;
        }
        if (data.assetRevision) { data.assetRevision.contextNodeIds.forEach(discover); return; }
        if (node.parentId) discover(node.parentId);
        if (data.planGroup) discover(data.planGroup.rootFrameId);
        (data.collectionSourceIds || []).forEach(discover);
        for (const upstreamId of data.sourceNodeIds) {
            const upstream = nodeWorkflow(byId.get(upstreamId));
            if (data.role !== "collection" || upstream?.bibleSection || upstream?.step === ShortDramaStep.Style || upstream?.role === "collection") discover(upstreamId);
        }
    };
    for (const subject of subjects) {
        const data = nodeWorkflow(subject)!;
        if (data.pipelineId !== request.pipelineId) throw new Error("资产不属于当前制作流程");
        const parent = subject.parentId ? byId.get(subject.parentId) : undefined;
        if (parent && nodeWorkflow(parent)?.role === "collection") validateGroup(parent);
        for (const upstreamId of data.sourceNodeIds) {
            if (!byId.has(upstreamId)) throw new Error("资产的前置节点已删除，请核对来源");
            if (!linked(upstreamId, subject.id)) throw new Error("资产的来源连线已移除，请恢复关联");
        }
        for (const [id, signature] of Object.entries(data.sourceSignatures)) {
            const upstream = byId.get(id), upstreamData = nodeWorkflow(upstream);
            if (!upstream) throw new Error("资产的前置节点已删除，请核对来源");
            if (upstreamData?.role === "collection" || upstreamData?.assetKey === "$summary") continue;
            if (!workflowSignatureMatches(upstream, signature)) throw new Error("资产的前文已更新，请核对当前资产版本");
        }
        discover(subject.id);
    }
    const inputs = request.assetImageSourceIds ? request.assetImageSourceIds.map((id) => {
        const node = byId.get(id);
        if (!node || (!ids.includes(id) && !guidelines.has(id))) throw new Error("生图使用的资产或视觉规范已缺失或关联已变化");
        return node;
    }) : [...subjects, ...guidelines.values()];
    if (ids.some((id) => !inputs.some((node) => node.id === id))) throw new Error("生图缺少所选资产内容");
    if (inputs.some((node) => node.type !== CanvasNodeType.Text || !node.metadata?.content?.trim() || node.metadata?.status === "loading" || node.metadata?.status === "error")) throw new Error("所选资产或视觉规范尚未完成");
    return [...new Map(inputs.map((node) => [node.id, node])).values()];
}
