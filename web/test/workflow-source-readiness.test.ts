import { describe, expect, test } from "bun:test";
import { workflowImageFixture } from "./fixtures/workflow-image-project";
import { assetItem } from "./fixtures/workflow-asset-output";
import { commitCanvasGenerationResult } from "@/lib/canvas/canvas-generation-result";
import { createWorkflowImages, workflowImageSubjects } from "@/lib/canvas/canvas-workflow-images";
import { createWorkflowDocuments, defaultWorkflowSources, nodeWorkflow, workflowAncestors } from "@/lib/canvas/canvas-short-drama-workflow";
import { deriveShortDramaProgress } from "@/lib/canvas/canvas-short-drama";

const center = { x: 0, y: 0 };
const categories = [
    ["assets.characters", "assets.character_references"],
    ["assets.environments", "assets.environment_references"],
    ["assets.props", "assets.prop_references"],
    ["assets.special", "assets.special_references"],
] as const;

function fixture() {
    const f = workflowImageFixture();
    const step = "assets.special";
    const result = createWorkflowDocuments({ ...f.request, step, sourceNodeIds: defaultWorkflowSources(step, f.request.pipelineId, f.nodes).filter(Boolean) }, f.nodes, f.connections, center);
    const manifest = result.created[0];
    f.nodes = commitCanvasGenerationResult(result.nodes, manifest, { ...manifest, metadata: { ...manifest.metadata, status: "success", content: JSON.stringify({ summary: "Special assets", items: [assetItem("Signal", "Fixed interface", 1)] }) } }, "special-task");
    f.connections = result.connections;
    return f;
}

