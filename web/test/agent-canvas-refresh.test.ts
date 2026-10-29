import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import localforage from "localforage";
import { canvasContentHash } from "@/lib/canvas/canvas-content";
import { readCanvasSyncDrafts } from "@/services/canvas-sync-drafts";
import { useSyncProgressStore } from "@/stores/use-sync-progress-store";
import { http } from "@/services/api/request";
import { applyAgentCanvasPatches, initializeRemoteUserDataSession, loadCanvasProjectForEditing, refreshCanvasAfterAgent, resetRemoteUserDataSync, subscribeAgentCanvasRefresh, saveRemoteUserDataNow } from "@/services/user-data-sync";
import { flushCanvasStorePersistence, useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType } from "@/types/canvas";
import { mergeAgentCanvasEditor } from "@/lib/canvas/agent-canvas-patch";

const initial: CanvasProject = { id: "agent-test", revision: 1, title: "测试", createdAt: "2026-01-01", updatedAt: "2026-01-01", nodes: [], connections: [], chatSessions: [], activeChatId: null, viewport: { x: 0, y: 0, k: 1 } };
const remote: CanvasProject = { ...initial, revision: 2, nodes: [{ id: "text-1", type: CanvasNodeType.Text, title: "剧本", position: { x: 20, y: 20 }, width: 320, height: 240, metadata: { content: "正文" } }] };
let unsubscribe = () => {};
let restore = () => {};
const originalGet = localforage.getItem;
const originalSet = localforage.setItem;
const originalWindow = globalThis.window;
const indexed = new Map<string, unknown>();
beforeEach(() => {
    resetRemoteUserDataSync();
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
        setTimeout: () => 1, clearTimeout: () => {},
        localStorage: { getItem: () => "agent-user", setItem: () => {} },
    } });
    indexed.clear();
    localforage.getItem = (async (key: string) => indexed.get(key) ?? null) as typeof localforage.getItem;
    localforage.setItem = (async (key: string, value: unknown) => { indexed.set(key, value); return value; }) as typeof localforage.setItem;
});
afterEach(async () => {
    unsubscribe(); restore(); resetRemoteUserDataSync();
    await flushCanvasStorePersistence();
    localforage.getItem = originalGet;
    localforage.setItem = originalSet;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
});

async function setup(project: CanvasProject = remote) {
    initial.remoteContentHash = await canvasContentHash(initial);
    useCanvasStore.setState({ projects: [initial] });
    await initializeRemoteUserDataSession("agent-user");
    const mock = spyOn(http, "get").mockResolvedValue({ project });
    restore = () => mock.mockRestore();
    return mock;
}

test("successful Agent refresh projects nodes into the open editor and store", async () => {
    await setup();
    let editor = initial;
    unsubscribe = subscribeAgentCanvasRefresh((project, previous) => {
        expect(previous).toEqual(initial);
        editor = project;
    });
    await refreshCanvasAfterAgent(initial.id);
    expect(editor.nodes).toEqual(remote.nodes);
    expect(useCanvasStore.getState().projects[0].nodes).toEqual(remote.nodes);
});

test("saved production documents reach the live editor despite a newer local receipt", async () => {
    const target = { ...remote.nodes[0], id: "plan", metadata: { status: "loading" as const, taskStage: "正在提交制作 Agent",
        shortDrama: { stage: "story" as const, step: "story.plan" as const, pipelineId: "pipeline", sourceNodeIds: [], sourceSignatures: {}, role: "document" as const, submission: "submitting" as const, productionAgent: {} },
    } };
    const ancestor = { ...initial, nodes: [target] };
    const accepted = { ...target, metadata: { ...target.metadata, taskStage: "制作 Agent 正在执行",
        shortDrama: { ...target.metadata.shortDrama, submission: "submitted" as const, productionAgent: { runId: "run-1" } },
    } };
    const cloud = { ...remote, nodes: [accepted, remote.nodes[0]] };
    const get = await setup(ancestor);
    await refreshCanvasAfterAgent(initial.id);
    get.mockResolvedValue({ project: cloud });
    let editor = { ...ancestor, nodes: [{ ...accepted, metadata: { ...accepted.metadata, taskStage: "已排队等待制作 Agent", prompt: "local prompt" } }] };
    unsubscribe = subscribeAgentCanvasRefresh((project, previous) => { editor = mergeAgentCanvasEditor(previous!, project, editor.nodes, editor.connections) as typeof editor; });
    await refreshCanvasAfterAgent(initial.id);
    expect(editor.nodes.map((node) => node.id)).toEqual(["plan", "text-1"]);
    expect(editor.nodes[0].metadata).toMatchObject({ taskStage: "制作 Agent 正在执行", prompt: "local prompt" });
    expect(useCanvasStore.getState().projects[0].revision).toBe(2);
    expect(useSyncProgressStore.getState().syncingProjects[initial.id].phase).not.toBe("conflict");
    expect(await readCanvasSyncDrafts(initial.id)).toHaveLength(0);
});

