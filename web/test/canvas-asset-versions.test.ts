import { expect, test } from "bun:test";
import { assetVersionStats, currentAssetDocumentIds } from "@/lib/canvas/canvas-asset-versions";
import { productionAssetDocuments, resolveProductionAssetReferences } from "@/lib/canvas/production-asset-references";
import { assetSheetReferenceSources } from "@/lib/canvas/canvas-asset-sheet-context";
import { workflowSignature } from "@/lib/canvas/canvas-short-drama-workflow";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function version(number: number, adopted?: boolean): CanvasNodeData {
    return { id: `doc-${number}`, title: `人物 · 第${number}版`, type: CanvasNodeType.Text, parentId: "group", position: { x: 0, y: 0 }, width: 400, height: 280,
        metadata: { status: "success", content: `第${number}版正文`, shortDrama: { stage: "story", step: "story.plan", role: "document", pipelineId: "pipeline", sourceNodeIds: [], sourceSignatures: {},
            assetIdentity: { id: "person", code: "CHR-D001-001", kind: "character" }, assetVersion: number, assetAdopted: adopted } } };
}

test("adopted revision wins regardless of node order; counts use unique identities", () => {
    const nodes = [version(1, false), version(2, true), version(3, false)];
    for (const ordered of [nodes, [...nodes].reverse()]) {
        expect([...currentAssetDocumentIds(ordered)]).toEqual(["doc-2"]);
        expect(productionAssetDocuments(ordered).map(n => n.id)).toEqual(["doc-2"]);
        expect(assetVersionStats(ordered)).toMatchObject({ assets: 1, completed: 1, versions: 3 });
    }
});

test("references resolve adopted documents but explicit pinned history remains pinned", () => {
    const nodes = [version(1, false), version(2, true), version(3, false)];
    expect(resolveProductionAssetReferences("@CHR-D001-001", nodes).nodes[0].id).toBe("doc-2");
    const pinned = assetSheetReferenceSources(nodes, "doc-1");
    expect(resolveProductionAssetReferences("@CHR-D001-001", pinned).nodes[0].id).toBe("doc-1");
    expect(assetSheetReferenceSources(nodes)[0].id).toBe("doc-2");
    const signature = workflowSignature(nodes[1]);
    nodes[1].metadata!.shortDrama!.assetAdopted = false;
    expect(workflowSignature(nodes[1])).toBe(signature);
    expect(() => productionAssetDocuments(nodes)).toThrow("多个版本");
});

test("multiple adopted documents and conflicting codes are rejected", () => {
    const nodes = [version(1, true), version(2, true)];
    expect(() => productionAssetDocuments(nodes)).toThrow("多个版本");
    nodes[1].metadata!.shortDrama!.assetIdentity!.id = "another-person";
    expect(() => productionAssetDocuments(nodes)).toThrow("编码冲突");
});

test("legacy histories have deterministic presentation without rewriting stored nodes", () => {
    const nodes = [version(2), version(1)], snapshot = JSON.stringify(nodes);
    expect([...currentAssetDocumentIds(nodes)]).toEqual(["doc-2"]);
    expect(JSON.stringify(nodes)).toBe(snapshot);
    expect(() => productionAssetDocuments(nodes)).toThrow("多个版本");
});
