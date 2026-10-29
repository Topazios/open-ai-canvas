import { describe, expect, test } from "bun:test";
import { productionRuleBlock } from "../src/lib/production-rules";
import { workflowImageFixture } from "./fixtures/workflow-image-project";
import { createWorkflowImages, refreshPendingWorkflowImage, workflowImageSubjectHasGeneratedResult, workflowImageSubjects, workflowImageReferences, workflowImageShots } from "@/lib/canvas/canvas-workflow-images";
import { createWorkflowDocuments, defaultWorkflowSources, nodeWorkflow, workflowAncestors, workflowSignature, workflowSignatureMatches, workflowSourceSignaturesMatch } from "@/lib/canvas/canvas-short-drama-workflow";
import { deriveShortDramaProgress } from "@/lib/canvas/canvas-short-drama";
import { assetMediaSignature } from "@/lib/canvas/canvas-workflow-asset-profile";
import { createCanvasNode } from "@/lib/canvas/canvas-project-domain";
import { CanvasNodeType } from "@/types/canvas";
import { prepareBackendGenerationTask } from "@/services/api/generation-task";
import { createModelChannel, defaultConfig } from "@/stores/use-config-store";
import { retryWorkflowGeneration } from "@/services/workflow-generation-retry";

describe("direct workflow image generation", () => {
    test("selected assets produce distinct image nodes with container provenance and isolated prompts", async () => {
        const f = workflowImageFixture();
        const before = JSON.stringify(f);
        const subjects = workflowImageSubjects(f.request, f.nodes);
        expect(subjects).toHaveLength(2);
        const result = createWorkflowImages({ ...f.request, imageSubjectIds: subjects.map((node) => node.id) }, f.nodes, f.connections, { x: 0, y: 0 });
        expect(JSON.stringify(f)).toBe(before);
        expect(result.created).toHaveLength(2);
        for (const [index, node] of result.created.entries()) {
            expect(node.type).toBe(CanvasNodeType.Image);
            expect(node.metadata).toMatchObject({ generationMode: "image", model: f.request.model, size: "1536x1024", count: 1 });
            expect(nodeWorkflow(node)).toMatchObject({ step: f.request.step, mediaKind: "image", mediaSubjectId: subjects[index].id, submission: "planned", sourceNodeIds: f.request.sourceNodeIds });
            expect(nodeWorkflow(node)?.productionAgent).toBeUndefined();
            expect(nodeWorkflow(node)?.textBatch).toBeUndefined();
            expect(node.metadata?.prompt).toContain(subjects[index].metadata!.content!);
            expect(node.metadata?.prompt).not.toContain(subjects[1 - index].metadata!.content!);
            expect(result.connections.filter((edge) => edge.toNodeId === node.parentId).map((edge) => edge.fromNodeId)).toEqual(f.request.sourceNodeIds);
        }
        const channel = createModelChannel({ id: "fixture", baseUrl: "https://example.invalid/v1", apiKey: "fixture-only", models: ["image"], modelCosts: [{ model: "image", capability: "image", protocol: "openai-images", billingMode: "fixed_request", unitPriceMicrocredits: 1 }] });
        const node = result.created[0];
        const input = await prepareBackendGenerationTask({ projectId: "fixture", mode: "image", prompt: node.metadata!.prompt!, config: { ...defaultConfig, channels: [channel], model: f.request.model, count: "1" }, clientOperationId: nodeWorkflow(node)!.operationId });
        expect(input.type).toBe("canvas_image");
        expect(input.input.mode).toBe("image");
    });

    test("invalid selection, changed text and missing connections cannot submit stale assets", () => {
        const f = workflowImageFixture();
        expect(() => createWorkflowImages(f.request, f.nodes, f.connections, { x: 0, y: 0 })).toThrow("生成对象");
        expect(() => createWorkflowImages({ ...f.request, imageSubjectIds: ["unrelated"] }, f.nodes, f.connections, { x: 0, y: 0 })).toThrow("生成对象");
        const subject = workflowImageSubjects(f.request, f.nodes)[0];
        const result = createWorkflowImages({ ...f.request, imageSubjectIds: [subject.id] }, f.nodes, f.connections, { x: 0, y: 0 });
        const image = result.created[0]; image.metadata!.content = "fixture.png"; image.metadata!.status = "success";
        expect(workflowAncestors([image.id], result.nodes, f.request.pipelineId, result.connections).at(-1)?.id).toBe(image.id);
        expect(() => workflowAncestors([image.id], result.nodes, f.request.pipelineId, [])).toThrow("连线");
        subject.metadata!.content += " changed";
        expect(() => workflowAncestors([image.id], result.nodes, f.request.pipelineId, result.connections)).toThrow("前文已更新");
    });

    test("explicit retry rebuilds a pending asset image from current source content", () => {
        const f = workflowImageFixture();
        const subject = workflowImageSubjects(f.request, f.nodes)[0];
        const result = createWorkflowImages({ ...f.request, imageSubjectIds: [subject.id] }, f.nodes, f.connections, { x: 0, y: 0 });
        const pending = result.created[0];
        subject.metadata!.content = `${subject.metadata!.content}\n人物服装更新为深绿色外套`;

        expect(workflowSourceSignaturesMatch(nodeWorkflow(pending)!, result.nodes)).toBe(false);
        const refreshed = refreshPendingWorkflowImage(pending, result.nodes, result.connections);

        expect(refreshed?.metadata?.prompt).toContain("深绿色外套");
        expect(workflowSourceSignaturesMatch(nodeWorkflow(refreshed)!, result.nodes)).toBe(true);
    });

    test("generated asset images are recognized until their output node is deleted", () => {
        const f = workflowImageFixture();
        const subject = workflowImageSubjects(f.request, f.nodes)[0];
        const result = createWorkflowImages({ ...f.request, imageSubjectIds: [subject.id] }, f.nodes, f.connections, { x: 0, y: 0 });
        const image = result.created[0];
        image.metadata!.status = "success";
        image.metadata!.content = "generated-image-data";

        expect(workflowImageSubjectHasGeneratedResult(f.request.step, subject.id, result.nodes)).toBe(true);
        const afterDeletion = result.nodes.filter((node) => node.id !== image.id);
        expect(workflowImageSubjectHasGeneratedResult(f.request.step, subject.id, afterDeletion)).toBe(false);
        expect(createWorkflowImages({ ...f.request, imageSubjectIds: [subject.id] }, afterDeletion, result.connections.filter((edge) => edge.fromNodeId !== image.id && edge.toNodeId !== image.id), { x: 0, y: 0 }).created).toHaveLength(1);
    });

    test("reference images are signed, passed as media and invalidated on replacement", () => {
        const f = workflowImageFixture();
        const subject = workflowImageSubjects(f.request, f.nodes)[0];
        const reference = createCanvasNode(CanvasNodeType.Image, { x: 0, y: 0 }, { storageKey: "resource:fixture-reference", status: "success" });
        f.nodes.push(reference);
        nodeWorkflow(subject)!.assetProfile!.references = [{ nodeId: reference.id, signature: assetMediaSignature(reference), selected: true, variant: "base" }];
        const request = { ...f.request, imageSubjectIds: [subject.id] };
        const result = createWorkflowImages(request, f.nodes, f.connections, { x: 0, y: 0 });
        expect(workflowImageReferences(result.created[0], result.nodes)[0].storageKey).toBe("resource:fixture-reference");
        reference.metadata!.storageKey = "resource:changed";
        expect(() => workflowImageReferences(result.created[0], result.nodes)).toThrow("参考图版本");
        expect(() => createWorkflowImages(request, f.nodes, f.connections, { x: 0, y: 0 })).toThrow("参考图版本");
    });

    test("scene and shot breakdown runs once; frames are selectable without producing all other frames", () => {
        const f = workflowImageFixture();
        expect(f.nodes.some((node) => nodeWorkflow(node)?.step === "direction.scenes")).toBe(false);
        const shots = f.nodes.find((node) => nodeWorkflow(node)?.step === "direction.shots" && node.type === CanvasNodeType.Script)!;
        expect(shots.metadata?.prompt).toContain("一次完成场次调度");
        const request = { ...f.request, step: "direction.boards" as const, sourceNodeIds: defaultWorkflowSources("direction.boards", f.request.pipelineId, f.nodes).filter(Boolean), imagePrompt: "EP01-SH02: medium close-up, protagonist opens the door" };
        const subject = workflowImageSubjects(request, f.nodes)[0];
        const result = createWorkflowImages({ ...request, imageSubjectIds: [subject.id] }, f.nodes, f.connections, { x: 0, y: 0 });
        expect(result.created[0].metadata?.prompt).toContain("EP01-SH02");
        expect(result.created[0].metadata?.prompt?.startsWith(productionRuleBlock("storyboard", "image"))).toBe(true);
        expect(result.created[0].metadata?.prompt?.split("【制作执行规范 v")).toHaveLength(2);
        expect(nodeWorkflow(result.created[0])?.episodeNumber).toBe(1);
        expect(nodeWorkflow(result.created[0])?.sourceSteps).toEqual(["direction.shots"]);
        expect(() => createWorkflowImages({ ...request, imagePrompt: "", imageSubjectIds: [subject.id] }, f.nodes, f.connections, { x: 0, y: 0 })).toThrow("镜头编号");
        for (const step of ["direction.start_frame", "direction.end_frame", "direction.keyframes"] as const) {
            const request = { ...f.request, step, sourceNodeIds: defaultWorkflowSources(step, f.request.pipelineId, f.nodes).filter(Boolean), imagePrompt: "EP01-SH02: medium close-up, protagonist opens the door" };
            const subject = workflowImageSubjects(request, f.nodes)[0];
            expect(() => createWorkflowImages({ ...request, imageSubjectIds: [subject.id] }, f.nodes, f.connections, { x: 0, y: 0 })).toThrow("分镜列表中生成");
        }
    });

    test("guide retains optional actions and requires real images for all assets", () => {
        const f = workflowImageFixture();
        const progress = deriveShortDramaProgress(f.nodes, f.connections);
        const task = progress.steps.find((step) => step.id === "story")!.tasks.find(task => task.id === "guide.assets.references")!;
        expect(task.ready).toBe(false);
        expect(task.stepIds).toEqual(["assets.character_references", "assets.environment_references", "assets.prop_references"]);
        const subjects = workflowImageSubjects(f.request, f.nodes);
        const partial = createWorkflowImages({ ...f.request, imageSubjectIds: [subjects[0].id] }, f.nodes, f.connections, { x: 0, y: 0 });
        partial.created[0].metadata!.status = "success"; partial.created[0].metadata!.storageKey = "resource:one";
        const entry = deriveShortDramaProgress(partial.nodes, partial.connections).steps.find((step) => step.id === "story")!.tasks.find(task => task.id === "guide.assets.references")!;
        expect(entry.entryStepId).toBe("assets.character_references");
        expect(entry.ready).toBe(false);
        const all = createWorkflowImages({ ...f.request, imageSubjectIds: subjects.map((node) => node.id) }, f.nodes, f.connections, { x: 0, y: 0 });
        all.created.forEach((node) => { node.metadata!.status = "success"; node.metadata!.storageKey = `resource:${node.id}`; });
        expect(deriveShortDramaProgress(all.nodes, all.connections).steps.find((step) => step.id === "story")!.tasks.find(task => task.id === "guide.assets.references")!.entryStepId).toBe("assets.environment_references");
        const before = workflowSignature(all.created[0]); all.created[0].metadata!.storageKey = "resource:replacement";
        expect(workflowSignature(all.created[0])).not.toBe(before);
    });

    test("unsubmitted image retry uses image mode and its saved model and settings", async () => {
        const f = workflowImageFixture();
        const subject = workflowImageSubjects(f.request, f.nodes)[0];
        const result = createWorkflowImages({ ...f.request, imageSubjectIds: [subject.id] }, f.nodes, f.connections, { x: 0, y: 0 });
        let prepared: any;
        const api = { prepare: async (input: any) => { prepared = input; return input; }, create: async () => ({ id: "created" } as any), query: async () => { throw new Error("unexpected"); }, retry: async () => { throw new Error("unexpected"); } };
        await retryWorkflowGeneration(result.created[0], undefined, "fixture", defaultConfig, api, result.nodes);
        expect(prepared.mode).toBe("image"); expect(prepared.config.model).toBe(f.request.model);
        expect(prepared.config.size).toBe("1536x1024"); expect(prepared.config.count).toBe("1");
        expect(prepared.workflowBatch).toBeUndefined(); expect(prepared.streamText).toBe(false);
    });

    test("structured shots automatically choose the matching frame prompt without a text request", () => {
        const f = workflowImageFixture();
        const request = { ...f.request, step: "direction.end_frame" as const, sourceNodeIds: defaultWorkflowSources("direction.end_frame", f.request.pipelineId, f.nodes).filter(Boolean) };
        const subject = workflowImageSubjects(request, f.nodes)[0];
        const shots = workflowImageShots(subject, request.step);
        expect(shots.map((shot) => shot.id)).toEqual(["SH01", "SH02"]);
        expect(() => createWorkflowImages({ ...request, imageSubjectIds: [subject.id], imageShotId: "SH02" }, f.nodes, f.connections, { x: 0, y: 0 })).toThrow("分镜列表中生成");
        expect(workflowImageShots(subject, "direction.keyframes")).toEqual([]);
        const legacy = f.nodes.find(node => nodeWorkflow(node)?.step === "direction.production" && node.type === CanvasNodeType.Text)!;
        expect(workflowImageShots(legacy, "direction.keyframes")[1].id).toBe("SH02/K1");
        expect(workflowImageShots(subject, "direction.end_frame").find((shot) => shot.id === "missing")).toBeUndefined();
        subject.metadata!.content = "Legacy freeform production document";
        subject.metadata!.storyboard = undefined;
        expect(workflowImageShots(subject, request.step)).toEqual([]);
    });

    test("frame references cannot cross episodes, source versions or shots", () => {
        const f = workflowImageFixture();
        const request = { ...f.request, step: "direction.start_frame" as const, sourceNodeIds: defaultWorkflowSources("direction.start_frame", f.request.pipelineId, f.nodes).filter(Boolean) };
        const subjects = workflowImageSubjects(request, f.nodes);
        expect(() => createWorkflowImages({ ...request, imageSubjectIds: [subjects[0].id], imageShotId: "SH01" }, f.nodes, f.connections, { x: 0, y: 0 })).toThrow("分镜列表中生成");
        expect(() => createWorkflowImages({ ...request, imageSubjectIds: [subjects[1].id], imageShotId: "SH02" }, f.nodes, f.connections, { x: 0, y: 0 })).toThrow("分镜列表中生成");
    });

    test("new media signatures detect resource edits while old saved signatures stay readable", () => {
        const f = workflowImageFixture();
        const subject = workflowImageSubjects(f.request, f.nodes)[0];
        const node = createWorkflowImages({ ...f.request, imageSubjectIds: [subject.id] }, f.nodes, f.connections, { x: 0, y: 0 }).created[0];
        node.metadata!.storageKey = "resource:initial";
        const oldShape = structuredClone(node); delete oldShape.metadata!.shortDrama!.mediaKind;
        const legacy = workflowSignature(oldShape); const current = workflowSignature(node);
        expect(legacy).toStartWith("v2:"); expect(current).toStartWith("v3:");
        expect(workflowSignatureMatches(node, legacy)).toBe(true);
        expect(workflowSignatureMatches(node, current)).toBe(true);
        node.metadata!.storageKey = "resource:changed";
        expect(workflowSignatureMatches(node, current)).toBe(false);
    });

    test("downstream text uses media descriptions and references, never image bytes as prose", () => {
        const f = workflowImageFixture();
        const sourceIds = defaultWorkflowSources("direction.boards", f.request.pipelineId, f.nodes).filter(Boolean);
        const subject = workflowImageSubjects({ step: "direction.boards", sourceNodeIds: sourceIds }, f.nodes)[0];
        const images = createWorkflowImages({ ...f.request, step: "direction.boards", sourceNodeIds: sourceIds, imageSubjectIds: [subject.id], imageShotId: "SH01" }, f.nodes, f.connections, { x: 0, y: 0 });
        const board = images.created[0]; board.metadata!.status = "success"; board.metadata!.content = "data:image/png;base64,RAW_IMAGE_BYTES";
        const preview = createWorkflowDocuments({ ...f.request, step: "direction.previsualization", sourceNodeIds: [subject.id, board.id], model: "fixture::text" }, images.nodes, images.connections, { x: 0, y: 0 });
        expect(preview.created[0].metadata?.prompt).not.toContain("RAW_IMAGE_BYTES");
        expect(preview.created[0].metadata?.prompt).toContain("SHOT_1_BOARD");
        expect(preview.created[0].metadata?.prompt).toContain("实际画面");
    });
});
