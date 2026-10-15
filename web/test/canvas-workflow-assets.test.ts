import { describe, expect, test } from "bun:test";
import { createShortDramaPipeline } from "@/lib/canvas/canvas-short-drama";
import { createWorkflowDocuments, defaultWorkflowSources, nodeWorkflow, workflowAncestors, workflowGenerationSources, confirmProductionBible, productionBibleConfirmed, productionBibleReady } from "@/lib/canvas/canvas-short-drama-workflow";
import { bibleOutput, legacyBibleOutput, assetOutput as output, assetItem } from "./fixtures/workflow-asset-output";
import { productionBibleKeys, productionBibleSections } from "../src/lib/production-bible";
import { commitCanvasGenerationResult } from "@/lib/canvas/canvas-generation-result";
import { parseWorkflowAssetGroup, restoreEmptyWorkflowAssetGroup, emptyWorkflowAssetManifest } from "@/lib/canvas/canvas-workflow-assets";
import { activeShortDramaSteps, nextShortDramaSteps } from "@/lib/short-drama-steps";
import { removeCanvasDisplayConnection, resolveCanvasDisplayConnections } from "@/lib/canvas/canvas-connection-spatial-index";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { assetAppliesToEpisode, assetMediaSignature, assetReferenceState, isAssetReference, assetContextProfile } from "@/lib/canvas/canvas-workflow-asset-profile";

const center = { x: 0, y: 0 };
function bodyFixture() {
    const pipeline = createShortDramaPipeline(center, true);
    pipeline.nodes[0].metadata!.content = "Topic";
    const request = { step: "story.plan" as const, pipelineId: nodeWorkflow(pipeline.nodes[0])!.pipelineId, sourceNodeIds: [pipeline.nodes[0].id], model: "fixture", instruction: "", episodeCount: 6, minutesPerEpisode: "2", start: 1, count: 2 };
    let result = createWorkflowDocuments(request, pipeline.nodes, pipeline.connections, center);
    result.created.forEach((node) => Object.assign(node.metadata!, { content: "Production plan", status: "success" }));
    result = createWorkflowDocuments({ ...request, step: "story.episodes", sourceNodeIds: [result.created[0].id] }, result.nodes, result.connections, center);
    result.created.forEach((node) => Object.assign(node.metadata!, { content: "Episode outline", status: "success" }));
    result = createWorkflowDocuments({ ...request, step: "story.body", sourceNodeIds: [result.created[0].id] }, result.nodes, result.connections, center);
    result.nodes.filter((node) => nodeWorkflow(node)?.step === "story.body" && nodeWorkflow(node)?.role !== "collection").forEach((node, index) => Object.assign(node.metadata!, { content: `BODY_${index + 1}`, status: "success" }));
    const body = result.nodes.find((node) => nodeWorkflow(node)?.role === "collection")!;
    result = createWorkflowDocuments({ ...request, step: "assets.bible", sourceNodeIds: [body.id] }, result.nodes, result.connections, center);
    const before = result.created[0];
    result.nodes = commitCanvasGenerationResult(result.nodes, before, { ...before, metadata: { ...before.metadata, content: bibleOutput, status: "success" } }, "bible-task");
    const bible = result.nodes.find((node) => node.id === before.parentId)!;
    bible.metadata!.shortDrama = confirmProductionBible(bible.id, result.nodes, result.connections);
    return { ...result, request, body, bible };
}
function groupFixture() {
    const f = bodyFixture();
    const group = createWorkflowDocuments({ ...f.request, step: "assets.characters", sourceNodeIds: [f.body.id, f.bible.id] }, f.nodes, f.connections, center);
    const before = group.created[0]; before.metadata!.taskId = "task-1"; before.metadata!.status = "loading";
    const result = { ...before, metadata: { ...before.metadata, status: "success" as const, content: output } };
    const nodes = commitCanvasGenerationResult(group.nodes, before, result, "task-1");
    const frame = nodes.find((node) => node.id === before.parentId)!;
    return { ...f, ...group, before, result, nodes, frame };
}