test("reopening after a production merge conflict loads the cloud result and archives the local version", async () => {
    const root = {
        id: "plan-root", type: CanvasNodeType.Frame, title: "制作方案", position: { x: 0, y: 0 }, width: 900, height: 500,
        metadata: { shortDrama: { stage: "story" as const, step: "story.plan" as const, pipelineId: "pipeline", sourceNodeIds: [], sourceSignatures: {}, role: "collection" as const, planVersion: 5 as const, planReady: false } },
    };
    const oldDocument = {
        id: "cloud-story", type: CanvasNodeType.Text, title: "本地草稿", parentId: root.id, position: { x: 20, y: 80 }, width: 300, height: 220,
        metadata: { status: "success" as const, content: "旧版本草稿", shortDrama: { stage: "story" as const, step: "story.plan" as const, pipelineId: "pipeline", sourceNodeIds: [], sourceSignatures: {}, role: "document" as const, planSection: "story" as const } },
    };
    const local = { ...initial, nodes: [root, oldDocument] };
    const completed = { ...root, metadata: { shortDrama: { ...root.metadata.shortDrama, sourceNodeIds: ["cloud-story"], planReady: true } } };
    const story = {
        id: "cloud-story", type: CanvasNodeType.Text, title: "故事总纲", parentId: root.id, position: { x: 20, y: 80 }, width: 300, height: 220,
        metadata: { status: "success" as const, content: "云端已完成的总纲", shortDrama: { stage: "story" as const, step: "story.plan" as const, pipelineId: "pipeline", sourceNodeIds: [], sourceSignatures: {}, role: "document" as const, planSection: "story" as const } },
    };
    const cloud = { ...local, revision: 2, nodes: [completed, story] };
    useCanvasStore.setState({ projects: [local] });
    await initializeRemoteUserDataSession("agent-user");
    const get = spyOn(http, "get").mockResolvedValue({ project: cloud });
    restore = () => get.mockRestore();

    await loadCanvasProjectForEditing(local.id);

    const loaded = useCanvasStore.getState().openProject(local.id)!;
    expect(loaded.revision).toBe(2);
    expect(loaded.nodes.map((node) => node.id)).toEqual(["plan-root", "cloud-story"]);
    expect(loaded.nodes.find((node) => node.id === "cloud-story")?.metadata?.content).toBe("云端已完成的总纲");
    expect(useSyncProgressStore.getState().syncingProjects[local.id]).toMatchObject({ phase: "done", message: "已加载云端已完成的制作内容，本地修改已保留为草稿" });
    expect((await readCanvasSyncDrafts(local.id)).some((draft) => draft.project.nodes.some((node) => node.id === "cloud-story" && node.metadata?.content === "旧版本草稿"))).toBe(true);
});

test("unsaved editor conflicts preserve store and acknowledged baseline", async () => {
    await setup();
    unsubscribe = subscribeAgentCanvasRefresh(() => { throw new Error("本地编辑冲突"); });
    await expect(refreshCanvasAfterAgent(initial.id)).rejects.toThrow("本地编辑冲突");
    expect(useCanvasStore.getState().projects[0]).toEqual(initial);
    unsubscribe();
    await refreshCanvasAfterAgent(initial.id);
    expect(useCanvasStore.getState().projects[0]).toMatchObject(remote);
});

test("independent local title and remote nodes merge and remain pending", async () => {
    await setup();
    useCanvasStore.setState({ projects: [{ ...initial, title: "本地修改" }] });
    let notified = false;
    unsubscribe = subscribeAgentCanvasRefresh(() => { notified = true; });
    await refreshCanvasAfterAgent(initial.id);
    expect(notified).toBe(true);
    expect(useCanvasStore.getState().projects[0].title).toBe("本地修改");
    expect(useCanvasStore.getState().projects[0].nodes).toEqual(remote.nodes);
    expect(useSyncProgressStore.getState().syncingProjects[initial.id].phase).toBe("pending");
});

