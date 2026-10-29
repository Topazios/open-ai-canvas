import type { CanvasNodeData } from "@/types/canvas";
import { assetSheetKind, assetSheetPrompt } from "../asset-reference-sheet";
import { assetSheetSubjectMaterial, assetSheetStyleMaterial } from "../asset-sheet-material";
import { generationPromptFingerprint } from "../generation-error";
import { ProductionBibleSection } from "../production-bible";
import { globalSettingsPrompt } from "../short-drama-settings";
import { nodeWorkflow, workflowGenerationSources, workflowSignature } from "./canvas-short-drama-workflow";
import { resolveProductionAssetReferences } from "./production-asset-references";
import { assetSheetReferenceContent } from "./canvas-asset-sheet-context";

export function rebuildWorkflowImagePrompt(node: CanvasNodeData, nodes: CanvasNodeData[], visualOnly = false) {
    const data = nodeWorkflow(node);
    const kind = data && assetSheetKind(data.step);
    if (!data || data.mediaKind !== "image" || !kind || !data.assetSheet) throw new Error("当前节点不支持自动整理设定板要求，请使用手动编辑");
    if (data.assetSheet.version === 1) return node.metadata?.prompt || "";
    const ancestors = workflowGenerationSources(data, nodes);
    const subject = ancestors.find((entry) => entry.id === data.mediaSubjectId);
    if (!subject?.metadata?.content || data.sourceSignatures[subject.id] !== workflowSignature(subject)) {
        throw new Error("原资产已变化或缺失，请核对来源后重新生成");
    }
    const content = assetSheetSubjectMaterial(subject.metadata.content, kind);
    if (!content) throw new Error("资产缺少固定外观设计，请使用手动编辑补充生成要求");
    const styleNodes = Object.entries(data.assetSheet.styleSignatures).map(([id, signature]) => {
        const entry = ancestors.find((item) => item.id === id);
        if (!entry || workflowSignature(entry) !== signature) throw new Error("原制作规范版本已变化，请核对来源后重新生成");
        return entry;
    });
    const style = styleNodes.filter((entry) => nodeWorkflow(entry)?.bibleSection === ProductionBibleSection.Style || !nodeWorkflow(entry)?.bibleSection)
        .map((entry) => assetSheetStyleMaterial(entry.metadata?.content || "", kind)).filter(Boolean).join("\n\n");
    if (!style) throw new Error("缺少项目视觉风格，请核对制作规范后重试");
    const art = styleNodes.filter((entry) => nodeWorkflow(entry)?.bibleSection === ProductionBibleSection.ArtDirection)
        .map((entry) => assetSheetStyleMaterial(entry.metadata?.content || "", kind)).filter(Boolean).join("\n\n");
    const variant = data.mediaVariantCode ? nodeWorkflow(subject)?.assetProfile?.variants.find(item => item.code === data.mediaVariantCode) : undefined;
    if (data.mediaVariantCode && !variant) throw new Error("指定资产状态已变化，请重新选择来源");
    const instruction = [variant ? `指定状态 @${variant.code}（${variant.name}）：${variant.description}。沿用实体身份和身体比例，当前服化/外观以本状态为准；参考中的旧服装不覆盖此状态。` : "", data.parameters?.instruction].filter(Boolean).join("\n");
    const references = resolveProductionAssetReferences(instruction || "", ancestors, [], (entry) => assetSheetReferenceContent(entry, subject.id));
    return assetSheetPrompt({ kind, size: node.metadata?.size || data.assetSheet.size, title: [nodeWorkflow(subject)?.assetIdentity?.code, subject.title].filter(Boolean).join(" · "), content, style: [style, art].filter(Boolean).join("\n\n"), projectSettings: globalSettingsPrompt(data.parameters?.globalSettings, data.stage, "image"), references: references.content, instruction, visualOnly });
}

export function adjustWorkflowImagePrompt(node: CanvasNodeData, nodes: CanvasNodeData[], rejectedPrompt: string) {
    const prompt = rebuildWorkflowImagePrompt(node, nodes, true);
    if (generationPromptFingerprint(prompt) === generationPromptFingerprint(rejectedPrompt)) {
        throw new Error("已按当前资产调整过，仍未通过审核，请手动修改生成要求；未再次提交");
    }
    return prompt;
}
