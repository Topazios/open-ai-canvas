import { describe, expect, test } from "bun:test";
import { createShortDramaPipeline, deriveShortDramaProgress } from "../src/lib/canvas/canvas-short-drama";
import { createWorkflowDocuments, defaultWorkflowSources, nodeWorkflow, workflowAncestors, workflowSources, workflowContinuationRange, workflowEpisodeProgress, groupExistingWorkflowEpisodes, groupSelectedWorkflowDocuments, workflowGroupingProblem, type WorkflowGenerationRequest } from "../src/lib/canvas/canvas-short-drama-workflow";
import { shortDramaSteps, activeShortDramaSteps, ShortDramaStep, nextShortDramaSteps, isStoryboardFrameStep } from "../src/lib/short-drama-steps";
import { confirmProductionBible } from "../src/lib/canvas/canvas-short-drama-workflow";
import { bibleOutput, assetItem } from "./fixtures/workflow-asset-output";
import { completeWorkflowPlan } from "./fixtures/workflow-plan";
import { shortDramaStages } from "../src/lib/short-drama-stages";
import { productionRuleBlock } from "../src/lib/production-rules";
import type { CanvasNodeData, CanvasConnection } from "../src/types/canvas";
import { removeCanvasDisplayConnection, resolveCanvasDisplayConnections } from "../src/lib/canvas/canvas-connection-spatial-index";
import { commitCanvasGenerationResult } from "../src/lib/canvas/canvas-generation-result";
import { saveWorkflowCanvasUntilSynced } from "../src/lib/canvas/workflow-canvas-save";
import { ApiError } from "../src/services/api/request";

const center = { x: 0, y: 0 };
function fixture() {
    const pipeline = createShortDramaPipeline(center, true);
    pipeline.nodes[0].metadata!.content = "选定故事与冲突";
    const pipelineId = nodeWorkflow(pipeline.nodes[0])!.pipelineId;
    const request: WorkflowGenerationRequest = { step: "story.plan", pipelineId, sourceNodeIds: [pipeline.storyNodeId], model: "fixture", instruction: "保持人物一致", episodeCount: 6, minutesPerEpisode: "3-5", start: 1, count: 1 };
    return { ...pipeline, request };
}
function complete(nodes: CanvasNodeData[]) {
    for (const node of nodes) { node.metadata!.content = `${node.title}完整文稿`; node.metadata!.status = "success"; }
    return nodes;
}