test("automatic focus and panning do not block Agent updates or reset the local viewport", async () => {
    await setup();
    const viewport = { x: -800, y: -400, k: 0.7 };
    useCanvasStore.setState({ projects: [{ ...initial, viewport, updatedAt: "2026-09-13" }] });
    let editor = initial;
    unsubscribe = subscribeAgentCanvasRefresh((project) => { editor = project; });
    await refreshCanvasAfterAgent(initial.id);
    expect(editor.nodes).toEqual(remote.nodes);
    expect(editor.viewport).toEqual(viewport);
    expect(useCanvasStore.getState().projects[0].viewport).toEqual(viewport);
});

test("replayed completion events do not reapply unchanged canvas nodes", async () => {
    await setup();
    let deliveries = 0;
    unsubscribe = subscribeAgentCanvasRefresh(() => { deliveries += 1; });
    await refreshCanvasAfterAgent(initial.id);
    await refreshCanvasAfterAgent(initial.id);
    expect(deliveries).toBe(1);
});

test("media admission and completion refresh the editor with references and result", async () => {
    const video = { id: "video-1", type: CanvasNodeType.Video, title: "镜头1", position: { x: 500, y: 20 }, width: 360, height: 640, metadata: { taskId: "task-1", status: "loading" as const, referenceNodeIds: ["image-1"] } };
    const project: CanvasProject = { ...remote, nodes: [...remote.nodes, { ...video, id: "image-1", type: CanvasNodeType.Image }, video], connections: [{ id: "edge-1", fromNodeId: "image-1", toNodeId: "video-1" }] };
    const mock = await setup(project);
    let editor = initial;
    unsubscribe = subscribeAgentCanvasRefresh((updated) => { editor = updated; });
    await refreshCanvasAfterAgent(initial.id);
    expect(editor.connections).toEqual(project.connections);
    expect(editor.nodes.find((node) => node.id === "video-1")?.metadata?.referenceNodeIds).toEqual(["image-1"]);
    const complete: CanvasProject = { ...project, revision: 3, nodes: project.nodes.map((node) => node.id === "video-1" ? { ...node, metadata: { ...node.metadata, status: "success", storageKey: "resource:video-result" } } : node) };
    mock.mockResolvedValue({ project: complete });
    await refreshCanvasAfterAgent(initial.id);
    expect(editor.nodes.find((node) => node.id === "video-1")?.metadata?.storageKey).toBe("resource:video-result");
    expect(useCanvasStore.getState().projects[0].nodes).toEqual(complete.nodes);
});


test("incremental batches update the editor once without full canvas requests", async () => {
    const get = await setup();
    let deliveries = 0;
    unsubscribe = subscribeAgentCanvasRefresh(() => { deliveries++; });
    const patch = { canvasId: initial.id, baseRevision: 1, revision: 2, updatedAt: remote.updatedAt, nodes: remote.nodes.map((after) => ({ before: null, after })), connections: [] };
    await applyAgentCanvasPatches(initial.id, [patch, patch]);
    expect(get).not.toHaveBeenCalled();
    expect(deliveries).toBe(1);
    expect(useCanvasStore.getState().projects[0].nodes).toEqual(remote.nodes);
});

test("stale task history restores missing plan documents and saves them through the revisioned canvas API", async () => {
    await setup(initial);
    const frame = { id: "plan-frame", type: CanvasNodeType.Frame, title: "制作方案", position: { x: 0, y: 0 }, width: 900, height: 500,
        metadata: { shortDrama: { stage: "story" as const, step: "story.plan" as const, role: "collection" as const, sourceNodeIds: ["summary"], sourceSignatures: {}, planReady: false } } };
    const summary = { id: "summary", type: CanvasNodeType.Text, title: "故事总结", parentId: frame.id, position: { x: 20, y: 80 }, width: 320, height: 240,
        metadata: { status: "success" as const, content: "方案摘要", shortDrama: { stage: "story" as const, step: "story.plan" as const, role: "collection" as const, sourceNodeIds: [], sourceSignatures: {} } } };
    const note = { ...remote.nodes[0], id: "local-note", title: "本地笔记" };
    useCanvasStore.setState({ projects: [{ ...initial, nodes: [frame, summary, note] }] });
    const document = { id: "plan-doc", type: CanvasNodeType.Text, title: "资产总表", parentId: frame.id, position: { x: 20, y: 360 }, width: 400, height: 280,
        metadata: { status: "success" as const, content: "已完成的资产规范", shortDrama: { stage: "story" as const, step: "story.plan" as const, role: "document" as const, planSection: "inventory" as const, sourceNodeIds: [] } } };
    const patch = { canvasId: initial.id, baseRevision: 0, revision: 1, updatedAt: "2026-10-28T12:00:00Z", nodes: [{ before: null, after: document }], connections: [] };
    const put = spyOn(http, "put").mockImplementation(async (_url, body) => {
        const saved = JSON.parse(String(body)).project as CanvasProject;
        expect(saved.nodes.map((node) => node.id)).toContain(document.id);
        expect(saved.nodes.find((node) => node.id === note.id)?.title).toBe(note.title);
        return { project: { id: saved.id, title: saved.title, createdAt: saved.createdAt, updatedAt: saved.updatedAt, revision: 2 } } as never;
    });
    try {
        await applyAgentCanvasPatches(initial.id, [patch]);
        const saved = useCanvasStore.getState().projects[0];
        expect(saved.nodes.map((node) => node.id)).toEqual([frame.id, summary.id, note.id, document.id]);
        expect(saved.revision).toBe(2);
        expect(put).toHaveBeenCalledTimes(1);
    } finally { put.mockRestore(); }
});