describe("production guidelines and reusable asset outputs", () => {
    test("an old empty successful group can resume materialization without affecting populated groups", () => {
        const f = groupFixture();
        const empty = commitCanvasGenerationResult(f.nodes.filter((node) => node.parentId !== f.frame.id || node.id === f.before.id).map((node) => node.id === f.before.id ? f.before : node), f.before,
            { ...f.result, metadata: { ...f.result.metadata, content: JSON.stringify({ summary: "没有正文", items: [] }) } }, "task-1");
        expect(emptyWorkflowAssetManifest(empty, f.frame.id)?.id).toBe(f.before.id);
        const resumed = restoreEmptyWorkflowAssetGroup(empty.map((node) => node.id === f.before.id ? { ...node, metadata: { ...node.metadata, taskId: "task-2", status: "loading" as const } } : node), f.before.id);
        const before = resumed.find((node) => node.id === f.before.id)!;
        expect(before.metadata?.shortDrama?.assetOutput).toBe(true);
        expect(before.metadata?.shortDrama?.materializedTaskId).toBeUndefined();
        const done = commitCanvasGenerationResult(resumed, before, { ...before, metadata: { ...before.metadata, content: output, status: "success" } }, "task-2");
        expect(done.filter((node) => node.parentId === f.frame.id && node.id !== f.before.id)).toHaveLength(2);
        expect(emptyWorkflowAssetManifest(f.nodes, f.frame.id)).toBeUndefined();
        expect(restoreEmptyWorkflowAssetGroup(f.nodes, f.before.id)).toBe(f.nodes);
    });
    test("complete guidelines support all asset actions without manual confirmation", () => {
        const f = bodyFixture();
        const data = nodeWorkflow(f.bible)!;
        data.bibleConfirmation = undefined;
        expect(productionBibleReady(f.bible, f.nodes)).toBe(true);
        for (const step of ["assets.characters", "assets.environments", "assets.props", "assets.special"] as const) {
            const generated = createWorkflowDocuments({ ...f.request, step, sourceNodeIds: [f.body.id, f.bible.id] }, f.nodes, f.connections, center);
            expect(generated.created).toHaveLength(1);
            expect(workflowGenerationSources(nodeWorkflow(generated.created[0])!, generated.nodes, generated.connections)).toContain(f.bible);
            expect(generated.created[0].metadata?.prompt).not.toContain("已确认制作规范");
            expect(productionBibleConfirmed(f.bible, generated.nodes)).toBe(false);
        }
    });
    test("saved guideline children remain usable when the summary task stopped after producing them", () => {
        const f = bodyFixture();
        const manifest = f.nodes.find((node) => node.id === nodeWorkflow(f.bible)!.assetGroup!.manifestId)!;
        manifest.metadata!.status = "error";
        manifest.metadata!.content = "";
        nodeWorkflow(manifest)!.assetOutput = true;
        expect(productionBibleReady(f.bible, f.nodes)).toBe(true);
        expect(() => workflowGenerationSources({ step: "assets.characters", pipelineId: f.request.pipelineId, sourceNodeIds: [f.body.id, f.bible.id] }, f.nodes, f.connections)).not.toThrow();
        expect(() => createWorkflowDocuments({ ...f.request, step: "assets.characters", sourceNodeIds: [f.body.id, f.bible.id] }, f.nodes, f.connections, center)).not.toThrow();
    });
    test("new guidelines contain eight typed documents and reject partial output", () => {
        const f = bodyFixture();
        const members = f.nodes.filter((node) => node.parentId === f.bible.id && node.id !== nodeWorkflow(f.bible)!.assetGroup!.manifestId);
        expect(members).toHaveLength(8);
        expect(members.map((node) => nodeWorkflow(node)!.bibleSection)).toEqual(productionBibleKeys);
        expect(members.map((node) => node.title)).toEqual(productionBibleSections.map((section) => section.label));
        expect(() => parseWorkflowAssetGroup(legacyBibleOutput, "bible", productionBibleKeys)).toThrow("所有要求");
        for (const member of members) {
            const remaining = f.nodes.filter((node) => node.id !== member.id);
            expect(productionBibleReady(f.bible, remaining)).toBe(false);
            expect(() => createWorkflowDocuments({ ...f.request, step: "assets.characters", sourceNodeIds: [f.body.id, f.bible.id] }, remaining, f.connections, center)).toThrow();
        }
    });
    test("existing two-document guidelines remain usable without confirmation", () => {
        const f = bodyFixture();
        const legacy = f.nodes.filter((node) => node.parentId !== f.bible.id || ["$summary", "settings", "style"].includes(nodeWorkflow(node)?.assetKey || ""));
        const frame = legacy.find((node) => node.id === f.bible.id)!;
        const data = nodeWorkflow(frame)!;
        data.assetGroup!.sections = undefined;
        data.bibleConfirmation = undefined;
        data.sourceNodeIds = legacy.filter((node) => node.parentId === frame.id).map((node) => node.id);
        for (const node of legacy.filter((node) => node.parentId === frame.id)) nodeWorkflow(node)!.bibleSection = undefined;
        expect(productionBibleReady(frame, legacy)).toBe(true);
        expect(parseWorkflowAssetGroup(legacyBibleOutput, "bible").items).toHaveLength(2);
        expect(() => createWorkflowDocuments({ ...f.request, step: "assets.characters", sourceNodeIds: [f.body.id, frame.id] }, legacy, f.connections, center)).not.toThrow();
    });
    test("optional review tracks edits and existing asset versions still detect changed guidelines", () => {
        const f = bodyFixture();
        f.bible.metadata!.shortDrama = confirmProductionBible(f.bible.id, f.nodes, f.connections);
        expect(productionBibleConfirmed(f.bible, f.nodes)).toBe(true);
        const generated = createWorkflowDocuments({ ...f.request, step: "assets.characters", sourceNodeIds: [f.body.id, f.bible.id] }, f.nodes, f.connections, center);
        const before = generated.created[0];
        const nodes = commitCanvasGenerationResult(generated.nodes, before, { ...before, metadata: { ...before.metadata, content: output, status: "success" } }, "asset-before-edit");
        const section = f.nodes.find((node) => node.parentId === f.bible.id && nodeWorkflow(node)?.step === "assets.style")!;
        section.metadata!.content = "用户新选的表现风格";
        expect(productionBibleConfirmed(f.bible, f.nodes)).toBe(false);
        expect(() => workflowAncestors([before.parentId!], nodes, f.request.pipelineId, generated.connections)).toThrow("前文已更新");
        expect(() => createWorkflowDocuments({ ...f.request, step: "assets.characters", sourceNodeIds: [f.body.id, f.bible.id] }, f.nodes, f.connections, center)).not.toThrow();
        expect(() => parseWorkflowAssetGroup(JSON.stringify({ summary: "x", items: [{ name: "风格", section: "style", content: "x" }] }), "bible")).toThrow("同时包含");
    });
    test("unconfirmed guidelines still require complete, current and connected source content", () => {
        for (const invalid of ["loading", "error", "empty", "deleted", "removed-member", "changed-body", "disconnected"] as const) {
            const f = bodyFixture();
            nodeWorkflow(f.bible)!.bibleConfirmation = undefined;
            const section = f.nodes.find((node) => node.parentId === f.bible.id && nodeWorkflow(node)?.step === "assets.style")!;
            if (invalid === "loading" || invalid === "error") section.metadata!.status = invalid;
            if (invalid === "empty") section.metadata!.content = "";
            if (invalid === "deleted") f.nodes = f.nodes.filter((node) => node.id !== section.id);
            if (invalid === "removed-member") nodeWorkflow(f.bible)!.sourceNodeIds = nodeWorkflow(f.bible)!.sourceNodeIds.filter((id) => id !== section.id);
            if (invalid === "changed-body") f.nodes.find((node) => node.parentId === f.body.id)!.metadata!.content += "changed";
            if (invalid === "disconnected") f.connections = [];
            if (["loading", "error", "empty", "deleted", "removed-member"].includes(invalid)) expect(productionBibleReady(f.bible, f.nodes)).toBe(false);
            expect(() => createWorkflowDocuments({ ...f.request, step: "assets.characters", sourceNodeIds: [f.body.id, f.bible.id] }, f.nodes, f.connections, center)).toThrow();
        }
    });
    test("structured extraction never manufactures approved references and rejects invented episode coverage", () => {
        const item = { ...assetItem("角色", "人物全文"), references: [{ nodeId: "fake", selected: true }] };
        const parsed = parseWorkflowAssetGroup(JSON.stringify({ summary: "x", items: [item] }), "assets");
        expect(parsed.items[0].profile?.references).toEqual([]);
        expect(assetReferenceState(parsed.items[0].profile, [])).toBe("仅描述");
        expect(() => parseWorkflowAssetGroup(output.replace('"episode":1', '"episode":0'), "assets")).toThrow("出场记录");
        const f = bodyFixture();
        const generated = createWorkflowDocuments({ ...f.request, step: "assets.props", sourceNodeIds: [f.body.id, f.bible.id] }, f.nodes, f.connections, center);
        const before = generated.created[0];
        const nodes = commitCanvasGenerationResult(generated.nodes, before, { ...before, metadata: { ...before.metadata, content: JSON.stringify({ summary: "x", items: [assetItem("prop", "x", 6)] }), status: "success" } }, "uncovered");
        expect(nodes.find((node) => node.id === before.id)?.metadata?.errorDetails).toContain("未提供");
        expect(nodes.filter((node) => node.parentId === before.parentId)).toHaveLength(1);
    });
    test("episode consumers omit unrelated indexed assets but include unknown or edited ones", () => {
        const f = groupFixture();
        const env = createWorkflowDocuments({ ...f.request, step: "assets.environments", sourceNodeIds: [f.body.id, f.bible.id] }, f.nodes, f.connections, center);
        const before = env.created[0];
        const nodes = commitCanvasGenerationResult(env.nodes, before, { ...before, metadata: { ...before.metadata, content: output, status: "success" } }, "env");
        const chosen = defaultWorkflowSources("direction.scenes", f.request.pipelineId, nodes, f.body.id).filter(Boolean);
        const result = createWorkflowDocuments({ ...f.request, step: "direction.scenes", sourceNodeIds: chosen }, nodes, env.connections, center);
        expect(result.created[0].metadata?.prompt).toContain("青年黑发");
        expect(result.created[0].metadata?.prompt).not.toContain("短发青年");
        expect(result.created[1].metadata?.prompt).not.toContain("青年黑发");
        const member = nodes.find((node) => node.parentId === f.frame.id && nodeWorkflow(node)?.assetKey === "2")!;
        expect(assetAppliesToEpisode(member, 1)).toBe(false);
        member.metadata!.content += "用户补充第1集也出场";
        expect(assetAppliesToEpisode(member, 1)).toBe(true);
        const again = createWorkflowDocuments({ ...f.request, step: "direction.scenes", sourceNodeIds: chosen }, nodes, env.connections, center);
        expect(again.created[0].metadata?.prompt).toContain("索引待核对");
        expect(again.created[0].metadata?.prompt).toContain("用户补充");
    });
    test("actual media controls reference status and downstream tracks reference mutations", () => {
        const f = groupFixture();
        const member = f.nodes.find((node) => node.parentId === f.frame.id && nodeWorkflow(node)?.assetKey === "1")!;
        const profile = nodeWorkflow(member)!.assetProfile!;
        const media: CanvasNodeData = { ...member, id: "reference-image", parentId: undefined, type: CanvasNodeType.Image, metadata: { content: "data:image/png;base64,fixture", status: "success" } };
        const nodes = [...f.nodes, media];
        expect(isAssetReference(media)).toBe(true);
        profile.references = [{ nodeId: media.id, signature: assetMediaSignature(media), selected: false, variant: "基准" }];
        expect(assetReferenceState(profile, nodes)).toBe("候选参考");
        profile.references[0].selected = true;
        expect(assetReferenceState(profile, nodes)).toBe("已选定参考版本");
        profile.references.push({ nodeId: "older-candidate", signature: "old", selected: false, variant: "基准" });
        expect(assetContextProfile(member, 1)?.references.map((ref) => ref.nodeId)).toEqual([media.id]);
        profile.references.pop();
        media.metadata!.content = "changed";
        expect(assetReferenceState(profile, nodes)).toBe("参考已变化或缺失");
        expect(assetReferenceState(profile, f.nodes)).toBe("参考已变化或缺失");
        const downstream = { ...member, id: "downstream", metadata: { ...member.metadata, shortDrama: { ...nodeWorkflow(member)!, referenceSignatures: { [media.id]: "previous" } } } };
        expect(() => workflowAncestors([downstream.id], [...nodes, downstream], f.request.pipelineId)).toThrow("参考版本已变化");
        expect(() => workflowGenerationSources(nodeWorkflow(downstream)!, [...nodes, downstream], f.connections)).toThrow("参考版本已变化");
    });
    test("optional special assets can be attached and the selected contract survives task recovery", () => {
        const f = groupFixture();
        let nodes = f.nodes; let connections = f.connections;
        for (const step of ["assets.environments", "assets.special"] as const) {
            const generated = createWorkflowDocuments({ ...f.request, step, sourceNodeIds: [f.body.id, f.bible.id] }, nodes, connections, center);
            const before = generated.created[0];
            nodes = commitCanvasGenerationResult(generated.nodes, before, { ...before, metadata: { ...before.metadata, content: output, status: "success" } }, step);
            connections = generated.connections;
        }
        const sourceNodeIds = defaultWorkflowSources("direction.scenes", f.request.pipelineId, nodes, f.body.id).filter(Boolean);
        expect(sourceNodeIds).toHaveLength(5);
        const result = createWorkflowDocuments({ ...f.request, step: "direction.scenes", sourceNodeIds }, nodes, connections, center);
        const data = nodeWorkflow(result.created[0])!;
        expect(data.sourceSteps).toContain("assets.special");
        expect(workflowGenerationSources(data, result.nodes, result.connections).some((node) => nodeWorkflow(node)?.step === "assets.special")).toBe(true);
    });
    test("pending six-entry tasks keep their body-only contract and old output parser", () => {
        const f = groupFixture();
        const before = structuredClone(f.before);
        before.metadata!.shortDrama = { ...nodeWorkflow(before)!, sourceNodeIds: [f.body.id], sourceSteps: ["story.body"], assetSchemaVersion: undefined };
        expect(workflowGenerationSources(nodeWorkflow(before)!, f.nodes, f.connections).at(-1)?.id).toBe(f.body.id);
        expect(parseWorkflowAssetGroup('{"summary":"old","items":[{"name":"old asset","content":"old content"}]}').items[0].profile).toBeUndefined();
    });
    test("asset extraction and reference image actions preserve the body source and special assets remain optional downstream", () => {
        const f = bodyFixture();
        const steps = activeShortDramaSteps.filter((step) => step.stage === "assets");
        expect(steps.filter((step) => !step.optional).map((step) => step.label)).toEqual(["统一制作规范", "人物资产", "人物参考图生成", "场景资产", "场景参考图生成", "道具资产", "道具参考图生成"]);
        expect(steps).toHaveLength(9);
        expect(steps.filter((step) => !step.mediaOutput)).toHaveLength(5);
        expect(nextShortDramaSteps("story.body").filter((step) => step.stage === "assets").map((step) => step.id)).toEqual(["assets.bible", "assets.special", "assets.characters", "assets.environments", "assets.props"]);
        expect(nextShortDramaSteps("assets.characters").map((step) => step.id)).toContain("assets.character_references");
        expect(nextShortDramaSteps("assets.environments").map((step) => step.id)).toContain("assets.environment_references");
        expect(nextShortDramaSteps("assets.props").map((step) => step.id)).toContain("assets.prop_references");
        expect(nextShortDramaSteps("assets.special").map((step) => step.id)).toContain("assets.special_references");
        for (const step of steps.filter((entry) => !entry.mediaOutput)) {
            const generated = createWorkflowDocuments({ ...f.request, step: step.id, sourceNodeIds: step.id === "assets.bible" ? [f.body.id] : [f.body.id, f.bible.id] }, f.nodes, f.connections, center);
            expect(generated.created).toHaveLength(1);
            expect(generated.created[0].metadata?.shortDrama?.productionAgent).toEqual({});
            expect(generated.created[0].metadata?.shortDrama?.textBatch).toBeUndefined();
            expect(generated.created[0].metadata?.shortDrama?.sourceNodeIds).toContain(f.body.id);
            expect(workflowGenerationSources(nodeWorkflow(generated.created[0])!, generated.nodes, generated.connections).filter((node) => nodeWorkflow(node)?.step === "story.body" && nodeWorkflow(node)?.role !== "collection").map((node) => node.metadata?.content)).toEqual(["BODY_1", "BODY_2"]);
            expect(generated.created[0].metadata?.prompt).not.toContain("BODY_1");
            expect(generated.created[0].metadata?.prompt).toContain("分页读取材料");
            expect(generated.created[0].metadata?.shortDrama?.episodeNumber).toBeUndefined();
            expect(generated.nodes.filter((node) => node.metadata?.shortDrama?.assetGroup)).toHaveLength(2);
            if (step.output) {
                generated.created[0].metadata!.content = output;
                generated.created[0].metadata!.status = "success";
                expect(() => workflowAncestors([generated.created[0].parentId!], generated.nodes, f.request.pipelineId, generated.connections)).toThrow("请先完成");
            }
        }
        const oversized = f.nodes.map((node) => node.parentId === f.body.id ? { ...node, metadata: { ...node.metadata, content: "长".repeat(31000) } } : node);
        const batched = createWorkflowDocuments({ ...f.request, step: "assets.settings", sourceNodeIds: [f.body.id] }, oversized, f.connections, center);
        expect(batched.created[0].metadata?.shortDrama?.textBatch?.units.length).toBeGreaterThan(2);
    });
    test("native editable children and one container endpoint retain causality and current content", () => {
        const f = groupFixture();
        const children = f.nodes.filter((node) => node.parentId === f.frame.id);
        expect(children).toHaveLength(3);
        expect(children.every((node) => node.type === CanvasNodeType.Text)).toBe(true);
        expect(children.filter((node) => node.id !== f.before.id).every((node) => !node.metadata?.taskId && !node.metadata?.shortDrama?.operationId)).toBe(true);
        expect(f.nodes.find((node) => node.id === f.before.id)?.metadata?.content).not.toContain('"items"');
        expect(workflowAncestors([f.frame.id], f.nodes, f.request.pipelineId, f.connections).at(-1)?.id).toBe(f.frame.id);
        const edges = resolveCanvasDisplayConnections(f.nodes, f.connections).filter((edge) => edge.to.id === f.frame.id);
        expect(edges).toHaveLength(2); expect(edges[0].from.id).toBe(f.body.id);
        expect(() => workflowAncestors([f.frame.id], f.nodes, f.request.pipelineId, removeCanvasDisplayConnection(f.nodes, f.connections, edges[0].connection.id))).toThrow("连线已移除");
        const chosen = defaultWorkflowSources("direction.scenes", f.request.pipelineId, f.nodes, children[1].id);
        expect(chosen[1]).toBe(f.frame.id);
        children[1].metadata!.content = "用户编辑后的人物提示词";
        const again = createWorkflowDocuments({ ...f.request, step: "assets.characters", sourceNodeIds: [f.body.id, f.bible.id] }, f.nodes, f.connections, center);
        expect(again.nodes.find((node) => node.id === children[1].id)?.metadata?.content).toBe("用户编辑后的人物提示词");
        expect(again.created[0].parentId).not.toBe(f.frame.id);
    });
    test("durable replay preserves edits and deleted members, and never duplicates or resurrects them", () => {
        const f = groupFixture();
        const saved: CanvasNodeData[] = JSON.parse(JSON.stringify(f.nodes));
        const member = saved.find((node) => node.parentId === f.frame.id && node.metadata?.shortDrama?.assetKey === "1")!;
        member.metadata!.content = "edited after completion";
        expect(commitCanvasGenerationResult(saved, f.before, f.result, "task-1")).toBe(saved);
        const removed = saved.filter((node) => node.id !== member.id);
        expect(commitCanvasGenerationResult(removed, f.before, f.result, "task-1")).toBe(removed);
        expect(() => workflowAncestors([f.frame.id], removed, f.request.pipelineId, f.connections)).toThrow("成员已移出");
        expect(() => commitCanvasGenerationResult(saved.filter((node) => node.id !== f.before.id), f.before, f.result, "task-1")).toThrow("已删除");
    });
    test("later per-episode direction consumes whole asset groups and current edits without re-embedding all bodies", () => {
        const f = groupFixture();
        let nodes = f.nodes; let connections = f.connections;
        for (const step of ["assets.environments"] as const) {
            const generated = createWorkflowDocuments({ ...f.request, step, sourceNodeIds: [f.body.id, f.bible.id] }, nodes, connections, center);
            const before = generated.created[0];
            nodes = commitCanvasGenerationResult(generated.nodes, before, { ...before, metadata: { ...before.metadata, status: "success", content: output } }, step);
            connections = generated.connections;
        }
        const member = nodes.find((node) => node.parentId === f.frame.id && node.metadata?.shortDrama?.assetKey === "1")!;
        member.metadata!.content = "CURRENT_CHARACTER_PROMPT";
        const sourceNodeIds = defaultWorkflowSources("direction.scenes", f.request.pipelineId, nodes, f.body.id).filter(Boolean);
        expect(sourceNodeIds.every(Boolean)).toBe(true);
        const result = createWorkflowDocuments({ ...f.request, step: "direction.scenes", sourceNodeIds }, nodes, connections, center);
        expect(result.created).toHaveLength(2);
        expect(result.created[0].metadata?.prompt).toContain("CURRENT_CHARACTER_PROMPT");
        expect(result.created[0].metadata?.prompt).toContain("BODY_1");
        expect(result.created[0].metadata?.prompt).not.toContain("BODY_2");
        result.created.forEach((node) => Object.assign(node.metadata!, { content: "direction", status: "success" }));
        const group = result.nodes.find((node) => nodeWorkflow(node)?.step === "direction.scenes" && nodeWorkflow(node)?.role === "collection")!;
        expect(workflowAncestors([group.id], result.nodes, f.request.pipelineId, result.connections).at(-1)?.id).toBe(group.id);
        member.metadata!.content = "CHANGED_AFTER_DIRECTION";
        expect(() => workflowAncestors([group.id], result.nodes, f.request.pipelineId, result.connections)).toThrow("前文已更新");
    });
    test("a pending group's movement and user rename survive completion; a removed frame is never recreated", () => {
        const f = bodyFixture();
        const group = createWorkflowDocuments({ ...f.request, step: "assets.characters", sourceNodeIds: [f.body.id, f.bible.id] }, f.nodes, f.connections, center);
        const before = group.created[0];
        const frame = group.nodes.find((node) => node.id === before.parentId)!;
        const moved = group.nodes.map((node) => node.id === frame.id || node.parentId === frame.id ? { ...node, title: node.id === frame.id ? "用户命名" : node.title, position: { x: node.position.x + 800, y: node.position.y + 400 } } : node);
        const result = { ...before, metadata: { ...before.metadata, status: "success" as const, content: output } };
        const completed = commitCanvasGenerationResult(moved, before, result, "task-1");
        const finalFrame = completed.find((node) => node.id === frame.id)!;
        expect(finalFrame.title).toBe("用户命名");
        for (const child of completed.filter((node) => node.parentId === frame.id)) {
            expect(child.position.x).toBeGreaterThan(finalFrame.position.x);
            expect(child.position.x + child.width).toBeLessThan(finalFrame.position.x + finalFrame.width);
            expect(child.position.y).toBeGreaterThanOrEqual(finalFrame.position.y + 100);
        }
        expect(() => commitCanvasGenerationResult(group.nodes.filter((node) => node.id !== frame.id), before, result, "task-1")).toThrow("容器已删除");
    });
    test("malformed output retains raw text as an error, never partial children or a false success", () => {
        const f = bodyFixture();
        const group = createWorkflowDocuments({ ...f.request, step: "assets.props", sourceNodeIds: [f.body.id, f.bible.id] }, f.nodes, f.connections, center);
        const before = group.created[0];
        const result = { ...before, metadata: { ...before.metadata, status: "success" as const, content: '{"items":[' } };
        const nodes = commitCanvasGenerationResult(group.nodes, before, result, "bad-task");
        expect(nodes).toHaveLength(group.nodes.length);
        expect(nodes.find((node) => node.id === before.id)?.metadata).toMatchObject({ content: '{"items":[', status: "error" });
        expect(commitCanvasGenerationResult(nodes, before, result, "bad-task")).toBe(nodes);
        expect(() => workflowAncestors([before.parentId!], nodes, f.request.pipelineId, group.connections)).toThrow("请先完成");
        expect(() => parseWorkflowAssetGroup(JSON.stringify({ summary: "test", items: [{ name: "林 舟", content: "x" }, { name: "林舟", content: "y" }] }))).toThrow("重复");
        expect(parseWorkflowAssetGroup('```json\n{"summary":"正文未出现可提取的道具", "items":[]}\n```').items).toEqual([]);
    });
    test("expanding an asynchronously completed group does not cover another pending group", () => {
        const f = bodyFixture();
        const first = createWorkflowDocuments({ ...f.request, step: "assets.characters", sourceNodeIds: [f.body.id, f.bible.id] }, f.nodes, f.connections, center);
        const second = createWorkflowDocuments({ ...f.request, step: "assets.props", sourceNodeIds: [f.body.id, f.bible.id] }, first.nodes, first.connections, center);
        const before = first.created[0];
        const content = JSON.stringify({ summary: "coverage", items: Array.from({ length: 12 }, (_, index) => assetItem(`Asset ${index}`, "Prompt")) });
        const completed = commitCanvasGenerationResult(second.nodes, before, { ...before, metadata: { ...before.metadata, status: "success", content } }, "large-group");
        const frame = completed.find((node) => node.id === before.parentId)!;
        const pending = completed.find((node) => node.id === second.created[0].parentId)!;
        expect(frame.position.y).toBeGreaterThan(pending.position.y + pending.height);
        expect(pending).toBe(second.nodes.find((node) => node.id === pending.id)!);
        expect(completed.filter((node) => node.parentId === frame.id)).toHaveLength(13);
        for (const node of completed.filter((node) => node.parentId === frame.id)) expect(node.position.y + node.height).toBeLessThan(frame.position.y + frame.height);
    });
    test("saved pre-integration pending tasks retain their dependency contract", () => {
        const f = bodyFixture();
        const extraction = createWorkflowDocuments({ ...f.request, step: "assets.extract", sourceNodeIds: [f.body.id] }, f.nodes, f.connections, center);
        extraction.nodes.filter((node) => nodeWorkflow(node)?.step === "assets.extract" && nodeWorkflow(node)?.role === "document").forEach((node) => Object.assign(node.metadata!, { content: "Legacy extraction", status: "success" }));
        const collection = extraction.nodes.find((node) => nodeWorkflow(node)?.step === "assets.extract" && nodeWorkflow(node)?.role === "collection")!;
        const catalog = createWorkflowDocuments({ ...f.request, step: "assets.catalog", sourceNodeIds: [collection.id] }, extraction.nodes, extraction.connections, center);
        catalog.created[0].metadata!.content = "Legacy catalog";
        expect(workflowGenerationSources({ step: "assets.style", pipelineId: f.request.pipelineId, sourceNodeIds: [catalog.created[0].id], sourceSteps: ["assets.catalog"] }, catalog.nodes, catalog.connections).at(-1)?.id).toBe(catalog.created[0].id);
    });
});
