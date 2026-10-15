import type { CanvasNodeData } from "@/types/canvas";
import { assetSheetKind, assetSheetPrompt } from "../asset-reference-sheet";
import { generationPromptFingerprint } from "../generation-error";
import { ProductionBibleSection } from "../production-bible";
import { nodeWorkflow, workflowGenerationSources, workflowSignature } from "./canvas-short-drama-workflow";

// Production documents use the fixed level-two headings from productionRenderDocument.
// Keep complete design sections; do not remove isolated words or disguise the subject.
function designSections(content: string, names: string[]) {
    const sections = new Map<string, string[]>();
    let heading: string | undefined;
    for (const line of content.split(/\r?\n/)) {
        if (line.startsWith("## ")) {
            heading = line.slice(3).trim();
            if (!sections.has(heading)) sections.set(heading, []);
        } else if (heading) sections.get(heading)!.push(line);
    }
    if (!sections.size) return content.trim();
    return names.map((name) => sections.get(name)?.join("\n").trim()).filter(Boolean).join("\n\n");
}

export function adjustWorkflowImagePrompt(node: CanvasNodeData, nodes: CanvasNodeData[], rejectedPrompt: string) {
    const data = nodeWorkflow(node);
    const kind = data && assetSheetKind(data.step);
    if (!data || data.mediaKind !== "image" || !kind || !data.assetSheet) throw new Error("当前节点不支持自动整理设定板要求，请使用手动编辑");
    const ancestors = workflowGenerationSources(data, nodes);
    const subject = ancestors.find((entry) => entry.id === data.mediaSubjectId);
    if (!subject?.metadata?.content || data.sourceSignatures[subject.id] !== workflowSignature(subject)) {
        throw new Error("原资产已变化或缺失，请核对来源后重新生成");
    }
    const content = designSections(subject.metadata.content, ["固定特征与制作设计"]);
    if (!content) throw new Error("资产缺少固定外观设计，请使用手动编辑补充生成要求");
    const styleNodes = Object.entries(data.assetSheet.styleSignatures).map(([id, signature]) => {
        const entry = ancestors.find((item) => item.id === id);
        if (!entry || workflowSignature(entry) !== signature) throw new Error("原制作规范版本已变化，请核对来源后重新生成");
        return entry;
    });
    const style = styleNodes.filter((entry) => nodeWorkflow(entry)?.bibleSection === ProductionBibleSection.Style || !nodeWorkflow(entry)?.bibleSection)
        .map((entry) => designSections(entry.metadata?.content || "", ["统一视觉风格", "风格提示词"])).filter(Boolean).join("\n\n");
    if (!style) throw new Error("缺少项目视觉风格，请核对制作规范后重试");
    const art = styleNodes.filter((entry) => nodeWorkflow(entry)?.bibleSection === ProductionBibleSection.ArtDirection)
        .map((entry) => designSections(entry.metadata?.content || "", ["美术与服化道"])).filter(Boolean).join("\n\n");
    const prompt = assetSheetPrompt({ kind, size: node.metadata?.size || data.assetSheet.size, title: subject.title, content, style: [style, art].filter(Boolean).join("\n\n"), visualOnly: true });
    if (generationPromptFingerprint(prompt) === generationPromptFingerprint(rejectedPrompt)) {
        throw new Error("已按当前资产调整过，仍未通过审核，请手动修改生成要求；未再次提交");
    }
    return prompt;
}