test("already projected deltas still advance the remote baseline", async () => {
    await setup();
    useCanvasStore.setState({ projects: [{ ...remote, revision: 1 }] });
    let deliveries = 0;
    unsubscribe = subscribeAgentCanvasRefresh(() => { deliveries++; });
    await applyAgentCanvasPatches(initial.id, [{ canvasId: initial.id, baseRevision: 1, revision: 2, updatedAt: remote.updatedAt, nodes: remote.nodes.map((after) => ({ before: null, after })), connections: [] }]);
    expect(deliveries).toBe(0);
    await expect(refreshCanvasAfterAgent(initial.id)).resolves.toMatchObject(remote);
    expect(deliveries).toBe(0);
});

test("editor rejection keeps delta projection atomic and retryable", async () => {
    await setup();
    const patch = { canvasId: initial.id, baseRevision: 1, revision: 2, updatedAt: remote.updatedAt, nodes: remote.nodes.map((after) => ({ before: null, after })), connections: [] };
    unsubscribe = subscribeAgentCanvasRefresh(() => { throw new Error("编辑冲突"); });
    await expect(applyAgentCanvasPatches(initial.id, [patch])).rejects.toThrow("编辑冲突");
    expect(useCanvasStore.getState().projects[0]).toEqual(initial);
    unsubscribe();
    await applyAgentCanvasPatches(initial.id, [patch]);
    expect(useCanvasStore.getState().projects[0].nodes).toEqual(remote.nodes);
});


test("50 distinct media completions project once and keep the local viewport", async () => {
    const get = await setup();
    const nodes = Array.from({ length: 50 }, (_, index) => ({ id: `video-${index}`, title: `动画${index}`, type: CanvasNodeType.Video, position: { x: index * 400, y: 100 }, width: 320, height: 180, metadata: { status: "loading" as const, taskId: `task-${index}`, taskStatus: "running" } }));
    const pending = { ...initial, nodes };
    useCanvasStore.setState({ projects: [pending] });
    pending.remoteContentHash = await canvasContentHash(pending);
    await initializeRemoteUserDataSession("agent-user");
    let deliveries = 0;
    unsubscribe = subscribeAgentCanvasRefresh(() => { deliveries++; });
    await applyAgentCanvasPatches(initial.id, nodes.map((before, index) => ({ canvasId: initial.id, baseRevision: index + 1, revision: index + 2, updatedAt: initial.updatedAt, nodes: [{ before, after: { ...before, metadata: { ...before.metadata, status: index % 2 ? "error" as const : "success" as const, taskStatus: index % 2 ? "failed" : "succeeded" } } }], connections: [] })));
    const result = useCanvasStore.getState().projects[0];
    expect(result.nodes.filter((node) => node.metadata?.status === "success")).toHaveLength(25);
    expect(result.nodes.filter((node) => node.metadata?.status === "error")).toHaveLength(25);
    expect(result.viewport).toEqual(initial.viewport);
    expect(deliveries).toBe(1);
    expect(get).not.toHaveBeenCalled();
});

test("a delta gap reconciles against the cloud before declaring a conflict", async () => {
    await setup();
    await expect(applyAgentCanvasPatches(initial.id, [{ canvasId: initial.id, baseRevision: 2, revision: 3, nodes: [], connections: [] }])).rejects.toThrow("版本不连续");
    expect(useCanvasStore.getState().projects[0].revision).toBe(1);
    expect(useSyncProgressStore.getState().syncingProjects[initial.id]?.phase).not.toBe("conflict");
    expect(await readCanvasSyncDrafts(initial.id)).toHaveLength(0);
    await refreshCanvasAfterAgent(initial.id);
    expect(useCanvasStore.getState().projects[0]).toMatchObject(remote);
    expect(useSyncProgressStore.getState().syncingProjects[initial.id].phase).toBe("done");
});