describe("asset task state and usable output are independent", () => {
    for (const [step, imageStep] of categories) {
        test(`${step}: saved assets remain usable after a failed or still-running summary`, () => {
            const f = fixture();
            const group = f.nodes.find((node) => nodeWorkflow(node)?.step === step && nodeWorkflow(node)?.assetGroup)!;
            const manifest = f.nodes.find((node) => node.id === nodeWorkflow(group)!.assetGroup!.manifestId)!;
            for (const status of ["error", "loading"] as const) {
                Object.assign(manifest.metadata!, { status, content: "" });
                Object.assign(nodeWorkflow(manifest)!, { assetOutput: true, materializedTaskId: undefined });
                const before = JSON.stringify(f.nodes);
                const request = { ...f.request, step: imageStep, sourceNodeIds: [group.id] };
                expect(defaultWorkflowSources(imageStep, f.request.pipelineId, f.nodes)).toEqual([group.id]);
                const subjects = workflowImageSubjects(request, f.nodes);
                expect(subjects.length).toBeGreaterThan(0);
                const result = createWorkflowImages({ ...request, imageSubjectIds: subjects.map((node) => node.id) }, f.nodes, f.connections, center);
                expect(result.created).toHaveLength(subjects.length);
                expect(result.created.every((node) => !Object.hasOwn(nodeWorkflow(node)!.sourceSignatures, manifest.id))).toBe(true);
                expect(JSON.stringify(f.nodes)).toBe(before);
                expect(workflowAncestors([group.id], f.nodes, f.request.pipelineId, f.connections).some((node) => node.id === manifest.id)).toBe(false);
            }
        });
    }

    test("failed extraction is not marked complete merely because downstream images are available", () => {
        const f = fixture();
        const group = f.nodes.find((node) => nodeWorkflow(node)?.step === "assets.characters" && nodeWorkflow(node)?.assetGroup)!;
        const manifest = f.nodes.find((node) => node.id === nodeWorkflow(group)!.assetGroup!.manifestId)!;
        manifest.metadata!.status = "error";
        nodeWorkflow(manifest)!.assetOutput = true;
        const task = deriveShortDramaProgress(f.nodes, f.connections).steps.find((step) => step.id === "assets")!.tasks.find((task) => task.id === "guide.assets.fixed")!;
        expect(task.ready).toBe(false);
        expect(task.progressLabel).toBe("2/3 项已产出");
    });

    test("empty pending groups, failed children and missing or stale members still block generation", () => {
        for (const invalid of ["empty", "failed-child", "deleted-child", "moved-child", "deleted-summary", "stale-child", "disconnected"] as const) {
            const f = fixture();
            const group = f.nodes.find((node) => nodeWorkflow(node)?.step === "assets.characters" && nodeWorkflow(node)?.assetGroup)!;
            const data = nodeWorkflow(group)!;
            const manifest = f.nodes.find((node) => node.id === data.assetGroup!.manifestId)!;
            manifest.metadata!.status = "error";
            nodeWorkflow(manifest)!.assetOutput = true;
            const child = f.nodes.find((node) => node.parentId === group.id && node.id !== manifest.id)!;
            if (invalid === "empty") { f.nodes = f.nodes.filter((node) => node.parentId !== group.id || node.id === manifest.id); data.sourceNodeIds = [manifest.id]; }
            if (invalid === "failed-child") child.metadata!.status = "error";
            if (invalid === "deleted-child") f.nodes = f.nodes.filter((node) => node.id !== child.id);
            if (invalid === "moved-child") child.parentId = undefined;
            if (invalid === "deleted-summary") f.nodes = f.nodes.filter((node) => node.id !== manifest.id);
            if (invalid === "stale-child") nodeWorkflow(child)!.sourceSignatures[nodeWorkflow(child)!.sourceNodeIds[0]] = "v2:invalid";
            if (invalid === "disconnected") f.connections = [];
            expect(() => workflowAncestors([group.id], f.nodes, f.request.pipelineId, f.connections)).toThrow();
        }
    });

    test("successful explicit empty groups remain valid without inventing image subjects", () => {
        const f = fixture();
        const group = f.nodes.find((node) => nodeWorkflow(node)?.step === "assets.special" && nodeWorkflow(node)?.assetGroup)!;
        const data = nodeWorkflow(group)!;
        f.nodes = f.nodes.filter((node) => node.parentId !== group.id || node.id === data.assetGroup!.manifestId);
        data.sourceNodeIds = [data.assetGroup!.manifestId];
        expect(workflowAncestors([group.id], f.nodes, f.request.pipelineId, f.connections).at(-1)?.id).toBe(group.id);
        expect(workflowImageSubjects({ step: "assets.special_references", sourceNodeIds: [group.id] }, f.nodes)).toHaveLength(0);
    });

    test("shot documents, prompts, voice casting and all frame steps use the same corrected source validation", () => {
        const f = fixture();
        for (const node of f.nodes) {
            if (nodeWorkflow(node)?.assetKey === "$summary" && nodeWorkflow(node)?.step !== "assets.bible") {
                node.metadata!.status = "error";
                nodeWorkflow(node)!.assetOutput = true;
            }
        }
        for (const step of ["direction.shots", "direction.production", "voice.dialogue"] as const) {
            const sourceNodeIds = defaultWorkflowSources(step, f.request.pipelineId, f.nodes).filter(Boolean);
            const result = createWorkflowDocuments({ ...f.request, step, sourceNodeIds }, f.nodes, f.connections, center);
            expect(result.created.length).toBeGreaterThan(0);
            if (step === "voice.dialogue") {
                result.created.forEach((node) => Object.assign(node.metadata!, { status: "success", content: "Dialogue" }));
                const casting = createWorkflowDocuments({ ...f.request, step: "voice.casting", sourceNodeIds: defaultWorkflowSources("voice.casting", f.request.pipelineId, result.nodes).filter(Boolean) }, result.nodes, result.connections, center);
                expect(casting.created.length).toBeGreaterThan(0);
            }
        }
        for (const step of ["direction.boards", "direction.start_frame", "direction.end_frame", "direction.keyframes"] as const) {
            const request = { ...f.request, step, sourceNodeIds: defaultWorkflowSources(step, f.request.pipelineId, f.nodes).filter(Boolean) };
            const subject = workflowImageSubjects(request, f.nodes)[0];
            const result = createWorkflowImages({ ...request, imageSubjectIds: [subject.id], imagePrompt: "Shot frame" }, f.nodes, f.connections, center);
            expect(result.created).toHaveLength(1);
        }
    });
});
