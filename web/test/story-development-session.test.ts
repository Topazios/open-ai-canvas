import { describe, expect, test } from "bun:test";
import { advanceStoryDevelopment, createStoryDevelopmentChain, saveStoryDevelopmentNode, storySourceState } from "../src/lib/canvas/canvas-story-development";
import { createStorySessionStore, newStorySession, receiveStoryTask, recoverStorySession, restoreStoryRevision, storyDraftKey, storyJobActive, storyTaskMatches, type StorySession } from "../src/services/story-development-session";
import type { GenerationTask } from "../src/services/api/task-center";

const task = (status: GenerationTask["status"], extra: Partial<GenerationTask> = {}): GenerationTask => ({ id: "task-1", type: "canvas_text", status, prompt: "", attempts: 1, createdAt: "", updatedAt: "", ...extra });
const session = () => {
    const value = newStorySession(createStoryDevelopmentChain({ x: 0, y: 0 }).nodes[0], "fixture");
    value.job = { operationId: "op-1", status: "unknown", draw: false, topicCount: 4, draft: storyDraftKey(value), signatures: {} };
    return value;
};

describe("recoverable story operations", () => {
    test("completion writes the body and backs up the latest edits made during generation", () => {
        let value = receiveStoryTask(session(), task("running", { textDraft: "partial" }));
        expect(value.job?.partialText).toBe("partial");
        expect(storyJobActive(value.job)).toBe(true);
        expect(receiveStoryTask(value, task("running", { textDraft: "partial" }))).toBe(value);
        value = { ...value, content: "manual draft", dirty: true };
        value = receiveStoryTask(value, task("succeeded", { resultJson: JSON.stringify({ text: "complete" }) }));
        expect(value.content).toBe("complete");
        expect(value.previousVersion?.content).toBe("manual draft");
        expect(value.preview).toBeNull();
        expect(value.dirty).toBe(true);
        const undone = restoreStoryRevision(value);
        expect(undone.content).toBe("manual draft");
        expect(undone.previousVersion).toBeUndefined();
        expect(restoreStoryRevision(undone, true).content).toBe("complete");
        expect(storyJobActive(value.job)).toBe(false);
        expect(receiveStoryTask(value, task("running"))).toBe(value);
        expect(receiveStoryTask(undone, task("succeeded", { resultJson: JSON.stringify({ text: "complete" }) }))).toBe(undone);
    });
    test("failed, cancelled and malformed results preserve the original and partial text", () => {
        const original = { ...session(), content: "original" };
        for (const status of ["failed", "cancelled"] as const) {
            const value = receiveStoryTask(original, task(status, { error: "gateway timeout", textDraft: "incomplete" }));
            expect(value.content).toBe("original");
            expect(value.preview).toBeNull();
            expect(value.job?.partialText).toBe("incomplete");
            expect(value.job?.error).toBe("gateway timeout");
        }
        expect(receiveStoryTask(original, task("succeeded", { resultJson: "{}" })).job?.error).toContain("未返回内容");
    });
    test("topic results stay in the candidate list, preserve the selected body and are undoable", () => {
        const value = session(); value.job!.draw = true; value.job!.topicCount = 1;
        const result = task("succeeded", { resultJson: JSON.stringify({ text: JSON.stringify({ topics: [{ title: "title", logline: "story", conflict: "conflict", appeal: "appeal" }] }) }) });
        const accepted = receiveStoryTask(value, result);
        expect(accepted.data.candidates?.length).toBe(1);
        expect(accepted.content).toBe("");
        expect(accepted.dirty).toBe(true);
        const edited = receiveStoryTask({ ...value, content: "new topic" }, result);
        expect(edited.data.candidates).toHaveLength(1);
        expect(edited.content).toBe("new topic");
        expect(edited.preview).toBeNull();
        const undone = restoreStoryRevision(edited);
        expect(undone.data.candidates).toBeUndefined();
        expect(undone.content).toBe("new topic");
        const wrongCount = receiveStoryTask({ ...value, job: { ...value.job!, topicCount: 4 } }, result);
        expect(wrongCount.job?.error).toContain("与要求的 4 个不符");
        expect(wrongCount.job?.status).toBe("failed");
        expect(wrongCount.previousVersion).toBeUndefined();
    });
    test("all story documents retain exactly the preceding version and source provenance", () => {
        const nodes = createStoryDevelopmentChain({ x: 0, y: 0 }).nodes;
        for (const node of nodes) {
            const original = { ...newStorySession(node, "fixture"), content: "original", data: { ...node.metadata!.storyDevelopment!, sourceSignatures: { upstream: "original" } } };
            const first = receiveStoryTask({ ...original, job: { ...session().job!, signatures: { upstream: "first" } } }, task("succeeded", { resultJson: JSON.stringify({ text: "first" }) }));
            const second = receiveStoryTask({ ...first, job: { ...session().job!, operationId: "op-2", signatures: { upstream: "second" } } }, task("succeeded", { resultJson: JSON.stringify({ text: "second" }) }));
            expect(second.content).toBe("second");
            expect(second.previousVersion?.content).toBe("first");
            expect(second.previousVersion?.data.sourceSignatures).toEqual({ upstream: "first" });
            const restored = restoreStoryRevision(second);
            expect(restored.content).toBe("first");
            expect(restored.data.sourceSignatures).toEqual({ upstream: "first" });
            expect(restored.previousVersion).toBeUndefined();
            expect(restoreStoryRevision(restored)).toBe(restored);
            const running = { ...second, job: session().job };
            expect(restoreStoryRevision(running)).toBe(running);
        }
    });
    test("old blocked previews recover directly, once, without changing their upstream signatures", () => {
        const nodes = createStoryDevelopmentChain({ x: 0, y: 0 }).nodes;
        const plan = nodes[1];
        const saved = { ...newStorySession(plan, "fixture"), content: "most recent manual text", preview: { text: "old generated plan", draft: "obsolete draft key", signatures: { [nodes[0].id]: "old-topic" } } };
        const recovered = recoverStorySession(saved, plan, "fixture");
        expect(recovered.content).toBe("old generated plan");
        expect(recovered.previousVersion?.content).toBe("most recent manual text");
        expect(recovered.preview).toBeNull();
        expect(storySourceState(recovered.data, nodes).stale).toBe(true);
        expect(recoverStorySession(recovered, plan, "fixture")).toBe(recovered);
        const undone = restoreStoryRevision(recovered);
        expect(recoverStorySession(undone, plan, "fixture").content).toBe("most recent manual text");
        expect(recoverStorySession({ ...saved, preview: { ...saved.preview!, text: "invalid", topicCount: 4 } }, plan, "fixture").preview?.error).toBeTruthy();
    });
    test("clean local history cannot replace newer canvas data, dirty history retains conflict baseline", () => {
        const node = createStoryDevelopmentChain({ x: 0, y: 0 }).nodes[1];
        const result = receiveStoryTask({ ...newStorySession(node, "fixture"), job: session().job }, task("succeeded", { resultJson: JSON.stringify({ text: "AI draft" }) }));
        const updated = { ...node, metadata: { ...node.metadata, content: "another device" } };
        const clean = recoverStorySession({ ...result, dirty: false }, updated, "fixture");
        expect(clean.content).toBe("another device");
        expect(clean.previousVersion).toBeUndefined();
        const dirty = recoverStorySession(result, updated, "fixture");
        expect(dirty.content).toBe("AI draft");
        expect(dirty.baseSignature).toBe(result.baseSignature);
    });
    test("lost acknowledgements match exact safe operation IDs, never model or prompt", () => {
        expect(storyTaskMatches(task("running", { clientContext: { storyNodeId: "node", clientOperationId: "op-1" } }), "op-1")).toBe(true);
        expect(storyTaskMatches(task("running", { clientContext: { clientOperationId: "other" } }), "op-1")).toBe(false);
        expect(storyTaskMatches(task("running", { inputJson: "broken", prompt: "op-1" }), "op-1")).toBe(false);
    });
    test("durable drafts reject stale writes and allow recovery after storage failure", async () => {
        const values = new Map<string, string>();
        let fail = false;
        const storage = { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => { if (fail) throw new Error("storage full"); values.set(key, value); } };
        let queue = Promise.resolve();
        const lock = <T,>(_key: string, action: () => Promise<T>) => { const result = queue.then(action); queue = result.then(() => undefined, () => undefined); return result; };
        const store = createStorySessionStore("user-a", "canvas-a", "node-a", storage, lock);
        const value = receiveStoryTask({ ...session(), content: "before AI" }, task("succeeded", { resultJson: JSON.stringify({ text: "AI body" }) })); value.instruction = "keep suspense";
        expect(await store.write(value, 0)).toBe(1);
        const recovered = await store.read();
        expect(recovered?.instruction).toBe("keep suspense");
        expect(recovered?.job?.operationId).toBe("op-1");
        expect(recovered?.content).toBe("AI body");
        expect(recovered?.previousVersion?.content).toBe("before AI");
        await expect(store.write({ ...value, content: "stale tab" }, 0)).rejects.toThrow("另一窗口");
        fail = true;
        await expect(store.write(value, 1)).rejects.toThrow("storage full");
        fail = false;
        expect(await store.write({ ...value, content: "retry" }, 1)).toBe(2);
        expect((await store.read())?.content).toBe("retry");
        const undone = restoreStoryRevision((await store.read())!);
        expect(await store.write(undone, 2)).toBe(3);
        expect((await store.read())?.content).toBe("before AI");
        expect(restoreStoryRevision((await store.read())!, true).content).toBe("retry");
        expect(await createStorySessionStore("user-a", "other-canvas", "node-a", storage, lock).read()).toBeNull();
    });
    test("concurrent tabs can commit only one revision", async () => {
        let raw: string | null = null;
        let queue = Promise.resolve();
        const lock = <T,>(_key: string, action: () => Promise<T>) => { const result = queue.then(action); queue = result.then(() => undefined, () => undefined); return result; };
        const storage = { getItem: () => raw, setItem: (_key: string, value: string) => { raw = value; } };
        const a = createStorySessionStore("user", "canvas", "node", storage, lock);
        const b = createStorySessionStore("user", "canvas", "node", storage, lock);
        const outcomes = await Promise.allSettled([a.write(session(), 0), b.write(session(), 0)]);
        expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    });
});