test("reconciliation after a delta gap still protects genuinely conflicting edits", async () => {
    await setup({ ...remote, title: "远端也改了标题" });
    useCanvasStore.setState({ projects: [{ ...initial, title: "未保存标题" }] });
    await expect(applyAgentCanvasPatches(initial.id, [{ canvasId: initial.id, baseRevision: 2, revision: 3, nodes: [], connections: [] }])).rejects.toThrow("版本不连续");
    await expect(refreshCanvasAfterAgent(initial.id)).rejects.toThrow("冲突");
    expect(useSyncProgressStore.getState().syncingProjects[initial.id].phase).toBe("conflict");
    expect((await readCanvasSyncDrafts(initial.id))[0].project.title).toBe("未保存标题");
    await expect(saveRemoteUserDataNow(initial.id)).rejects.toThrow("云端画布已有更新");
});

test("an identical cloud snapshot clears a stale conflict without replaying editor nodes", async () => {
    await setup(initial);
    useSyncProgressStore.getState().setProjectProgress(initial.id, { phase: "conflict", draftCount: 9 });
    let deliveries = 0;
    unsubscribe = subscribeAgentCanvasRefresh(() => { deliveries++; });
    await refreshCanvasAfterAgent(initial.id);
    expect(deliveries).toBe(0);
    expect(useSyncProgressStore.getState().syncingProjects[initial.id]).toMatchObject({ phase: "done", draftCount: 9 });
    await expect(saveRemoteUserDataNow(initial.id)).resolves.toBeUndefined();
});

test("Agent completion is still projected when a stale canvas conflict flag exists", async () => {
    await setup(remote);
    useSyncProgressStore.getState().setProjectProgress(initial.id, { phase: "conflict", draftCount: 1 });
    const local = { ...remote, revision: 1, title: "本地未保存标题" };
    useCanvasStore.setState({ projects: [local] });

    await refreshCanvasAfterAgent(initial.id);

    expect(useCanvasStore.getState().projects[0].nodes).toEqual(remote.nodes);
    expect(useCanvasStore.getState().projects[0].title).toBe("本地未保存标题");
    expect(useSyncProgressStore.getState().syncingProjects[initial.id].phase).toBe("pending");
});

test("replayed events against an unchanged cloud ancestor preserve pending local edits", async () => {
    await setup(initial);
    await refreshCanvasAfterAgent(initial.id);
    const edited = { ...initial, title: "等待保存的标题" };
    useCanvasStore.setState({ projects: [edited] });
    await refreshCanvasAfterAgent(initial.id);
    expect(useCanvasStore.getState().projects[0]).toBe(edited);
    expect(useSyncProgressStore.getState().syncingProjects[initial.id].phase).toBe("pending");
    expect(await readCanvasSyncDrafts(initial.id)).toHaveLength(0);
});

test("a reopened dirty cache uses the hash-verified server ancestor, not the draft, as baseline", async () => {
    await setup(initial);
    const edited = { ...initial, title: "离线标题" };
    useCanvasStore.setState({ projects: [edited] });
    await initializeRemoteUserDataSession("agent-user");
    await refreshCanvasAfterAgent(initial.id);
    expect(useCanvasStore.getState().projects[0].title).toBe(edited.title);
    expect(useSyncProgressStore.getState().syncingProjects[initial.id].phase).toBe("pending");
});

test("Agent updates merge a local title edit and the next save uses the new revision", async () => {
    await setup();
    useCanvasStore.setState({ projects: [{ ...initial, title: "本地标题" }] });
    const patch = { canvasId: initial.id, baseRevision: 1, revision: 2, nodes: remote.nodes.map((after) => ({ before: null, after })), connections: [] };
    await applyAgentCanvasPatches(initial.id, [patch]);
    const merged = useCanvasStore.getState().projects[0];
    expect(merged.title).toBe("本地标题");
    expect(merged.revision).toBe(2);
    expect(merged.nodes).toEqual(remote.nodes);
    const put = spyOn(http, "put").mockImplementation(async (_url, body) => {
        const project = JSON.parse(String(body)).project as CanvasProject;
        expect(project.revision).toBe(2);
        return { project: { ...project, revision: 3 } } as never;
    });
    try {
        await saveRemoteUserDataNow(initial.id);
        expect(put).toHaveBeenCalledTimes(1);
        await applyAgentCanvasPatches(initial.id, [patch]);
        expect(useCanvasStore.getState().projects[0].revision).toBe(3);
        expect(useCanvasStore.getState().projects[0].title).toBe("本地标题");
    } finally { put.mockRestore(); }
});