describe("short drama document workflow", () => {
    test("workflow node persistence waits through transient sync failures and stops on cancellation", async () => {
        let attempts = 0;
        let waitingUpdates = 0;
        await saveWorkflowCanvasUntilSynced(async (options) => {
            expect(options).toEqual({ quiet: true });
            attempts++;
            return attempts === 2;
        }, new AbortController().signal, () => waitingUpdates++);
        expect(attempts).toBe(2);
        expect(waitingUpdates).toBe(1);

        const controller = new AbortController();
        const pending = saveWorkflowCanvasUntilSynced(async () => false, controller.signal);
        setTimeout(() => controller.abort(), 5);
        await expect(pending).rejects.toMatchObject({ name: "AbortError" });

        attempts = 0;
        await saveWorkflowCanvasUntilSynced(async () => {
            attempts++;
            if (attempts === 1) throw new ApiError("云端版本已更新", { status: 409, retryable: false });
            return true;
        }, new AbortController().signal);
        expect(attempts).toBe(2);
        await expect(saveWorkflowCanvasUntilSynced(async () => { throw new Error("本地数据无效"); }, new AbortController().signal)).rejects.toThrow("本地数据无效");
    });

    test("active and saved legacy steps belong to an enum stage and form an acyclic reachable dependency graph", () => {
        expect(shortDramaSteps).toHaveLength(49);
        expect(new Set(Object.values(ShortDramaStep))).toEqual(new Set(shortDramaSteps.map((step) => step.id)));
        const visited = new Set<string>();
        for (const step of shortDramaSteps) {
            expect(shortDramaStages.some((stage) => stage.key === step.stage)).toBe(true);
            step.requires.forEach((dependency) => expect(visited.has(dependency)).toBe(true));
            if (step.id !== "story.topic") expect(step.requires.length).toBeGreaterThan(0);
            visited.add(step.id);
        }
    });
    test("new pipeline has only a topic and each click creates independent typed, connected results", () => {
        const f = fixture();
        expect(f.nodes).toHaveLength(1);
        const first = createWorkflowDocuments(f.request, f.nodes, [], center);
        completeWorkflowPlan(first);
        const second = createWorkflowDocuments(f.request, first.nodes, first.connections, center);
        expect(first.created[0].id).not.toBe(second.created[0].id);
        expect(second.nodes.find((node) => node.id === first.created[0].id)?.metadata?.content).toContain("完整文稿");
        expect(second.created[0].metadata?.shortDrama).toMatchObject({ stage: "story", step: "story.plan", sourceNodeIds: [f.storyNodeId], pipelineId: f.request.pipelineId });
        expect(second.connections.filter((edge) => edge.toNodeId === second.created[0].parentId).map((edge) => edge.fromNodeId)).toEqual([f.storyNodeId]);
        expect(second.created[0].metadata?.shortDrama?.operationId).not.toBe(first.created[0].metadata?.shortDrama?.operationId);
    });
    test("right-click next carries the chosen branch, ambiguity is explicit and ancestors enter prompts", () => {
        const f = fixture();
        const a = createWorkflowDocuments(f.request, f.nodes, [], center); const planA = completeWorkflowPlan(a);
        const b = createWorkflowDocuments(f.request, a.nodes, a.connections, center); completeWorkflowPlan(b);
        expect(defaultWorkflowSources("story.episodes", f.request.pipelineId, b.nodes)).toEqual([""]);
        const selected = defaultWorkflowSources("story.episodes", f.request.pipelineId, b.nodes, a.created[0].id);
        expect(selected).toEqual([a.created[0].parentId!]);
        const result = createWorkflowDocuments({ ...f.request, step: "story.episodes", sourceNodeIds: selected }, b.nodes, b.connections, center);
        const input = result.created[0].metadata?.shortDrama?.textBatch?.units.map(unit => unit.text).join("\n") || result.created[0].metadata?.prompt;
        expect(input).toContain(planA.docs[0].id);
        expect(input).toContain(f.nodes[0].metadata!.content!);
        expect(input).not.toContain(b.created[0].id);
        expect(nextShortDramaSteps("story.plan").map((step) => step.id)).toContain("story.episodes");
    });
    test("every step can generate a document while actual production and review are not falsely completed", () => {
        const f = fixture();
        let nodes = f.nodes; let connections: CanvasConnection[] = [];
        const legacyHidden = new Set([ShortDramaStep.Extract, ShortDramaStep.Catalog, ShortDramaStep.AssetApproval, ShortDramaStep.Style, ShortDramaStep.Settings, ShortDramaStep.Voices, ShortDramaStep.Scenes, ShortDramaStep.Reconcile]);
        for (const step of shortDramaSteps.slice(1).filter((entry) => !legacyHidden.has(entry.id as ShortDramaStep) && entry.mediaOutput !== "audio" && !isStoryboardFrameStep(entry.id))) {
            const sourceNodeIds = step.requires.map((required) => nodes.find((node) => nodeWorkflow(node)?.step === required && !nodeWorkflow(node)?.assetKey)!.id);
            const generated = createWorkflowDocuments({ ...f.request, step: step.id, sourceNodeIds }, nodes, connections, center);
            const metadata = generated.created[0].metadata!;
            if (step.id === ShortDramaStep.Audit) expect(metadata.shortDrama?.screenplayAudit?.bodyNodeId).toBe(sourceNodeIds[0]);
            else if (metadata.shortDrama?.productionAgent) expect(metadata.prompt).not.toContain("【制作执行规范 v");
            else {
                expect(metadata.prompt?.startsWith(productionRuleBlock(step.stage, "text"))).toBe(true);
                expect(metadata.prompt?.split("【制作执行规范 v")).toHaveLength(2);
            }
            if (step.id === "story.plan") completeWorkflowPlan(generated);
            else complete(generated.created);
            nodes = generated.nodes; connections = generated.connections;
            if (step.output && step.id !== "story.plan") {
                const before = generated.created[0];
                nodes = commitCanvasGenerationResult(nodes, before, { ...before, metadata: { ...before.metadata, content: step.id === "assets.bible" ? bibleOutput : JSON.stringify({ summary: "covered", items: [assetItem(step.label, "prompt")] }), status: "success" } }, step.id);
                if (step.id === "assets.bible") {
                    const frame = nodes.find((node) => node.id === before.parentId)!;
                    frame.metadata!.shortDrama = confirmProductionBible(frame.id, nodes, connections);
                }
            }
            const ancestorTail = workflowAncestors([generated.created[0].id], nodes, f.request.pipelineId).at(-1)?.id;
            if (step.output === "asset-group") expect(ancestorTail).toBeUndefined();
            else expect(ancestorTail).toBe(generated.created[0].id);
            expect(connections.filter((edge) => edge.toNodeId === (step.id === "story.plan" ? generated.created[0].parentId : generated.created[0].id))).toHaveLength(step.requires.length);
            if (step.production) expect(generated.created[0].metadata?.prompt).toContain("不得宣称媒体已生成");
        }
        const progress = deriveShortDramaProgress(nodes, connections);
        expect(progress.completed).toBe(false);
        expect(progress.steps.find((step) => step.id === "delivery")!.status).not.toBe("completed");
        expect(progress.steps.find((step) => step.id === "review")!.tasks[0].ready).not.toBe(true);
    });
    test("missing, stale, circular, cross-pipeline and conflicting versions cannot be used as prerequisites", () => {
        const f = fixture();
        const first = createWorkflowDocuments(f.request, f.nodes, [], center); const one = completeWorkflowPlan(first);
        expect(() => workflowAncestors([one.docs[0].id], one.docs, f.request.pipelineId)).toThrow("已删除");
        expect(() => workflowSources("story.episodes", "other", first.nodes, [one.frame.id])).toThrow("不属于");
        expect(() => workflowSources("story.episodes", f.request.pipelineId, first.nodes, [f.storyNodeId])).toThrow("请选择故事总纲与世界规则节点");
        const second = createWorkflowDocuments(f.request, first.nodes, [], center); const two = completeWorkflowPlan(second);
        expect(() => workflowAncestors([one.frame.id, two.frame.id], second.nodes, f.request.pipelineId)).toThrow("不同版本");
        first.nodes[0].metadata!.content = "changed topic";
        expect(() => workflowAncestors([one.frame.id], first.nodes, f.request.pipelineId)).toThrow("前文已更新");
        one.docs[0].metadata!.shortDrama!.sourceNodeIds = [one.docs[0].id];
        expect(() => workflowAncestors([one.docs[0].id], first.nodes, f.request.pipelineId)).toThrow("循环");
    });
    test("body batches use the selected plan range, keep previous drafts and create a new node for every episode", () => {
        const f = fixture();
        const plan = createWorkflowDocuments(f.request, f.nodes, [], center); const planned = completeWorkflowPlan(plan);
        const episodes = createWorkflowDocuments({ ...f.request, step: "story.episodes", sourceNodeIds: [planned.frame.id] }, plan.nodes, plan.connections, center); complete(episodes.created);
        const request = { ...f.request, step: "story.body" as const, sourceNodeIds: [episodes.created[0].id], start: 2, count: 3 };
        const batch = createWorkflowDocuments(request, episodes.nodes, episodes.connections, center); complete(batch.created);
        expect(batch.created.map((node) => nodeWorkflow(node)?.episodeNumber)).toEqual([2, 3, 4]);
        const again = createWorkflowDocuments(request, batch.nodes, batch.connections, center);
        expect(again.created.every((node) => !batch.created.some((old) => old.id === node.id))).toBe(true);
        expect(again.nodes.filter((node) => nodeWorkflow(node)?.step === "story.body" && nodeWorkflow(node)?.role !== "collection")).toHaveLength(6);
        expect(() => createWorkflowDocuments({ ...request, start: 5, count: 3 }, episodes.nodes, episodes.connections, center)).toThrow("范围");
        expect(() => createWorkflowDocuments(request, episodes.nodes, [], center)).toThrow("连线已移除");
    });
});

