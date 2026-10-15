import { expect, test } from "bun:test";
import { retryWorkflowGeneration } from "@/services/workflow-generation-retry";
import { defaultConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { GenerationTask } from "@/services/api/task-center";

const task = (id: string, operation = "short_drama_batch", status: GenerationTask["status"] = "failed", retryOf?: string): GenerationTask => ({ id, operation, status, retryOf, type: "canvas_text", prompt: "分类要求", attempts: 1, createdAt: "", updatedAt: "" });
const node: CanvasNodeData = { id: "asset", type: CanvasNodeType.Text, title: "人物提取", position: { x: 0, y: 0 }, width: 400, height: 280,
    metadata: { prompt: "分类要求", model: "saved-model", shortDrama: { stage: "assets", step: "assets.characters", role: "document", pipelineId: "pipeline", sourceNodeIds: ["body"], sourceSignatures: {}, operationId: "operation",
        textBatch: { version: 2, scope: "pipeline", category: "characters", units: [{ label: "第1集", text: "甲在门口拿起钥匙。" }], context: [{ label: "制作方案", text: "计划12集" }] } } } };
function fixture(ancestors: GenerationTask[] = []) {
    const calls: string[] = []; let prepared: any;
    const api = {
        query: async (id: string) => { calls.push(`query:${id}`); const found = ancestors.find((t) => t.id === id); if (!found) throw new Error("task missing"); return found; },
        retry: async (id: string) => { calls.push(`retry:${id}`); return task(id, "short_drama_batch", "queued"); },
        create: async (_input: any) => { calls.push("create"); return task("new", "short_drama_batch", "queued"); },
        prepare: async (input: any) => { prepared = input; return input; },
    };
    return { api, calls, input: () => prepared };
}
test("failed workflow resumes its durable coordinator without creating a plain text task", async () => {
    const f = fixture(); const result = await retryWorkflowGeneration(node, task("original"), "canvas", defaultConfig, f.api);
    expect(result.id).toBe("original"); expect(f.calls).toEqual(["retry:original"]);
});
test("legacy generic retries trace back to the original batch, including false empty successes", async () => {
    const f = fixture([task("middle", "text", "failed", "original"), task("original")]);
    await retryWorkflowGeneration(node, task("empty", "text", "succeeded", "middle"), "canvas", defaultConfig, f.api);
    expect(f.calls).toEqual(["query:middle", "query:original", "retry:original"]);
});
test("a running coordinator is reattached without resubmission", async () => {
    const f = fixture(); const running = task("original", "short_drama_batch", "running");
    expect(await retryWorkflowGeneration(node, running, "canvas", defaultConfig, f.api)).toBe(running); expect(f.calls).toEqual([]);
});
test("actual backend sanitized input metadata resolves the original batch", async () => {
    const f = fixture([task("original")]);
    const legacy = { ...task("legacy", "text", "succeeded"), inputJson: JSON.stringify({ mode: "text", metadata: { retryOf: "original", attemptGroupId: "original" } }) };
    await retryWorkflowGeneration(node, legacy, "canvas", defaultConfig, f.api);
    expect(f.calls).toEqual(["query:original", "retry:original"]);
});
test("replacing invalid successful output carries all prose, constraints, model and workflow metadata", async () => {
    const f = fixture(); await retryWorkflowGeneration(node, task("invalid", "short_drama_batch", "succeeded"), "canvas", defaultConfig, f.api);
    expect(f.calls).toEqual(["create"]); expect(f.input().workflowBatch).toEqual(node.metadata!.shortDrama!.textBatch);
    expect(f.input().prompt).toBe("分类要求"); expect(f.input().config.model).toBe("saved-model");
    expect(f.input().streamText).toBe(false); expect(f.input().retryOf).toBe("invalid");
    expect(f.input().metadata.workflowStep).toBe("assets.characters"); expect(f.input().metadata.nodeId).toBe(node.id);
});
test("unresolvable ancestry and empty prose never fall back to generic generation", async () => {
    const f = fixture(); await expect(retryWorkflowGeneration(node, task("old", "text", "failed", "missing"), "canvas", defaultConfig, f.api)).rejects.toThrow("task missing");
    expect(f.calls).toEqual(["query:missing"]);
    const empty = structuredClone(node); empty.metadata!.shortDrama!.textBatch!.units = [];
    await expect(retryWorkflowGeneration(empty, undefined, "canvas", defaultConfig, f.api)).rejects.toThrow("缺少正文");
    expect(f.calls).not.toContain("create");
});
