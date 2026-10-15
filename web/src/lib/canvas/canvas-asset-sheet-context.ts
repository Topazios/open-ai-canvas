import type { CanvasNodeData } from "@/types/canvas";
import { ShortDramaStep } from "../short-drama-steps";
import { ProductionBibleSection } from "../production-bible";
import { assetSheetRatio } from "../asset-reference-sheet";
import { nodeWorkflow, workflowSignature } from "./canvas-short-drama-workflow";

const styleSections = [ProductionBibleSection.Style, ProductionBibleSection.ArtDirection, ProductionBibleSection.Generation];

export function workflowAssetSheetContext(ancestors: CanvasNodeData[], nodes: CanvasNodeData[], pipelineId: string) {
    const guidelines = ancestors.filter((node) => {
        const data = nodeWorkflow(node);
        return data?.pipelineId === pipelineId && data.role !== "collection" &&
            (data.bibleSection ? styleSections.includes(data.bibleSection) : data.step === ShortDramaStep.Style) && Boolean(node.metadata?.content?.trim());
    }).sort((a, b) => {
        const section = (node: CanvasNodeData) => nodeWorkflow(node)?.bibleSection || ProductionBibleSection.Style;
        return styleSections.indexOf(section(a)) - styleSections.indexOf(section(b)) || a.id.localeCompare(b.id);
    });
    if (!guidelines.some((node) => !nodeWorkflow(node)?.bibleSection || nodeWorkflow(node)?.bibleSection === ProductionBibleSection.Style)) {
        throw new Error("当前资产来源缺少全局视觉风格，请关联本项目的统一制作规范后生成设定板");
    }
    const styleSignatures = Object.fromEntries(guidelines.map((node) => [node.id, workflowSignature(node)]));
    const sameStyle = (other: Record<string, string>) => Object.keys(other).length === guidelines.length && guidelines.every((node) => other[node.id] === styleSignatures[node.id]);
    const existing = nodes.filter((node) => {
        const data = nodeWorkflow(node);
        return data?.pipelineId === pipelineId && data.mediaKind === "image" && data.assetSheet?.version === 1 && sameStyle(data.assetSheet.styleSignatures);
    });
    const size = existing[0]?.metadata?.shortDrama?.assetSheet?.size;
    if (size && existing.some((node) => Math.abs(assetSheetRatio(node.metadata!.shortDrama!.assetSheet!.size) / assetSheetRatio(size) - 1) >= 0.025)) {
        throw new Error("同一制作规范下存在不一致的设定板画幅，请先统一图片规格");
    }
    return { styleSignatures, size, style: guidelines.map((node) => `${node.title}：\n${node.metadata!.content}`).join("\n\n") };
}