describe("pipeline next actions", () => {
    test("blocks empty prerequisites, reuses existing nodes, recreates only missing next stage", () => {
        const chain = createStoryDevelopmentChain({ x: 0, y: 0 });
        const topic = chain.nodes[0];
        expect(() => advanceStoryDevelopment(topic.id, chain.nodes, chain.connections)).toThrow("请先保存");
        const nodes = saveStoryDevelopmentNode(chain.nodes, topic, topic.title!, "chosen topic", topic.metadata!.storyDevelopment!);
        const existing = advanceStoryDevelopment(topic.id, nodes, chain.connections);
        expect(existing.node).toBe(nodes[1]); expect(existing.nodes).toBe(nodes);
        const missing = nodes.filter((node) => node.id !== nodes[1].id);
        const created = advanceStoryDevelopment(topic.id, missing, []);
        expect(created.nodes.length).toBe(nodes.length);
        expect(created.node.metadata?.storyDevelopment?.sourceNodeIds).toEqual([topic.id]);
        expect(created.node.metadata?.storyDevelopment?.pipelineId).toBe(topic.metadata!.storyDevelopment!.pipelineId);
        const repairedPlan = saveStoryDevelopmentNode(created.nodes, created.node, "Plan", "new plan", created.node.metadata!.storyDevelopment!);
        const repairedOutline = advanceStoryDevelopment(created.node.id, repairedPlan, created.connections);
        expect(repairedOutline.node.metadata?.storyDevelopment?.sourceNodeIds).toEqual([topic.id, created.node.id]);
        expect(repairedOutline.node.metadata?.content).toBe(nodes[2].metadata?.content);
    });
});
