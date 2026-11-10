import { expect, test } from "bun:test";
import { workflowImageFixture } from "./fixtures/workflow-image-project";
import { createWorkflowImages, refreshPendingWorkflowImage, workflowImageSubjects } from "@/lib/canvas/canvas-workflow-images";
import { nodeWorkflow, workflowGenerationSources } from "@/lib/canvas/canvas-short-drama-workflow";
import { assetSheetReferenceSources } from "@/lib/canvas/canvas-asset-sheet-context";
import { productionAssetMentions, resolveProductionAssetReferences } from "@/lib/canvas/production-asset-references";
import { rebuildWorkflowImagePrompt } from "@/lib/canvas/canvas-image-prompt-adjustment";

function fixture() {
    const f = workflowImageFixture();
    const original = workflowImageSubjects(f.request, f.nodes)[0];
    original.metadata!.content = "## 年龄感、体型、面部与辨识特征\n成年女性，OLD_BLUE_MARK\n## 固定服装、配饰与材质配色\n蓝衫";
    Object.assign(nodeWorkflow(original)!, { assetIdentity: { id: "same-person", code: "CHR-0001", kind: "character" }, assetVersion: 1 });
    const revised = structuredClone(original);
    revised.id += "-new"; revised.title += " · 第 2 版";
    revised.metadata!.content = "## 年龄感、体型、面部与辨识特征\n成年女性，NEW_GREEN_MARK\n## 固定服装、配饰与材质配色\n绿衫";
    nodeWorkflow(revised)!.assetVersion = 2;
    f.nodes.push(revised);
    nodeWorkflow(f.nodes.find(n => n.id === original.parentId))!.sourceNodeIds.push(revised.id);
    const request = { ...f.request, imageSubjectIds: [revised.id, original.id], instruction: "@CHR-0001 按本次所选档案的外观绘制" };
    return { ...f, original, revised, request };
}

test("batching two asset versions creates separate images pinned to the chosen documents", () => {
    const f = fixture(), before = JSON.stringify(f.nodes);
    const sources = workflowGenerationSources(f.request, f.nodes, f.connections);
    const mentions = productionAssetMentions(assetSheetReferenceSources(sources));
    expect(mentions.filter(entry => entry.label === "CHR-0001")).toHaveLength(1);
    const result = createWorkflowImages(f.request, f.nodes, f.connections, { x: 0, y: 0 });
    expect(result.created).toHaveLength(2);
    for (const [index, subject] of [f.revised, f.original].entries()) {
        const other = subject === f.original ? f.revised : f.original;
        const image = result.created[index], data = nodeWorkflow(image)!;
        expect(data.mediaSubjectId).toBe(subject.id);
        expect(data.assetImageSourceIds).toContain(subject.id);
        expect(data.assetImageSourceIds).not.toContain(other.id);
        expect(Object.keys(data.sourceSignatures)).not.toContain(other.id);
        expect(image.metadata!.prompt).toContain(subject === f.original ? "OLD_BLUE_MARK" : "NEW_GREEN_MARK");
        expect(image.metadata!.prompt).not.toContain(subject === f.original ? "NEW_GREEN_MARK" : "OLD_BLUE_MARK");
        const pinned = workflowGenerationSources(data, result.nodes, result.connections);
        expect(pinned.map(node => node.id)).toContain(subject.id);
        expect(pinned.map(node => node.id)).not.toContain(other.id);
        expect(rebuildWorkflowImagePrompt(image, result.nodes)).toContain(subject === f.original ? "OLD_BLUE_MARK" : "NEW_GREEN_MARK");
        expect(nodeWorkflow(refreshPendingWorkflowImage(image, result.nodes, result.connections))!.mediaSubjectId).toBe(subject.id);
    }
    expect(JSON.stringify(f.nodes)).toBe(before);
});

test("unused duplicate versions do not block reference resolution; actual ambiguous and conflicting references remain checked", () => {
    const f = fixture();
    expect(resolveProductionAssetReferences("没有引用资产", [f.original, f.revised]).nodes).toEqual([]);
    expect(() => resolveProductionAssetReferences("@CHR-0001", [f.original, f.revised])).toThrow("多个版本");
    expect(resolveProductionAssetReferences("@CHR-0001", assetSheetReferenceSources([f.revised, f.original], f.original.id)).nodes).toEqual([f.original]);
    nodeWorkflow(f.revised)!.assetIdentity!.id = "different-person";
    expect(() => assetSheetReferenceSources([f.original, f.revised], f.original.id)).toThrow("编码冲突");
});
