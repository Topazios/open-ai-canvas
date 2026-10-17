import { describe, expect, test } from "bun:test";
import { compactWorkflowNodes, markWorkflowSubmissionBlocked } from "@/lib/canvas/canvas-workflow-persistence";
import { createWorkflowDocuments, defaultWorkflowSources, nodeWorkflow, workflowGenerationSources, workflowSignature } from "@/lib/canvas/canvas-short-drama-workflow";
import { deriveShortDramaProgress } from "@/lib/canvas/canvas-short-drama";
import { workflowImageFixture } from "./fixtures/workflow-image-project";
import { createWorkflowImages, workflowImageSubjects } from "@/lib/canvas/canvas-workflow-images";

describe("workflow save recovery and progress", () => {
    test("deduplicates legacy prompt copies without changing content, provenance or distinct editor drafts", () => {
        const f = workflowImageFixture();
        const node = f.nodes.find((node) => nodeWorkflow(node)?.step === "direction.shots" && nodeWorkflow(node)?.role !== "collection")!;
        node.metadata!.composerContent = node.metadata!.prompt;
        const before = JSON.stringify(f.nodes);
        const compact = compactWorkflowNodes(f.nodes);
        const saved = compact.find((entry) => entry.id === node.id)!;
        expect(saved.metadata!.composerContent).toBeUndefined();
        expect(saved.metadata!.prompt).toBe(node.metadata!.prompt);
        expect(saved.metadata!.content).toBe(node.metadata!.content);
        expect(saved.metadata!.shortDrama).toEqual(node.metadata!.shortDrama);
        expect(workflowSignature(saved)).toBe(workflowSignature(node));
        expect(JSON.stringify(f.nodes)).toBe(before);
        expect(JSON.stringify(compact).length).toBeLessThan(before.length);
        node.metadata!.composerContent = "手工调整的未提交草稿";
        expect(compactWorkflowNodes([node])[0]).toBe(node);
        const ordinary = { ...node, metadata: { prompt: "same", composerContent: "same" } };
        expect(compactWorkflowNodes([ordinary])[0]).toBe(ordinary);
    });

    test("save failures remain resumable and never replay accepted or uncertain submissions", () => {
        const f = workflowImageFixture();
        const result = createWorkflowDocuments({ ...f.request, step: "direction.shots", model: "fixture::text", sourceNodeIds: defaultWorkflowSources("direction.shots", f.request.pipelineId, f.nodes).filter(Boolean) }, f.nodes, f.connections, { x: 0, y: 0 });
        const node = result.created[0];
        const ids = result.created.map((entry) => entry.id);
        const before = JSON.stringify(result.nodes);
        const failed = markWorkflowSubmissionBlocked(result.nodes, ids, "云端保存失败");
        expect(JSON.stringify(result.nodes)).toBe(before);
        expect(failed.find((entry) => entry.id === node.id)!.metadata).toMatchObject({ status: "error", taskStage: "尚未提交生成", errorDetails: "云端保存失败", shortDrama: { submission: "planned", operationId: nodeWorkflow(node)!.operationId } });
        expect(node.metadata!.composerContent).toBeUndefined();
        for (const submission of ["unknown", "submitting", "submitted", "rejected"] as const) {
            nodeWorkflow(node)!.submission = submission;
            expect(markWorkflowSubmissionBlocked([node], [node.id], "later save failed")[0]).toBe(node);
        }
    });

    test("reports the missing required source specifically while scene planning is integrated", () => {
        const f = workflowImageFixture();
        const ids = defaultWorkflowSources("direction.shots", f.request.pipelineId, f.nodes).filter(Boolean);
        expect(() => workflowGenerationSources({ ...f.request, step: "direction.shots", sourceNodeIds: ids.filter((id) => nodeWorkflow(f.nodes.find((node) => node.id === id))?.step !== "story.body") }, f.nodes)).toThrow("请选择分集正文节点");
        expect(() => workflowGenerationSources({ ...f.request, step: "direction.shots", sourceNodeIds: ids }, f.nodes)).not.toThrow();
    });

    test("guide explains failed extraction and counts remaining reference subjects", () => {
        const f = workflowImageFixture({ failedAssetSummaries: true });
        let progress = deriveShortDramaProgress(f.nodes, f.connections);
        expect(progress.steps.find((step) => step.id === "assets")!.tasks.find((task) => task.id === "guide.assets.fixed")!.statusDetail).toContain("任务失败，提取未完成");
        const subjects = workflowImageSubjects(f.request, f.nodes);
        const result = createWorkflowImages({ ...f.request, imageSubjectIds: [subjects[0].id] }, f.nodes, f.connections, { x: 0, y: 0 });
        result.created[0].metadata!.status = "success";
        result.created[0].metadata!.storageKey = "resource:fixture-image";
        progress = deriveShortDramaProgress(result.nodes, result.connections);
        const references = progress.steps.find((step) => step.id === "assets")!.tasks.find((task) => task.id === "guide.assets.references")!;
        expect(references.ready).toBe(false);
        expect(references.statusDetail).toContain("已完成 1/2 项参考图");
        expect(progress.steps.find((step) => step.id === "storyboard")!.tasks.find((task) => task.id === "guide.direction.breakdown")!.ready).toBe(true);
    });
});
