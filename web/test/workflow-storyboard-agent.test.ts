import { expect, test } from "bun:test";
import { createWorkflowDocuments, defaultWorkflowSources, nodeWorkflow } from "@/lib/canvas/canvas-short-drama-workflow";
import { workflowImageFixture } from "./fixtures/workflow-image-project";

test("storyboard uses durable production agent with compact prompt and existing episode container", () => {
    const f = workflowImageFixture();
    const result = createWorkflowDocuments({ ...f.request, step: "direction.shots", model: "fixture::text", sourceNodeIds: defaultWorkflowSources("direction.shots", f.request.pipelineId, f.nodes).filter(Boolean) }, f.nodes, f.connections, { x: 0, y: 0 });
    expect(result.created.length).toBeGreaterThan(0);
    for (const node of result.created) {
        expect(nodeWorkflow(node)?.productionAgent).toEqual({});
        expect(nodeWorkflow(node)?.textBatch).toBeUndefined();
        expect(node.metadata!.prompt).toContain("逐场生成");
        expect(node.metadata!.prompt).not.toContain("关联来源：");
        const parent = result.nodes.find((entry) => entry.id === node.parentId)!;
        expect(nodeWorkflow(parent)?.sourceNodeIds).toContain(node.id);
        expect(nodeWorkflow(parent)?.step).toBe("direction.shots");
        expect(nodeWorkflow(node)?.sourceNodeIds.length).toBeGreaterThan(0);
    }
});