function bodyFixture(count = 3) {
    const f = fixture();
    const plan = createWorkflowDocuments({ ...f.request, minutesPerEpisode: "2-3" }, f.nodes, [], center); const planned = completeWorkflowPlan(plan);
    const outline = createWorkflowDocuments({ ...f.request, step: "story.episodes", sourceNodeIds: [planned.frame.id] }, plan.nodes, plan.connections, center); complete(outline.created);
    const request = { ...f.request, step: "story.body" as const, sourceNodeIds: [outline.created[0].id], start: 1, count };
    const batch = createWorkflowDocuments(request, outline.nodes, outline.connections, center);
    const collection = batch.nodes.find((node) => nodeWorkflow(node)?.role === "collection" && nodeWorkflow(node)?.step === "story.body")!;
    return { ...batch, request, collection, outlineId: outline.created[0].id, planId: planned.frame.id };
}

describe("episode collections and bounded workflow context", () => {
    test("one displayed collection link deletes all dependencies and can be restored with one real container link", () => {
        const f = bodyFixture(3); complete(f.nodes.filter((node) => node.parentId === f.collection.id));
        const link = resolveCanvasDisplayConnections(f.nodes, f.connections).find((edge) => edge.to.id === f.collection.id)!;
        const removed = removeCanvasDisplayConnection(f.nodes, f.connections, link.connection.id);
        expect(removed.some((edge) => f.created.some((node) => node.id === edge.toNodeId))).toBe(false);
        expect(() => workflowAncestors([f.collection.id], f.nodes, f.request.pipelineId, removed)).toThrow("连线已移除");
        const restored = [...removed, { id: "container-link", fromNodeId: f.outlineId, toNodeId: f.collection.id }];
        expect(workflowAncestors([f.collection.id], f.nodes, f.request.pipelineId, restored).at(-1)?.id).toBe(f.collection.id);
        expect(workflowAncestors([f.collection.id], f.nodes, f.request.pipelineId, f.connections).at(-1)?.id).toBe(f.collection.id);
    });
    test("old asset documents and running tasks retain their original source contract without a rewrite", () => {
        const f = bodyFixture(1); complete(f.nodes.filter((node) => node.parentId === f.collection.id));
        const old = structuredClone(f.created[0]); old.id = "old-style"; old.parentId = undefined;
        old.metadata!.shortDrama = { ...old.metadata!.shortDrama!, step: "assets.style", stage: "assets", sourceSteps: undefined, sourceNodeIds: [f.created[0].id], sourceSignatures: {} };
        old.metadata!.content = "Original style"; old.metadata!.status = "success";
        const nodes = [...f.nodes, old]; const edges = [...f.connections, { id: "old-link", fromNodeId: f.created[0].id, toNodeId: old.id }];
        expect(workflowAncestors([old.id], nodes, f.request.pipelineId, edges).at(-1)?.id).toBe(old.id);
        expect(old.metadata!.shortDrama.sourceSteps).toBeUndefined();
        expect(nextShortDramaSteps("story.body").some((step) => step.id === "assets.style")).toBe(false);
        expect(nextShortDramaSteps("story.body").some((step) => step.id === "assets.bible")).toBe(false);
        expect(nextShortDramaSteps("story.body").some((step) => step.id === "assets.reconcile")).toBe(false);
        expect(nextShortDramaSteps("story.body").some((step) => step.id === "story.audit")).toBe(true);
        expect(nextShortDramaSteps("story.body").some((step) => step.id === "assets.extract")).toBe(false);
    });
    test("plan parameters reach all episodes and a persisted native frame holds the batch", () => {
        const f = bodyFixture();
        expect(nodeWorkflow(f.collection)?.parameters).toMatchObject({ episodeCount: 6, minutesPerEpisode: "2-3" });
        for (const task of f.created) {
            const node = f.nodes.find((node) => node.id === task.id)!;
            expect(node.parentId).toBe(f.collection.id);
            expect(nodeWorkflow(node)?.parameters).toMatchObject({ episodeCount: 6, minutesPerEpisode: "2-3" });
            expect(node.position.x + node.width).toBeLessThan(f.collection.position.x + f.collection.width);
            expect(node.position.y).toBeGreaterThanOrEqual(f.collection.position.y + 100);
            expect(f.connections.some((edge) => edge.fromNodeId === node.id && edge.toNodeId === f.collection.id)).toBe(false);
        }
        const persisted = JSON.parse(JSON.stringify(f.nodes));
        expect(persisted.find((node: CanvasNodeData) => node.id === f.collection.id).metadata.shortDrama.sourceNodeIds).toEqual(f.created.map((node) => node.id));
    });
    test("progress distinguishes completed, running, rejected, pending and missing without counting group nodes", () => {
        const f = bodyFixture(4);
        const members = f.nodes.filter((node) => node.parentId === f.collection.id);
        members[0].metadata!.content = "done"; members[0].metadata!.status = "success";
        members[1].metadata!.status = "loading";
        members[2].metadata!.status = "error";
        const progress = workflowEpisodeProgress(f.nodes, f.request.pipelineId, f.outlineId);
        expect(progress).toMatchObject({ total: 6, complete: 1, running: 1, failed: 1, pending: 1, missing: 2, next: 3 });
        f.nodes.find((node) => node.id === f.planId)!.metadata!.content = "changed";
        expect(workflowEpisodeProgress(f.nodes, f.request.pipelineId, f.outlineId).complete).toBe(0);
    });
    test("continuation starts at the current gap and defaults to ten episodes", () => {
        const f = bodyFixture(3);
        const members = f.nodes.filter((node) => node.parentId === f.collection.id);
        members[0].metadata!.content = "done"; members[0].metadata!.status = "success";
        members[1].metadata!.content = "done"; members[1].metadata!.status = "success";
        members[2].metadata!.content = "done"; members[2].metadata!.status = "success";
        const progress = workflowEpisodeProgress(f.nodes, f.request.pipelineId, f.outlineId);
        expect(workflowContinuationRange(progress)).toEqual({ start: 4, count: 3 });
        expect(workflowContinuationRange({ ...progress, total: 60, next: 4 })).toEqual({ start: 4, count: 10 });
        expect(workflowContinuationRange({ ...progress, total: 8, next: 1 })).toEqual({ start: 1, count: 8 });
        expect(workflowContinuationRange({ ...progress, total: 60, next: 55 })).toEqual({ start: 55, count: 6 });
    });
    test("disjoint batches reuse the frame while another version never replaces a member", () => {
        const f = bodyFixture(2);
        const next = createWorkflowDocuments({ ...f.request, start: 3, count: 2 }, f.nodes, f.connections, center);
        expect(next.nodes.filter((node) => nodeWorkflow(node)?.role === "collection" && nodeWorkflow(node)?.step === "story.body")).toHaveLength(1);
        expect(nodeWorkflow(next.nodes.find((node) => node.id === f.collection.id))?.sourceNodeIds).toHaveLength(4);
        const retry = createWorkflowDocuments({ ...f.request, start: 1, count: 1 }, next.nodes, next.connections, center);
        expect(retry.nodes.filter((node) => nodeWorkflow(node)?.role === "collection" && nodeWorkflow(node)?.step === "story.body")).toHaveLength(2);
        expect(retry.nodes.find((node) => node.id === f.created[0].id)?.parentId).toBe(f.collection.id);
        expect(retry.nodes.find((node) => node.id === retry.created[0].id)?.parentId).not.toBe(f.collection.id);
    });
    test("collection extraction fans out one durable document per episode and never sends neighboring prose", () => {
        const f = bodyFixture();
        const members = f.nodes.filter((node) => node.parentId === f.collection.id);
        complete(members);
        members.forEach((node, index) => node.metadata!.content = `UNIQUE_BODY_${index + 1}`.repeat(100));
        const selected = defaultWorkflowSources("assets.extract", f.request.pipelineId, f.nodes, f.collection.id);
        expect(selected).toEqual([f.collection.id]);
        const result = createWorkflowDocuments({ ...f.request, step: "assets.extract", sourceNodeIds: selected }, f.nodes, f.connections, center);
        expect(result.created).toHaveLength(3);
        for (const [index, output] of result.created.entries()) {
            expect(output.metadata?.prompt).toContain(`UNIQUE_BODY_${index + 1}`);
            expect(output.metadata?.prompt).not.toContain(`UNIQUE_BODY_${(index + 1) % 3 + 1}`);
            expect(nodeWorkflow(output)?.sourceNodeIds).toEqual([members[index].id]);
            expect(nodeWorkflow(output)?.parameters?.episodeCount).toBe(6);
        }
        expect(result.nodes.filter((node) => nodeWorkflow(node)?.role === "collection" && nodeWorkflow(node)?.step === "assets.extract")).toHaveLength(1);
        const outputFrame = result.nodes.find((node) => nodeWorkflow(node)?.role === "collection" && nodeWorkflow(node)?.step === "assets.extract")!;
        expect(outputFrame.position.x).toBeGreaterThan(f.collection.position.x + f.collection.width);
        members[1].metadata!.content = "source edited";
        complete(result.created);
        expect(() => workflowAncestors([result.created[1].id], result.nodes, f.request.pipelineId, result.connections)).toThrow("前文已更新");
    });
    test("legacy extraction still feeds a saved cross-episode catalog without embedding body ancestors", () => {
        const f = bodyFixture(2); complete(f.nodes.filter((node) => node.parentId === f.collection.id));
        f.nodes.filter((node) => node.parentId === f.collection.id).forEach((node) => node.metadata!.content = "RAW_BODY_NOT_FOR_ASSET_SPECS");
        const extract = createWorkflowDocuments({ ...f.request, step: "assets.extract", sourceNodeIds: [f.collection.id] }, f.nodes, f.connections, center);
        complete(extract.nodes.filter((node) => nodeWorkflow(node)?.step === "assets.extract" && nodeWorkflow(node)?.role === "document"));
        const extractGroup = extract.nodes.find((node) => nodeWorkflow(node)?.step === "assets.extract" && nodeWorkflow(node)?.role === "collection")!;
        const catalog = createWorkflowDocuments({ ...f.request, step: "assets.catalog", sourceNodeIds: [extractGroup.id] }, extract.nodes, extract.connections, center); complete(catalog.created);
        expect(catalog.created).toHaveLength(1);
        expect(nodeWorkflow(catalog.created[0])?.episodeNumber).toBeUndefined();
        expect(catalog.created[0].metadata?.prompt).toContain("来源覆盖集数：1、2");
        extract.created.forEach((node) => expect(catalog.created[0].metadata?.prompt).toContain(node.metadata!.content!));
        expect(catalog.created[0].metadata?.prompt).not.toContain("RAW_BODY_NOT_FOR_ASSET_SPECS");
        extract.created[0].metadata!.content = "changed extraction";
        expect(() => workflowAncestors([catalog.created[0].id], catalog.nodes, f.request.pipelineId, catalog.connections)).toThrow("前文已更新");
    });
    test("invalid collection inputs fail; long episodes are automatically batched without altering sources", () => {
        const f = bodyFixture(2);
        const request = { ...f.request, step: "assets.extract" as const, sourceNodeIds: [f.collection.id] };
        expect(() => createWorkflowDocuments(request, f.nodes, f.connections, center)).toThrow("请先完成");
        complete(f.nodes.filter((node) => node.parentId === f.collection.id));
        expect(() => createWorkflowDocuments(request, f.nodes.filter((node) => node.id !== f.created[0].id), f.connections, center)).toThrow();
        f.nodes.find((node) => node.id === f.created[0].id)!.metadata!.content = "长".repeat(60001);
        const result = createWorkflowDocuments(request, f.nodes, f.connections, center);
        const batch = result.created[0].metadata?.shortDrama?.textBatch;
        expect(batch?.units.length).toBeGreaterThan(3);
        expect(batch!.units.map((unit) => unit.text).join("")).toContain("长".repeat(60001));
        expect(batch!.units.every((unit) => unit.text.length <= 20000)).toBe(true);
        expect(f.nodes.filter((node) => nodeWorkflow(node)?.step === "assets.extract")).toHaveLength(0);
    });
    test("existing ungrouped episodes can be organized without changing content, task IDs or source graph", () => {
        const f = bodyFixture();
        const nodes = f.nodes.filter((node) => node.id !== f.collection.id).map((node) => node.parentId === f.collection.id ? { ...node, parentId: undefined } : node);
        const connections = f.connections.filter((edge) => edge.toNodeId !== f.collection.id);
        const result = groupExistingWorkflowEpisodes(f.created[0].id, nodes, connections);
        expect(nodeWorkflow(result.collection)?.sourceNodeIds).toHaveLength(3);
        for (const original of nodes) expect(result.nodes.find((node) => node.id === original.id)?.metadata).toEqual(original.metadata);
        connections.forEach((edge) => expect(result.connections).toContainEqual(edge));
    });
    test("cross-episode aggregation consumes extracted documents, keeps provenance and invalidates on member edits", () => {
        const f = bodyFixture(2); complete(f.nodes.filter((node) => node.parentId === f.collection.id));
        f.nodes.filter((node) => node.parentId === f.collection.id).forEach((node) => node.metadata!.content = "ORIGINAL_PROSE_DO_NOT_REPEAT");
        const extraction = createWorkflowDocuments({ ...f.request, step: "assets.extract", sourceNodeIds: [f.collection.id] }, f.nodes, f.connections, center);
        const group = extraction.nodes.find((node) => nodeWorkflow(node)?.step === "assets.extract" && nodeWorkflow(node)?.role === "collection")!;
        const members = extraction.nodes.filter((node) => node.parentId === group.id); complete(members);
        const result = createWorkflowDocuments({ ...f.request, step: "assets.extract", sourceNodeIds: [group.id], aggregate: true }, extraction.nodes, extraction.connections, center);
        expect(result.created).toHaveLength(1);
        const summary = result.created[0]; complete(result.created);
        expect(nodeWorkflow(summary)?.aggregate).toBe(true);
        expect(nodeWorkflow(summary)?.episodeNumber).toBeUndefined();
        expect(summary.metadata?.prompt).not.toContain("ORIGINAL_PROSE_DO_NOT_REPEAT");
        members.forEach((member) => expect(summary.metadata?.prompt).toContain(member.metadata!.content!));
        expect(workflowAncestors([summary.id], result.nodes, f.request.pipelineId, result.connections).at(-1)?.id).toBe(summary.id);
        members[0].metadata!.content = "changed extracted record";
        expect(() => workflowAncestors([summary.id], result.nodes, f.request.pipelineId, result.connections)).toThrow("前文已更新");
        expect(() => createWorkflowDocuments({ ...f.request, sourceNodeIds: [f.collection.id], aggregate: true }, f.nodes, f.connections, center)).toThrow("正文请先按集提取");
    });
    test("organizing resized legacy documents keeps them inside non-overlapping cells", () => {
        const f = bodyFixture();
        const nodes = f.nodes.filter((node) => node.id !== f.collection.id).map((node) => node.parentId === f.collection.id ? { ...node, parentId: undefined, width: 720, height: 540 } : node);
        const result = groupExistingWorkflowEpisodes(f.created[0].id, nodes, f.connections);
        const members = result.nodes.filter((node) => node.parentId === result.collection.id);
        expect(members[1].position.x).toBeGreaterThan(members[0].position.x + members[0].width);
        expect(members.at(-1)!.position.x + members.at(-1)!.width).toBeLessThan(result.collection.position.x + result.collection.width);
        expect(members[0].position.y + members[0].height).toBeLessThan(result.collection.position.y + result.collection.height);
    });
    test("a moved-out member cannot silently remain an input to the collection", () => {
        const f = bodyFixture(2); complete(f.nodes.filter((node) => node.parentId === f.collection.id));
        const moved = f.nodes.map((node) => node.id === f.created[0].id ? { ...node, parentId: undefined } : node);
        expect(() => createWorkflowDocuments({ ...f.request, step: "assets.extract", sourceNodeIds: [f.collection.id] }, moved, f.connections, center)).toThrow("成员已移出");
    });
    test("explicit selection groups only selected completed nodes and supports adding to that existing container", () => {
        const f = bodyFixture(3);
        const nodes = f.nodes.filter((node) => node.id !== f.collection.id).map((node) => node.parentId === f.collection.id ? { ...node, parentId: undefined } : node);
        complete(nodes.filter((node) => nodeWorkflow(node)?.step === "story.body"));
        const ids = f.created.map((node) => node.id);
        const result = groupSelectedWorkflowDocuments(ids.slice(0, 2), nodes, f.connections);
        expect(nodeWorkflow(result.collection)?.sourceNodeIds).toEqual(ids.slice(0, 2));
        expect(result.nodes.find((node) => node.id === ids[2])?.parentId).toBeUndefined();
        expect(workflowGroupingProblem([ids[2]], result.nodes, result.collection.id)).toBeUndefined();
        const appended = groupSelectedWorkflowDocuments([ids[2]], result.nodes, result.connections, result.collection.id);
        expect(appended.collection.id).toBe(result.collection.id);
        expect(nodeWorkflow(appended.collection)?.sourceNodeIds).toEqual(ids);
        ids.forEach((id) => expect(appended.nodes.find((node) => node.id === id)?.metadata).toEqual(nodes.find((node) => node.id === id)?.metadata));
        expect(workflowAncestors([appended.collection.id], appended.nodes, f.request.pipelineId, appended.connections).at(-1)?.id).toBe(appended.collection.id);
        expect(createWorkflowDocuments({ ...f.request, step: "assets.extract", sourceNodeIds: [appended.collection.id] }, appended.nodes, appended.connections, center).created).toHaveLength(3);
    });
    test("existing plain frames become typed stage containers without replacing their ID or content", () => {
        const f = bodyFixture(2); complete(f.nodes.filter((node) => node.parentId === f.collection.id));
        const nodes = f.nodes.map((node) => node.id === f.collection.id ? { ...node, title: "我的已有背板", metadata: { ...node.metadata, shortDrama: undefined } } : node);
        const result = groupSelectedWorkflowDocuments(f.created.map((node) => node.id), nodes, f.connections, f.collection.id);
        expect(result.collection.id).toBe(f.collection.id);
        expect(result.collection.title).toBe("我的已有背板");
        expect(nodeWorkflow(result.collection)).toMatchObject({ role: "collection", step: "story.body", stage: "story", pipelineId: f.request.pipelineId });
        expect(defaultWorkflowSources("assets.extract", f.request.pipelineId, result.nodes, result.collection.id)).toEqual([f.collection.id]);
        expect(createWorkflowDocuments({ ...f.request, step: "assets.extract", sourceNodeIds: [f.collection.id] }, result.nodes, result.connections, center).created).toHaveLength(2);
    });
    test("grouping rejects conflicting episode versions, steps, pipelines and upstream branches without changing nodes", () => {
        const f = bodyFixture(2);
        const nodes = f.nodes.filter((node) => node.id !== f.collection.id).map((node) => node.parentId === f.collection.id ? { ...node, parentId: undefined } : node);
        const ids = f.created.map((node) => node.id);
        const before = JSON.stringify(nodes);
        const copy = structuredClone(nodes.find((node) => node.id === ids[0])!); copy.id = "other-version";
        expect(workflowGroupingProblem([ids[0], copy.id], [...nodes, copy])).toContain("同一集");
        copy.metadata!.shortDrama!.pipelineId = "other-pipeline";
        expect(workflowGroupingProblem([ids[1], copy.id], [...nodes, copy])).toContain("同一制作流程");
        copy.metadata!.shortDrama!.pipelineId = f.request.pipelineId; copy.metadata!.shortDrama!.step = "assets.style";
        expect(workflowGroupingProblem([ids[1], copy.id], [...nodes, copy])).toContain("同一步骤");
        copy.metadata!.shortDrama!.step = "story.body";
        const otherOutline = structuredClone(nodes.find((node) => node.id === f.outlineId)!); otherOutline.id = "other-outline";
        copy.metadata!.shortDrama!.sourceNodeIds = [otherOutline.id];
        expect(workflowGroupingProblem([ids[1], copy.id], [...nodes, otherOutline, copy])).toContain("不同版本的前置材料");
        expect(JSON.stringify(nodes)).toBe(before);
    });
});
