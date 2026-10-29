import { afterEach, beforeEach, expect, test } from "bun:test";
import localforage from "localforage";
import { apiClient } from "../src/services/api/request";
import { canvasContentHash } from "../src/lib/canvas/canvas-content";
import { rebaseCanvasProjects, parseCanvasStorageDocument, serializeCanvasStorageDocument } from "../src/lib/canvas/canvas-storage-revision";
import { readCanvasSyncDrafts } from "../src/services/canvas-sync-drafts";
import { applyAgentCanvasPatches, deleteCanvasProjectsWithRemoteSync, refreshCanvasAfterAgent, initializeRemoteUserDataSession, installRemoteUserDataAutoSync, loadCanvasProjectForEditing, resetRemoteUserDataSync, saveRemoteUserDataNow, syncRemoteUserData } from "../src/services/user-data-sync";
import { createAgentCanvasSync } from "../src/services/agent-canvas-sync";
import { CANVAS_STORE_KEY, flushCanvasStorePersistence, pendingCanvasStorePersistence, useCanvasStore, type CanvasProject } from "../src/stores/canvas/use-canvas-store";
import { flushAssetStorePersistence, useAssetStore } from "../src/stores/use-asset-store";
import { useSyncProgressStore } from "../src/stores/use-sync-progress-store";
import { CanvasNodeType } from "../src/types/canvas";
import { resourceFileUrl } from "../src/services/api/resources";
import { useUserStore } from "../src/stores/use-user-store";
import { invalidateAuthSessionCache } from "../src/services/api/auth";
import { defaultShortDramaSettings, DramaLanguage } from "../src/lib/short-drama-settings";
import { newDramaCanvasContent, workflowRequestWithCurrentSettings } from "../src/lib/canvas/canvas-global-settings";
import { createWorkflowDocuments, nodeWorkflow } from "../src/lib/canvas/canvas-short-drama-workflow";
import { completeUnifiedWorkflowPlan } from "./fixtures/workflow-plan";
import { createCanvasProjectWithRemoteSync, saveCanvasGlobalSettingsWithRemoteSync } from "../src/services/user-data-sync";

const originalWindow = globalThis.window;
const originalAdapter = apiClient.defaults.adapter;
const originalGet = localforage.getItem;
const originalSet = localforage.setItem;
const indexed = new Map<string, string>();
let scope = "";
let sequence = 0;
let autoSave: (() => void) | undefined;
let remote = new Map<string, CanvasProject>();
let requests: Array<{ method: string; id: string; project?: CanvasProject }> = [];
let beforePut: (() => Promise<void>) | undefined;
let deleteFailureId: string | undefined;
let temporaryPutFailures = 0;

function canvas(id = "canvas"): CanvasProject {
    return {
        id,
        revision: 1,
        title: id,
        createdAt: "2026-09-01T00:00:00Z",
        updatedAt: "2026-09-01T00:00:00Z",
        nodes: [{ id: "old-image", type: CanvasNodeType.Image, title: "image", position: { x: 0, y: 0 }, width: 100, height: 100 }],
        connections: [],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "dots",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
        directorScenes: [],
    };
}

function addNode(project: CanvasProject, id: string) {
    return { ...project, nodes: [...project.nodes, { ...project.nodes[0], id, type: CanvasNodeType.Video }] };
}

beforeEach(async () => {
    resetRemoteUserDataSync();
    scope = `canvas-revision-test-${++sequence}`;
    indexed.clear();
    requests = [];
    autoSave = undefined;
    beforePut = undefined;
    deleteFailureId = undefined;
    temporaryPutFailures = 0;
    remote = new Map([
        ["canvas", canvas()],
        ["other", canvas("other")],
    ]);
    Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: {
            setTimeout: (callback: () => void) => {
                autoSave = callback;
                return 1;
            },
            clearTimeout: () => {
                autoSave = undefined;
            },
            localStorage: { getItem: () => scope, setItem: () => undefined },
        },
    });
    localforage.getItem = (async (key: string) => indexed.get(key) ?? null) as typeof localforage.getItem;
    localforage.setItem = (async (key: string, value: string) => {
        indexed.set(key, value);
        return value;
    }) as typeof localforage.setItem;
    apiClient.defaults.adapter = async (config) => {
        const method = config.method || "get";
        const id = String(config.url).split("/").at(-1)!;
        const body = config.data ? JSON.parse(config.data) : undefined;
        requests.push({ method, id, project: body?.project });
        let data: unknown;
        let status = 200;
        if (id === "snapshot") data = { projects: structuredClone([...remote.values()]), assets: [] };
        else if (method === "delete") {
            if (id === deleteFailureId) status = 403;
            else {
                remote.delete(id);
                data = { id };
            }
        } else if (id === "batch" && method === "post") {
            data = { assets: [{
                id: "invalid-mime-asset", kind: "image", title: "历史素材", coverUrl: "", tags: [],
                createdAt: "2026-09-01", updatedAt: "2026-09-01",
                data: { dataUrl: "https://example.com/image.png", width: 100, height: 100, bytes: 1, mimeType: "image/*" },
            }] };
        } else if (id === "restore" && method === "post") {
            const current = remote.get("canvas")!;
            if (body.revision !== current.revision) status = 409;
            else {
                const saved = { ...canvas(), title: "historical content", revision: current.revision! + 1 };
                remote.set("canvas", saved);
                data = { project: saved };
            }
        } else if (method === "put") {
            await beforePut?.();
            const project = body.project as CanvasProject;
            const current = remote.get(id);
            if (temporaryPutFailures > 0) {
                temporaryPutFailures -= 1;
                status = 503;
            } else if (project.revision !== (current?.revision ?? 0)) status = 409;
            else {
                const saved = { ...structuredClone(project), revision: project.revision! + 1 };
                remote.set(id, saved);
                data = { project: saved };
            }
        } else data = { project: structuredClone(remote.get(id)) };
        return { config, status, statusText: "", headers: {}, data: { code: status === 200 ? 0 : status, data, msg: status === 409 ? "版本冲突" : "ok" } };
    };
    useCanvasStore.setState({ projects: [] });
    useAssetStore.setState({ assets: [] });
    installRemoteUserDataAutoSync();
    await syncRemoteUserData(scope);
});

async function waitForSyncState(predicate: () => boolean) {
    const deadline = Date.now() + 1_000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error("同步测试状态等待超时");
        await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
    }
}

afterEach(async () => {
    useUserStore.getState().clearSession();
    invalidateAuthSessionCache();
    resetRemoteUserDataSync();
    await Promise.all([flushCanvasStorePersistence(), flushAssetStorePersistence()]);
    apiClient.defaults.adapter = originalAdapter;
    localforage.getItem = originalGet;
    localforage.setItem = originalSet;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
});

function allowSessionRecovery() {
    const user = { id: scope, username: "fixture", displayName: "fixture", role: "user" as const, status: "active" as const };
    useUserStore.getState().setUser(user);
    useUserStore.getState().setHydrated(true);
    const adapter = apiClient.defaults.adapter as (config: any) => Promise<any>;
    apiClient.defaults.adapter = async (config) => {
        if (config.url !== "/auth/session") return adapter(config);
        requests.push({ method: "get", id: "session" });
        return { config, status: 200, statusText: "", headers: {}, data: { code: 0, data: { user } } };
    };
}

test("save verifies missing asset claims and uploads the repaired asset before the canvas", async () => {
    const adapter = apiClient.defaults.adapter as (config: any) => Promise<any>;
    const assets = new Map<string, any>();
    const order: string[] = [];
    apiClient.defaults.adapter = async config => {
        const body = config.data ? JSON.parse(config.data) : undefined;
        const ok = (data: unknown) => ({ config, status: 200, statusText: "OK", headers: {}, data: { code: 0, data } });
        if (config.url === "/assets/batch") { order.push("verify"); return ok({ assets: [] }); }
        if (config.url?.startsWith("/assets/") && config.method === "put") {
            order.push("asset"); assets.set(body.asset.id, body.asset); return ok({ asset: body.asset });
        }
        if (config.url === "/canvas-projects/canvas" && config.method === "put") {
            order.push("canvas");
            expect(assets.has(body.project.nodes[0].metadata.assetId)).toBe(true);
            expect(body.project.nodes[0].metadata.storageKey).toBe("resource:media-ready");
        }
        return adapter(config);
    };
    const current = useCanvasStore.getState().openProject("canvas")!;
    useCanvasStore.getState().updateProject("canvas", { nodes: [{ ...current.nodes[0], metadata: { assetId: "ghost-asset", storageKey: "resource:media-ready" } }] });
    await saveRemoteUserDataNow();
    expect(order).toEqual(["verify", "asset", "canvas"]);
    expect(remote.get("canvas")!.nodes[0].metadata!.assetId).not.toBe("ghost-asset");
});

test("missing sync session recovers authenticated baselines without acknowledging unsaved nodes", async () => {
    allowSessionRecovery();
    useCanvasStore.getState().renameProject("canvas", "pending generation");
    resetRemoteUserDataSync();
    requests = [];
    await Promise.all([saveRemoteUserDataNow("canvas"), saveRemoteUserDataNow("canvas")]);
    expect(remote.get("canvas")!.title).toBe("pending generation");
    expect(requests.filter((request) => request.method === "put")).toHaveLength(1);
    expect(requests.filter((request) => request.id === "session")).toHaveLength(1);
});

test("a failed initial sync can rebuild its authenticated baseline and deliver saved Agent documents", async () => {
    allowSessionRecovery();
    const adapter = apiClient.defaults.adapter as (config: any) => Promise<any>;
    let unavailable = true;
    apiClient.defaults.adapter = async (config) => {
        if (config.url === "/user-data/snapshot" && unavailable) throw new Error("snapshot temporarily unavailable");
        return adapter(config);
    };
    await expect(syncRemoteUserData(scope)).rejects.toThrow("snapshot temporarily unavailable");
    unavailable = false;
    useCanvasStore.getState().renameProject("canvas", "unsaved local title");
    remote.set("canvas", { ...addNode(remote.get("canvas")!, "saved-document"), revision: 2 });
    await refreshCanvasAfterAgent("canvas");
    await saveRemoteUserDataNow("canvas");
    expect(remote.get("canvas")!.title).toBe("unsaved local title");
    expect(remote.get("canvas")!.nodes.map((node) => node.id)).toEqual(["old-image", "saved-document"]);
    expect(useSyncProgressStore.getState().syncingProjects.canvas.phase).toBe("done");
});

test("recovering planned body payloads saves the same normalized baseline and does not repeat uploads", async () => {
    const created = newDramaCanvasContent(defaultShortDramaSettings());
    created.nodes[0].metadata!.content = "已选定的故事";
    const request = { step: "story.plan" as const, pipelineId: nodeWorkflow(created.nodes[0])!.pipelineId, sourceNodeIds: [created.nodes[0].id], model: "test", instruction: "", episodeCount: 2, minutesPerEpisode: "2", start: 1, count: 2 };
    const plans = createWorkflowDocuments(request, created.nodes, created.connections, { x: 0, y: 0 });
    const plan = completeUnifiedWorkflowPlan(plans);
    const outlines = createWorkflowDocuments({ ...request, step: "story.episodes", sourceNodeIds: [plan.frame.id] }, plans.nodes, plans.connections, { x: 0, y: 0 });
    outlines.created[0].metadata!.content = "## 第 1 集\n剧情一 CHR-0001\n## 第 2 集\n剧情二";
    outlines.created[0].metadata!.status = "success";
    const bodies = createWorkflowDocuments({ ...request, step: "story.body", sourceNodeIds: [outlines.created[0].id] }, outlines.nodes, outlines.connections, { x: 0, y: 0 });
    for (const body of bodies.created) {
        delete body.metadata!.shortDrama!.bodyContextVersion;
        body.metadata!.shortDrama!.textBatch = { version: 1, units: [{ label: "旧上下文", text: "旧上下文".repeat(20000) }] };
    }
    useCanvasStore.getState().updateProject("canvas", { nodes: bodies.nodes, connections: bodies.connections });
    await saveRemoteUserDataNow("canvas");
    const saved = remote.get("canvas")!;
    const local = useCanvasStore.getState().openProject("canvas")!;
    expect(saved.nodes.filter(node => node.metadata?.shortDrama?.bodyContextVersion === 1)).toHaveLength(2);
    expect(local.remoteContentHash).toBe(await canvasContentHash(local));
    expect(await canvasContentHash(saved)).toBe(await canvasContentHash(local));
    requests = [];
    await saveRemoteUserDataNow("canvas");
    expect(requests.filter(request => request.method === "put")).toHaveLength(0);
    const reopened = await loadCanvasProjectForEditing("canvas");
    expect(reopened!.nodes.map(node => node.id)).toEqual(saved.nodes.map(node => node.id));
});

test("global settings reject stale edits and keep durable changes when cloud save fails", async () => {
    const settings = defaultShortDramaSettings();
    temporaryPutFailures = 1;
    const result = await saveCanvasGlobalSettingsWithRemoteSync("canvas", "new title", settings);
    expect(result.syncError).toBeDefined();
    expect(useCanvasStore.getState().openProject("canvas")!.globalSettings).toEqual(settings);
    await expect(saveCanvasGlobalSettingsWithRemoteSync("canvas", "stale title", settings)).rejects.toThrow("全局设定已被更新");
    await saveRemoteUserDataNow("canvas");
    expect(remote.get("canvas")!.globalSettings).toEqual(settings);
    expect(remote.get("canvas")!.title).toBe("new title");
});

test("editing saved canvas settings reaches subsequent work after reopening without rewriting source nodes", async () => {
    const original = defaultShortDramaSettings();
    const created = newDramaCanvasContent(original);
    created.nodes[0].metadata!.content = "已有选题";
    useCanvasStore.getState().updateProject("canvas", created);
    await saveRemoteUserDataNow("canvas");
    const before = JSON.stringify(created.nodes);
    const next = { ...original, revision: 2, language: DramaLanguage.Japanese, episodeCount: 8 };
    expect((await saveCanvasGlobalSettingsWithRemoteSync("canvas", "更新后的设定", next)).syncError).toBeUndefined();
    const reopened = await loadCanvasProjectForEditing("canvas", { latest: true });
    expect(reopened!.globalSettings).toEqual(next);
    expect(JSON.stringify(reopened!.nodes)).toBe(before);
    const request = workflowRequestWithCurrentSettings({ step: "story.plan", pipelineId: nodeWorkflow(created.nodes[0])!.pipelineId, sourceNodeIds: [created.nodes[0].id], model: "test", instruction: "", episodeCount: 12, minutesPerEpisode: "3-5", start: 1, count: 1, globalSettings: original }, reopened!.globalSettings);
    const plan = createWorkflowDocuments(request, reopened!.nodes, [], { x: 0, y: 0 }).created[0];
    expect(plan.metadata?.prompt).toContain("正文语言：日语");
    expect(nodeWorkflow(plan)?.parameters?.episodeCount).toBe(8);
    expect(nodeWorkflow(plan)?.parameters?.globalSettings?.revision).toBe(2);
});

test("local storage failure leaves no duplicate canvas and allows retrying settings", async () => {
    await flushCanvasStorePersistence();
    const setItem = localforage.setItem;
    const originalIds = useCanvasStore.getState().projects.map((project) => project.id);
    localforage.setItem = (async () => { throw new Error("local storage unavailable"); }) as typeof localforage.setItem;
    try {
        await expect(createCanvasProjectWithRemoteSync("failed create", undefined, newDramaCanvasContent(defaultShortDramaSettings()))).rejects.toThrow();
        expect(useCanvasStore.getState().projects.map((project) => project.id)).toEqual(originalIds);
        await expect(saveCanvasGlobalSettingsWithRemoteSync("canvas", "failed edit", defaultShortDramaSettings())).rejects.toThrow();
        expect(useCanvasStore.getState().openProject("canvas")!.globalSettings).toBeUndefined();
        expect(useCanvasStore.getState().openProject("canvas")!.title).toBe("canvas");
    } finally { localforage.setItem = setItem; }
    await saveCanvasGlobalSettingsWithRemoteSync("canvas", "saved edit", defaultShortDramaSettings());
    expect(remote.get("canvas")!.title).toBe("saved edit");
});

test("global settings persist through cloud failure, retry, reopening and canvas import", async () => {
    const globalSettings = { ...defaultShortDramaSettings(), language: DramaLanguage.Japanese, episodeCount: 8 };
    useCanvasStore.getState().updateProject("canvas", newDramaCanvasContent(globalSettings));
    temporaryPutFailures = 1;
    await expect(saveRemoteUserDataNow("canvas")).rejects.toThrow();
    expect(useCanvasStore.getState().openProject("canvas")!.globalSettings).toEqual(globalSettings);
    expect(remote.get("canvas")!.globalSettings).toBeUndefined();
    await saveRemoteUserDataNow("canvas");
    expect(remote.get("canvas")!.globalSettings).toEqual(globalSettings);
    const reopened = await loadCanvasProjectForEditing("canvas", { latest: true });
    expect(reopened!.globalSettings).toEqual(globalSettings);
    const importedId = useCanvasStore.getState().importProject(reopened!);
    await flushCanvasStorePersistence();
    expect(useCanvasStore.getState().openProject(importedId)!.globalSettings).toEqual(globalSettings);
    const next = { ...globalSettings, revision: 2, episodeCount: 10 };
    useCanvasStore.getState().updateProject("canvas", { globalSettings: next });
    await saveRemoteUserDataNow("canvas");
    expect(remote.get("canvas")!.globalSettings).toEqual(next);
    expect(useCanvasStore.getState().openProject(importedId)!.globalSettings).toEqual(globalSettings);
});

test("recovering sync preserves node deletions and saves them instead of restoring the remote nodes", async () => {
    allowSessionRecovery();
    useCanvasStore.getState().updateProject("canvas", { nodes: [] });
    resetRemoteUserDataSync();
    await saveRemoteUserDataNow("canvas");
    expect(remote.get("canvas")!.nodes).toHaveLength(0);
    expect(useCanvasStore.getState().openProject("canvas")!.nodes).toHaveLength(0);
});

test("sync recovery preserves conflicts and never authorizes another account's drafts", async () => {
    allowSessionRecovery();
    useCanvasStore.getState().renameProject("canvas", "local edit");
    remote.set("canvas", { ...remote.get("canvas")!, title: "remote edit", revision: 2 });
    resetRemoteUserDataSync();
    await expect(saveRemoteUserDataNow("canvas")).rejects.toThrow();
    expect(remote.get("canvas")!.title).toBe("remote edit");
    expect(useCanvasStore.getState().openProject("canvas")!.title).toBe("local edit");
    resetRemoteUserDataSync();
    scope = "different-account";
    requests = [];
    await expect(saveRemoteUserDataNow("canvas")).rejects.toThrow("同步会话");
    expect(requests).toHaveLength(0);
});

test("logout during recovery stops writes and the failed recovery can be retried", async () => {
    allowSessionRecovery();
    useCanvasStore.getState().renameProject("canvas", "draft");
    resetRemoteUserDataSync();
    const adapter = apiClient.defaults.adapter as (config: any) => Promise<any>;
    apiClient.defaults.adapter = async (config) => {
        if (String(config.url).endsWith("snapshot")) useUserStore.getState().clearSession();
        return adapter(config);
    };
    requests = [];
    await expect(saveRemoteUserDataNow("canvas")).rejects.toThrow("账号已切换");
    expect(requests.filter((request) => request.method === "put")).toHaveLength(0);
    apiClient.defaults.adapter = adapter;
    allowSessionRecovery();
    await saveRemoteUserDataNow("canvas");
    expect(remote.get("canvas")!.title).toBe("draft");
});

async function otherTabEdit(update: (project: CanvasProject) => CanvasProject) {
    await flushCanvasStorePersistence();
    const key = `${CANVAS_STORE_KEY}:user:${scope}`;
    const document = parseCanvasStorageDocument(indexed.get(key) || null);
    const changed = rebaseCanvasProjects({ document, baseProjects: document.state.projects,
        localProjects: document.state.projects.map((project) => project.id === "canvas" ? update(structuredClone(project)) : project), baseRevision: document.storageRevision });
    indexed.set(key, serializeCanvasStorageDocument(changed.document));
    return key;
}

test("same-field local conflicts preserve a draft, stop cloud upload and keep subsequent edits recoverable", async () => {
    const key = await otherTabEdit((project) => ({ ...project, title: "other tab" }));
    useCanvasStore.getState().renameProject("canvas", "this tab");
    requests = [];
    await expect(saveRemoteUserDataNow("canvas")).rejects.toThrow();
    expect(requests.filter((request) => request.method === "put")).toHaveLength(0);
    expect(useSyncProgressStore.getState().syncingProjects.canvas).toMatchObject({ phase: "conflict", draftCount: 1 });
    expect(parseCanvasStorageDocument(indexed.get(key)!).state.projects.find((project) => project.id === "canvas")!.title).toBe("other tab");
    expect((await readCanvasSyncDrafts("canvas"))[0].project.title).toBe("this tab");
    const current = useCanvasStore.getState().openProject("canvas")!;
    useCanvasStore.getState().updateProject("canvas", { nodes: current.nodes.map((node) => ({ ...node, title: "continued editing" })) });
    await flushCanvasStorePersistence();
    const drafts = await readCanvasSyncDrafts("canvas");
    expect(drafts).toHaveLength(2);
    expect(drafts[1].project.title).toBe("this tab");
    expect(drafts[1].project.nodes[0].title).toBe("continued editing");
    expect(parseCanvasStorageDocument(indexed.get(key)!).state.projects.find((project) => project.id === "canvas")!.title).toBe("other tab");
    await useCanvasStore.persist.rehydrate();
    expect(useCanvasStore.getState().openProject("canvas")!.title).toBe("other tab");
    expect(await readCanvasSyncDrafts("canvas")).toHaveLength(2);
});

test("failed local conflict backup leaves the original document and queued edit available for retry", async () => {
    const key = await otherTabEdit((project) => ({ ...project, title: "other tab" }));
    const before = indexed.get(key);
    const write = localforage.setItem;
    localforage.setItem = (async (key: string, value: string) => {
        if (key.includes("sync-drafts:")) throw new Error("Synthetic disk full");
        return write(key, value);
    }) as typeof localforage.setItem;
    useCanvasStore.getState().renameProject("canvas", "unsaved local title");
    try {
        await expect(flushCanvasStorePersistence()).rejects.toThrow("Synthetic disk full");
        expect(indexed.get(key)).toBe(before);
        expect(pendingCanvasStorePersistence(scope)?.projects.find((project) => project.id === "canvas")!.title).toBe("unsaved local title");
        expect(useSyncProgressStore.getState().syncingProjects.canvas).toMatchObject({ phase: "error", draftCount: undefined });
        expect(useSyncProgressStore.getState().syncingProjects.canvas.message).toContain("请勿关闭");
    } finally { localforage.setItem = write; }
    await flushCanvasStorePersistence();
    expect(pendingCanvasStorePersistence(scope)).toBeNull();
    expect((await readCanvasSyncDrafts("canvas"))[0].project.title).toBe("unsaved local title");
});

test("explicit load latest resolves a local conflict without discarding either tab's draft", async () => {
    const key = await otherTabEdit((project) => ({ ...project, title: "other tab" }));
    useCanvasStore.getState().renameProject("canvas", "this tab");
    await flushCanvasStorePersistence();
    await loadCanvasProjectForEditing("canvas", { latest: true });
    expect(useSyncProgressStore.getState().syncingProjects.canvas.phase).toBe("done");
    expect(parseCanvasStorageDocument(indexed.get(key)!).state.projects.find((project) => project.id === "canvas")!.title).toBe("canvas");
    expect((await readCanvasSyncDrafts("canvas")).map((draft) => draft.project.title).sort()).toEqual(["other tab", "this tab"]);
    useCanvasStore.getState().renameProject("canvas", "resolved edit");
    await saveRemoteUserDataNow("canvas");
    expect(remote.get("canvas")!.title).toBe("resolved edit");
    expect(useSyncProgressStore.getState().syncingProjects.canvas.phase).toBe("done");
});

test("ordinary local write failures remain retryable and cannot be reported as saved to cloud", async () => {
    await flushCanvasStorePersistence();
    const write = localforage.setItem;
    localforage.setItem = (async (key: string, value: string) => {
        if (key.includes(CANVAS_STORE_KEY)) throw new Error("Synthetic local write failure");
        return write(key, value);
    }) as typeof localforage.setItem;
    useCanvasStore.getState().renameProject("canvas", "retry local write");
    requests = [];
    try {
        await expect(saveRemoteUserDataNow("canvas")).rejects.toThrow("Synthetic local write failure");
        expect(requests.filter((request) => request.method === "put")).toHaveLength(0);
        expect(useSyncProgressStore.getState().syncingProjects.canvas.phase).toBe("error");
        expect(useSyncProgressStore.getState().syncingProjects.canvas.message).toContain("本地保存失败");
        expect(pendingCanvasStorePersistence(scope)).not.toBeNull();
    } finally { localforage.setItem = write; }
    await saveRemoteUserDataNow("canvas");
    expect(remote.get("canvas")!.title).toBe("retry local write");
    expect(useSyncProgressStore.getState().syncingProjects.canvas.phase).toBe("done");
    expect(pendingCanvasStorePersistence(scope)).toBeNull();
});

test("edits during an explicit replacement remain pending and are saved against the loaded revision", async () => {
    await otherTabEdit((project) => ({ ...project, title: "other tab" }));
    useCanvasStore.getState().renameProject("canvas", "this tab");
    await flushCanvasStorePersistence();
    const write = localforage.setItem;
    let injected = false;
    localforage.setItem = (async (key: string, value: string) => {
        const result = await write(key, value);
        if (!injected && key.includes(CANVAS_STORE_KEY)) {
            injected = true;
            useCanvasStore.getState().renameProject("canvas", "edit during replacement");
        }
        return result;
    }) as typeof localforage.setItem;
    try { await loadCanvasProjectForEditing("canvas", { latest: true }); } finally { localforage.setItem = write; }
    expect(injected).toBe(true);
    expect(useCanvasStore.getState().openProject("canvas")!.title).toBe("edit during replacement");
    expect(useSyncProgressStore.getState().syncingProjects.canvas.phase).toBe("pending");
    await saveRemoteUserDataNow("canvas");
    expect(remote.get("canvas")!.title).toBe("edit during replacement");
    expect(useSyncProgressStore.getState().syncingProjects.canvas.phase).toBe("done");
});

test("a conflict committed after account switch cannot publish status into the new account", async () => {
    await otherTabEdit((project) => ({ ...project, title: "other tab" }));
    const originalScope = scope;
    const write = localforage.setItem;
    localforage.setItem = (async (key: string, value: string) => {
        if (key.includes("sync-drafts:")) {
            scope = "new-account";
            useSyncProgressStore.getState().clearAll();
        }
        return write(key, value);
    }) as typeof localforage.setItem;
    useCanvasStore.getState().renameProject("canvas", "old account edit");
    try {
        await flushCanvasStorePersistence();
        expect(useSyncProgressStore.getState().syncingProjects).toEqual({});
        expect((await readCanvasSyncDrafts("canvas", originalScope))[0].project.title).toBe("old account edit");
        expect(await readCanvasSyncDrafts("canvas", "new-account")).toHaveLength(0);
    } finally { localforage.setItem = write; scope = originalScope; }
});

test("successive local writes merge independent fields but cannot upload a stale full projection", async () => {
    const key = await otherTabEdit((project) => ({ ...project, nodes: project.nodes.map((node) => ({ ...node, title: "other node title" })) }));
    useCanvasStore.getState().renameProject("canvas", "first local title");
    await flushCanvasStorePersistence();
    useCanvasStore.getState().renameProject("canvas", "second local title");
    await flushCanvasStorePersistence();
    const durable = parseCanvasStorageDocument(indexed.get(key)!).state.projects.find((project) => project.id === "canvas")!;
    expect(durable.title).toBe("second local title");
    expect(durable.nodes[0].title).toBe("other node title");
    expect(await readCanvasSyncDrafts("canvas")).toHaveLength(2);
    requests = [];
    await expect(saveRemoteUserDataNow("canvas")).rejects.toThrow();
    expect(requests.filter((request) => request.method === "put")).toHaveLength(0);
});

test("local conflict backup includes edits arriving while the first draft is being written", async () => {
    await otherTabEdit((project) => ({ ...project, title: "other tab" }));
    const write = localforage.setItem;
    let injected = false;
    localforage.setItem = (async (key: string, value: string) => {
        if (key.includes("sync-drafts:") && !injected) {
            injected = true;
            useCanvasStore.getState().renameProject("canvas", "newer local edit");
        }
        return write(key, value);
    }) as typeof localforage.setItem;
    useCanvasStore.getState().renameProject("canvas", "older local edit");
    try { await flushCanvasStorePersistence(); } finally { localforage.setItem = write; }
    expect((await readCanvasSyncDrafts("canvas")).map((draft) => draft.project.title)).toEqual(["older local edit", "newer local edit"]);
    expect(pendingCanvasStorePersistence(scope)).toBeNull();
});

test("a stale edit cannot revive a deleted node and remains available in a draft", async () => {
    const key = await otherTabEdit((project) => ({ ...project, nodes: [] }));
    const current = useCanvasStore.getState().openProject("canvas")!;
    useCanvasStore.getState().updateProject("canvas", { nodes: current.nodes.map((node) => ({ ...node, title: "stale edit" })) });
    await flushCanvasStorePersistence();
    expect(parseCanvasStorageDocument(indexed.get(key)!).state.projects.find((project) => project.id === "canvas")!.nodes).toHaveLength(0);
    expect((await readCanvasSyncDrafts("canvas"))[0].project.nodes[0].title).toBe("stale edit");
});

test("deletion skips editing and invalid MIME assets, including an uncached canvas", async () => {
    const project = canvas();
    project.nodes[0].metadata = { assetId: "invalid-mime-asset" };
    remote.set(project.id, project);
    await initializeRemoteUserDataSession(scope);
    await expect(loadCanvasProjectForEditing(project.id)).rejects.toThrow("具体 MIME");
    useCanvasStore.getState().deleteProjects(["other"]);
    await flushCanvasStorePersistence();
    requests = [];

    await deleteCanvasProjectsWithRemoteSync([" canvas ", "canvas", "other"]);

    expect(requests.map(({ method, id }) => ({ method, id }))).toEqual([
        { method: "delete", id: "canvas" }, { method: "delete", id: "other" },
    ]);
    expect(remote.size).toBe(0);
    expect(useCanvasStore.getState().projects).toEqual([]);
    await useCanvasStore.persist.rehydrate();
    expect(useCanvasStore.getState().projects).toEqual([]);
});

test("batch deletion retains failed canvases and persists successful deletions", async () => {
    await initializeRemoteUserDataSession(scope);
    deleteFailureId = "other";

    await expect(deleteCanvasProjectsWithRemoteSync(["canvas", "other"])).rejects.toThrow();

    expect([...remote.keys()]).toEqual(["other"]);
    expect(useCanvasStore.getState().projects.map((project) => project.id)).toEqual(["other"]);
    await useCanvasStore.persist.rehydrate();
    expect(useCanvasStore.getState().projects.map((project) => project.id)).toEqual(["other"]);
});

test("stale viewport, no-op restore and open do not submit old content", async () => {
    const old = useCanvasStore.getState().openProject("canvas")!;
    remote.set("canvas", { ...addNode(canvas(), "afternoon-video"), revision: 2 });
    useCanvasStore.getState().updateProject("canvas", { viewport: { x: 100, y: 40, k: 2 } });
    useCanvasStore.getState().updateProject("canvas", { nodes: structuredClone(old.nodes), connections: [] });
    expect(autoSave).toBeUndefined();
    expect(useCanvasStore.getState().openProject("canvas")!.updatedAt).toBe(old.updatedAt);
    await flushCanvasStorePersistence();
    await saveRemoteUserDataNow();
    const latest = await loadCanvasProjectForEditing("canvas");
    expect(latest.nodes.map((node) => node.id)).toEqual(["old-image", "afternoon-video"]);
    expect(latest.revision).toBe(2);
    expect(latest.viewport).toEqual({ x: 100, y: 40, k: 2 });
    await saveRemoteUserDataNow();
    expect(requests.filter((request) => request.method === "put")).toHaveLength(0);
});

test("remote sync preserves uploaded text bodies instead of replacing them with resource URLs", async () => {
    const project = useCanvasStore.getState().openProject("canvas")!;
    useCanvasStore.getState().updateProject("canvas", {
        nodes: [...project.nodes, {
            id: "script",
            type: CanvasNodeType.Text,
            title: "剧本.txt",
            position: { x: 0, y: 0 },
            width: 320,
            height: 240,
            metadata: { content: "第一场：开场", prompt: "第一场：开场", storageKey: "resource:text-file", mimeType: "text/plain" },
        }],
    });
    await saveRemoteUserDataNow("canvas");
    const text = remote.get("canvas")?.nodes.find((node) => node.id === "script");
    expect(text?.metadata?.content).toBe("第一场：开场");
    expect(text?.metadata?.prompt).toBe("第一场：开场");
    expect(text?.metadata?.storageKey).toBe("resource:text-file");
    expect(text?.metadata?.content).not.toBe(resourceFileUrl("text-file"));
});

test("load latest, save and reload stay synced when Agent history replays an unversioned delta", async () => {
    remote.set("canvas", { ...canvas(), revision: 9 });
    await loadCanvasProjectForEditing("canvas", { latest: true });
    useCanvasStore.getState().renameProject("canvas", "已保存的标题");
    await saveRemoteUserDataNow("canvas");
    expect(remote.get("canvas")!.revision).toBe(10);

    for (let reload = 0; reload < 3; reload++) {
        resetRemoteUserDataSync();
        await useCanvasStore.persist.rehydrate();
        await initializeRemoteUserDataSession(scope);
        await loadCanvasProjectForEditing("canvas");
        let resolve!: () => void;
        let reject!: (error: unknown) => void;
        const reconciled = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
        const sync = createAgentCanvasSync({
            canvasId: "canvas", batchMs: 0,
            applyPatches: (patches) => applyAgentCanvasPatches("canvas", patches),
            refresh: async () => { await refreshCanvasAfterAgent("canvas"); resolve(); },
            onError: reject,
        });
        try {
            sync.receive({ eventId: "historical-event", runId: "completed-run", seq: 1, type: "canvas_updated", createdAt: "2026-09-17", payload: {
                canvasId: "canvas",
                canvasPatch: { canvasId: "canvas", updatedAt: "2026-09-17", nodes: [{ before: null, after: { ...canvas().nodes[0], id: "stale-node" } }], connections: [] },
            } });
            await reconciled;
            expect(useSyncProgressStore.getState().syncingProjects.canvas.phase).toBe("done");
            await saveRemoteUserDataNow("canvas");
            expect(useCanvasStore.getState().openProject("canvas")).toMatchObject({ revision: 10, title: "已保存的标题", nodes: canvas().nodes });
            expect(await readCanvasSyncDrafts("canvas")).toHaveLength(0);
        } finally { sync.dispose(); }
    }
    expect(requests.filter((request) => request.method === "put")).toHaveLength(1);
});

test("a stale save auto-reconciles when the cloud already contains the identical local content", async () => {
    useCanvasStore.getState().renameProject("canvas", "same content saved elsewhere");
    beforePut = async () => {
        const current = useCanvasStore.getState().openProject("canvas")!;
        remote.set("canvas", { ...structuredClone(current), revision: current.revision! + 1 });
    };

    await expect(saveRemoteUserDataNow("canvas")).resolves.toBeUndefined();

    expect(useCanvasStore.getState().openProject("canvas")).toMatchObject({ title: "same content saved elsewhere", revision: 2 });
    expect(useSyncProgressStore.getState().syncingProjects.canvas).toMatchObject({ phase: "done" });
    expect(await readCanvasSyncDrafts("canvas")).toHaveLength(0);
});

test("a conflict preserves drafts, stops retries and does not block another canvas", async () => {
    remote.set("canvas", { ...addNode(canvas(), "remote-video"), title: "remote title", revision: 2 });
    useCanvasStore.getState().updateProject("canvas", { nodes: addNode(canvas(), "local-video").nodes });
    useCanvasStore.getState().renameProject("canvas", "local title");
    useCanvasStore.getState().renameProject("other", "other edit");
    await expect(saveRemoteUserDataNow()).rejects.toThrow("版本冲突");
    expect(remote.get("canvas")!.nodes.map((node) => node.id)).toEqual(["old-image", "remote-video"]);
    expect(remote.get("other")!.title).toBe("other edit");
    expect(useSyncProgressStore.getState().syncingProjects.canvas.phase).toBe("conflict");
    expect((await readCanvasSyncDrafts("canvas"))[0].project.nodes.at(-1)!.id).toBe("local-video");
    useCanvasStore.getState().renameProject("canvas", "more local edits");
    await expect(saveRemoteUserDataNow()).rejects.toThrow("云端画布已有更新");
    useCanvasStore.getState().renameProject("other", "still saves independently");
    await saveRemoteUserDataNow("other");
    expect(remote.get("other")!.title).toBe("still saves independently");
    await expect(saveRemoteUserDataNow(["canvas", "other"])).rejects.toThrow("云端画布已有更新");
    expect(requests.filter((request) => request.method === "put" && request.id === "canvas")).toHaveLength(1);
    await expect(saveRemoteUserDataNow("canvas")).rejects.toThrow("云端画布已有更新");
    await loadCanvasProjectForEditing("canvas", { latest: true });
    expect(useCanvasStore.getState().openProject("canvas")!.nodes.at(-1)!.id).toBe("remote-video");
    expect((await readCanvasSyncDrafts("canvas")).some((draft) => draft.project.title === "more local edits")).toBe(true);
    resetRemoteUserDataSync();
    await useCanvasStore.persist.rehydrate();
    await syncRemoteUserData(scope);
    expect(useSyncProgressStore.getState().syncingProjects.canvas.draftCount).toBe(2);
});

test("generation save rebases independent nodes and retries with the current revision", async () => {
    remote.set("canvas", { ...addNode(canvas(), "agent-result"), revision: 2 });
    useCanvasStore.getState().updateProject("canvas", { nodes: addNode(canvas(), "generation-target").nodes });
    await saveRemoteUserDataNow("canvas");
    expect(remote.get("canvas")!.nodes.map((node) => node.id).sort()).toEqual(["agent-result", "generation-target", "old-image"]);
    expect(remote.get("canvas")!.revision).toBe(3);
    expect(requests.filter((request) => request.method === "put").map((request) => request.project!.revision)).toEqual([1, 2]);
    expect(useSyncProgressStore.getState().syncingProjects.canvas.phase).toBe("done");
});

test("generation save only persists its canvas instead of failing on an unrelated conflict", async () => {
    remote.set("other", { ...canvas("other"), title: "remote title", revision: 2 });
    useCanvasStore.getState().renameProject("other", "unrelated local title");
    useCanvasStore.getState().updateProject("canvas", { nodes: addNode(canvas(), "generation-target").nodes });

    await saveRemoteUserDataNow("canvas");

    expect(remote.get("canvas")!.nodes.at(-1)!.id).toBe("generation-target");
    expect(requests.filter(request => request.method === "put").map(request => request.id)).toEqual(["canvas"]);
    expect(useCanvasStore.getState().openProject("other")!.title).toBe("unrelated local title");
});

test("generation save recovers after an in-flight global save fails on another canvas", async () => {
    remote.set("other", { ...canvas("other"), title: "remote title", revision: 2 });
    useCanvasStore.getState().renameProject("other", "unrelated local title");
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    beforePut = async () => { started(); await waiting; };
    const background = saveRemoteUserDataNow().then(() => undefined, error => error);
    await entered;
    useCanvasStore.getState().updateProject("canvas", { nodes: addNode(canvas(), "generation-target").nodes });
    const saving = saveRemoteUserDataNow("canvas");
    release();

    expect(await background).toBeInstanceOf(Error);
    await saving;

    expect(remote.get("canvas")!.nodes.at(-1)!.id).toBe("generation-target");
    expect(useSyncProgressStore.getState().syncingProjects.canvas.phase).toBe("done");
    expect(useSyncProgressStore.getState().syncingProjects.other.phase).toBe("conflict");
    expect(requests.filter(request => request.method === "put" && request.id === "canvas")).toHaveLength(1);
});

test("a joined generation save rechecks a recoverable conflict after the prior save settles", async () => {
    useCanvasStore.getState().renameProject("other", "saved elsewhere");
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    beforePut = async () => { started(); await waiting; };
    const background = saveRemoteUserDataNow().then(() => undefined, error => error);
    await entered;
    useCanvasStore.getState().updateProject("canvas", { nodes: addNode(canvas(), "generation-target").nodes });
    useSyncProgressStore.getState().setProjectProgress("canvas", { phase: "conflict" });
    const saving = saveRemoteUserDataNow("canvas").then(() => undefined, error => error);
    release();

    expect((await background)?.message).toContain("云端画布已有更新");
    expect(await saving).toBeUndefined();

    expect(remote.get("canvas")!.nodes.at(-1)!.id).toBe("generation-target");
    expect(useSyncProgressStore.getState().syncingProjects.canvas.phase).toBe("done");
});

test("deleting a node wins over background completion and drops its new connections", async () => {
    const completed = addNode(canvas(), "other-result");
    completed.nodes[0] = { ...completed.nodes[0], metadata: { status: "success", content: "completed" } };
    completed.connections = [{ id: "late-edge", fromNodeId: "old-image", toNodeId: "other-result" }];
    remote.set("canvas", { ...completed, revision: 2 });
    useCanvasStore.getState().updateProject("canvas", { nodes: [], connections: [] });
    await saveRemoteUserDataNow("canvas");
    expect(remote.get("canvas")!.nodes.map((node) => node.id)).toEqual(["other-result"]);
    expect(remote.get("canvas")!.connections).toEqual([]);
    await refreshCanvasAfterAgent("canvas");
    expect(useCanvasStore.getState().openProject("canvas")!.nodes.map((node) => node.id)).toEqual(["other-result"]);
});

test("a stale conflict flag is rechecked before generation or deletion saves", async () => {
    remote.set("canvas", { ...addNode(canvas(), "agent-result"), revision: 2 });
    useCanvasStore.getState().updateProject("canvas", { nodes: addNode(canvas(), "target").nodes });
    useSyncProgressStore.getState().setProjectProgress("canvas", { phase: "conflict" });
    await saveRemoteUserDataNow("canvas");
    expect(remote.get("canvas")!.nodes.map((node) => node.id).sort()).toEqual(["agent-result", "old-image", "target"]);
    expect(useSyncProgressStore.getState().syncingProjects.canvas.phase).toBe("done");
});

test("reopen merges an offline draft using the separately persisted ancestor", async () => {
    useCanvasStore.getState().updateProject("canvas", { nodes: addNode(canvas(), "offline").nodes });
    await flushCanvasStorePersistence();
    remote.set("canvas", { ...addNode(canvas(), "agent-result"), revision: 2 });
    await initializeRemoteUserDataSession(scope);
    const loaded = await loadCanvasProjectForEditing("canvas");
    expect(loaded.nodes.map((node) => node.id).sort()).toEqual(["agent-result", "offline", "old-image"]);
    expect(loaded.revision).toBe(2);
    await saveRemoteUserDataNow("canvas");
    expect(remote.get("canvas")!.nodes).toEqual(loaded.nodes);
    expect(remote.get("canvas")!.revision).toBe(3);
});

test("an old client draft recovers only its exact hash-verified history revision", async () => {
    const base = structuredClone(useCanvasStore.getState().openProject("canvas")!);
    useCanvasStore.getState().updateProject("canvas", { nodes: addNode(canvas(), "offline").nodes });
    await flushCanvasStorePersistence();
    for (const key of indexed.keys()) if (key.includes("sync-baseline:")) indexed.delete(key);
    remote.set("canvas", { ...addNode(canvas(), "agent-result"), revision: 3 });
    await initializeRemoteUserDataSession(scope);
    const adapter = apiClient.defaults.adapter as (config: any) => Promise<any>;
    apiClient.defaults.adapter = async (config) => {
        let data: unknown;
        if (String(config.url).endsWith("/history")) data = { snapshots: [{ id: "ancestor", revision: 1 }] };
        else if (String(config.url).endsWith("/history/ancestor")) data = { project: base };
        else return adapter(config);
        return { config, status: 200, statusText: "", headers: {}, data: { code: 0, data } };
    };
    const loaded = await loadCanvasProjectForEditing("canvas");
    expect(loaded.nodes.map((node) => node.id).sort()).toEqual(["agent-result", "offline", "old-image"]);
    await saveRemoteUserDataNow("canvas");
    expect(remote.get("canvas")!.revision).toBe(4);
});

test("a history entry with the wrong content hash cannot overwrite an offline draft", async () => {
    useCanvasStore.getState().renameProject("canvas", "offline title");
    await flushCanvasStorePersistence();
    for (const key of indexed.keys()) if (key.includes("sync-baseline:")) indexed.delete(key);
    remote.set("canvas", { ...addNode(canvas(), "agent-result"), revision: 3 });
    await initializeRemoteUserDataSession(scope);
    const adapter = apiClient.defaults.adapter as (config: any) => Promise<any>;
    apiClient.defaults.adapter = async (config) => {
        let data: unknown;
        if (String(config.url).endsWith("/history")) data = { snapshots: [{ id: "ancestor", revision: 1 }] };
        else if (String(config.url).endsWith("/history/ancestor")) data = { project: { ...canvas(), title: "unrelated content" } };
        else return adapter(config);
        return { config, status: 200, statusText: "", headers: {}, data: { code: 0, data } };
    };
    expect((await loadCanvasProjectForEditing("canvas")).title).toBe("offline title");
    await expect(saveRemoteUserDataNow("canvas")).rejects.toThrow("云端画布已有更新");
    expect((await readCanvasSyncDrafts("canvas"))[0].project.title).toBe("offline title");
    expect(requests.filter((request) => request.method === "put")).toHaveLength(0);
});

test("server progress on a node merges with a local drag and content edit", async () => {
    const base = useCanvasStore.getState().openProject("canvas")!;
    remote.set("canvas", { ...base, revision: 2, nodes: [{ ...base.nodes[0], metadata: { status: "success" } }] });
    useCanvasStore.getState().updateProject("canvas", { nodes: [{ ...base.nodes[0], position: { x: 222, y: 333 }, title: "local title" }] });
    await saveRemoteUserDataNow("canvas");
    expect(remote.get("canvas")!.nodes[0]).toMatchObject({ position: { x: 222, y: 333 }, title: "local title", metadata: { status: "success" } });
});

test("edits arriving during a rejected PUT survive rebase and the retry", async () => {
    let once = false;
    beforePut = async () => {
        if (once) return;
        once = true;
        remote.set("canvas", { ...addNode(canvas(), "agent-result"), revision: 2 });
        useCanvasStore.getState().renameProject("canvas", "edited during network wait");
    };
    useCanvasStore.getState().updateProject("canvas", { nodes: addNode(canvas(), "target").nodes });
    await saveRemoteUserDataNow("canvas");
    expect(remote.get("canvas")!.title).toBe("edited during network wait");
    expect(remote.get("canvas")!.nodes.map((node) => node.id).sort()).toEqual(["agent-result", "old-image", "target"]);
});

test("continuous remote writes bound CAS retries and retain an unsaved draft", async () => {
    beforePut = async () => {
        const current = remote.get("canvas")!;
        remote.set("canvas", { ...current, revision: current.revision! + 1 });
    };
    useCanvasStore.getState().renameProject("canvas", "must survive contention");
    await expect(saveRemoteUserDataNow("canvas")).rejects.toThrow();
    expect(requests.filter((request) => request.method === "put")).toHaveLength(4);
    expect((await readCanvasSyncDrafts("canvas"))[0].project.title).toBe("must survive contention");
    beforePut = undefined;
    await saveRemoteUserDataNow("canvas");
    expect(remote.get("canvas")!.title).toBe("must survive contention");
});

test("transient cloud failures schedule a bounded automatic retry", async () => {
    temporaryPutFailures = 1;
    useCanvasStore.getState().renameProject("canvas", "retry me");
    expect(autoSave).toBeDefined();

    autoSave?.();
    await waitForSyncState(() => requests.filter((request) => request.method === "put" && request.id === "canvas").length === 1);
    expect(autoSave).toBeDefined();
    expect(useSyncProgressStore.getState().syncingProjects.canvas.message).toContain("自动重试");

    autoSave?.();
    await waitForSyncState(() => remote.get("canvas")?.title === "retry me");
    expect(requests.filter((request) => request.method === "put" && request.id === "canvas")).toHaveLength(2);
    expect(useSyncProgressStore.getState().syncingProjects.canvas.phase).toBe("done");
});

test("edits during a save retain the right ancestor revision and are saved next", async () => {
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
        release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
        started = resolve;
    });
    beforePut = async () => {
        started();
        await waiting;
    };
    useCanvasStore.getState().updateProject("canvas", { nodes: addNode(canvas(), "first-video").nodes });
    const saving = saveRemoteUserDataNow();
    await entered;
    useCanvasStore.getState().updateProject("canvas", { nodes: addNode(useCanvasStore.getState().openProject("canvas")!, "second-video").nodes });
    release();
    await saving;
    expect(requests.filter((request) => request.method === "put").map((request) => request.project!.revision)).toEqual([1, 2]);
    expect(remote.get("canvas")!.revision).toBe(3);
    expect(remote.get("canvas")!.nodes.map((node) => node.id)).toEqual(["old-image", "first-video", "second-video"]);
    expect(useCanvasStore.getState().openProject("canvas")!.remoteContentHash).toBe(await canvasContentHash(useCanvasStore.getState().openProject("canvas")!));
    expect(requests.filter((request) => request.method === "put").every((request) => !("viewport" in request.project!) && !("remoteContentHash" in request.project!))).toBe(true);
});

test("login archives unsynced changes before replacing cache and keeps user scopes separate", async () => {
    useCanvasStore.getState().renameProject("canvas", "unsaved draft");
    await flushCanvasStorePersistence();
    resetRemoteUserDataSync();
    await useCanvasStore.persist.rehydrate();
    await syncRemoteUserData(scope);
    expect(useCanvasStore.getState().openProject("canvas")!.title).toBe("canvas");
    expect((await readCanvasSyncDrafts("canvas"))[0].project.title).toBe("unsaved draft");
    expect(await readCanvasSyncDrafts("canvas", "another-user")).toEqual([]);
    expect(requests.some((request) => request.method === "put")).toBe(false);
});

test("failed draft storage prevents replacement by the latest server content", async () => {
    const working = localforage.setItem;
    useCanvasStore.getState().renameProject("canvas", "must survive");
    localforage.setItem = (async (key: string, value: unknown) => {
        if (key.includes("sync-drafts")) throw new Error("disk full");
        return working(key, value);
    }) as typeof localforage.setItem;
    await expect(loadCanvasProjectForEditing("canvas", { latest: true })).rejects.toThrow("disk full");
    expect(useCanvasStore.getState().openProject("canvas")!.title).toBe("must survive");
});

test("local storage rebase cannot pair old edits with another tab's newer revision", () => {
    const base = canvas();
    const local = addNode(base, "unsaved-local");
    const durable = { ...addNode(base, "remote-video"), revision: 2 };
    const document = parseCanvasStorageDocument(null, [durable]);
    const rebased = rebaseCanvasProjects({ document, baseProjects: [base], localProjects: [local], baseRevision: 0 }).document.state.projects[0];
    expect(rebased.revision).toBe(1);
    expect(rebased.nodes.at(-1)!.id).toBe("unsaved-local");
});

test("server JSON key ordering does not turn unchanged asset bindings into a cross-tab conflict", () => {
    const base = canvas();
    base.nodes[0].metadata = { assetBindings: [{ nodeId: "character", role: "character", priority: 1 }] };
    const local = structuredClone(base);
    local.title = "local title";
    local.nodes[0].metadata!.assetBindings = [{ priority: 1, role: "character", nodeId: "character" }];
    const durable = structuredClone(base);
    durable.nodes[0].metadata!.assetBindings![0].priority = 2;
    const merged = rebaseCanvasProjects({ document: parseCanvasStorageDocument(null, [durable]), baseProjects: [base], localProjects: [local], baseRevision: 0 });
    expect(merged.conflicts).toEqual([]);
    expect(merged.document.state.projects[0].title).toBe("local title");
    expect(merged.document.state.projects[0].nodes[0].metadata!.assetBindings![0].priority).toBe(2);
});

test("loading aligns live editor content before publishing its server revision", async () => {
    remote.set("canvas", { ...addNode(canvas(), "new-cloud-node"), revision: 2 });
    let applied = false;
    await loadCanvasProjectForEditing("canvas", {
        onLoad: (project) => {
            expect(useCanvasStore.getState().openProject("canvas")!.revision).toBe(1);
            expect(project.revision).toBe(2);
            expect(project.nodes.at(-1)!.id).toBe("new-cloud-node");
            applied = true;
        },
    });
    expect(applied).toBe(true);
    expect(useCanvasStore.getState().openProject("canvas")!.revision).toBe(2);
});

test("viewport-only updates during latest load still adopt cloud content", async () => {
    remote.set("canvas", { ...addNode(canvas(), "remote-video"), revision: 2 });
    useCanvasStore.getState().updateProject("canvas", { nodes: addNode(canvas(), "local-video").nodes });
    const working = localforage.setItem;
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
        release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
        started = resolve;
    });
    localforage.setItem = (async (key: string, value: unknown) => {
        if (key.includes("sync-drafts:")) {
            started();
            await waiting;
        }
        return working(key, value);
    }) as typeof localforage.setItem;
    const loading = loadCanvasProjectForEditing("canvas", { latest: true });
    await entered;
    useCanvasStore.getState().updateProject("canvas", { viewport: { x: 40, y: 12, k: 1.5 } });
    release();
    const loaded = await loading;
    expect(loaded.nodes.at(-1)!.id).toBe("remote-video");
    expect(useCanvasStore.getState().openProject("canvas")!.revision).toBe(2);
    expect(useCanvasStore.getState().openProject("canvas")!.viewport).toEqual({ x: 40, y: 12, k: 1.5 });
});

test("edits arriving during draft backup prevent replacement of the live canvas", async () => {
    useCanvasStore.getState().renameProject("canvas", "first local edit");
    const working = localforage.setItem;
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
        release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
        started = resolve;
    });
    localforage.setItem = (async (key: string, value: unknown) => {
        if (key.includes("sync-drafts:")) {
            started();
            await waiting;
        }
        return working(key, value);
    }) as typeof localforage.setItem;
    const loading = loadCanvasProjectForEditing("canvas", { latest: true });
    await entered;
    useCanvasStore.getState().renameProject("canvas", "second local edit");
    release();
    await expect(loading).rejects.toThrow("画布仍在更新");
    expect(useCanvasStore.getState().openProject("canvas")!.title).toBe("second local edit");
});

test("unknown revision cannot borrow the latest revision to submit stale content", async () => {
    const local = useCanvasStore.getState().openProject("canvas")!;
    useCanvasStore.setState((state) => ({ projects: state.projects.map((project) => (project.id === local.id ? { ...local, revision: undefined, title: "legacy draft" } : project)) }));
    await expect(saveRemoteUserDataNow()).rejects.toThrow("缺少画布版本");
    expect(requests.filter((request) => request.method === "put")).toHaveLength(0);
    expect(useSyncProgressStore.getState().syncingProjects.canvas.phase).toBe("conflict");
    expect((await readCanvasSyncDrafts("canvas"))[0].project.title).toBe("legacy draft");
});

test("HTTP environments without Web Crypto still distinguish unsaved content", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
    try {
        const baseline = await canvasContentHash(canvas());
        expect(baseline).toBe(await canvasContentHash({ ...canvas(), viewport: { x: 100, y: 0, k: 2 } }));
        expect(baseline).not.toBe(await canvasContentHash(addNode(canvas(), "new-video")));
    } finally {
        Object.defineProperty(globalThis, "crypto", descriptor);
    }
});

test("history restore preserves the draft and installs a new revision without an extra content PUT", async () => {
    useCanvasStore.getState().updateProject("canvas", { nodes: addNode(canvas(), "unsaved-video").nodes });
    let applied = false;
    const restored = await loadCanvasProjectForEditing("canvas", {
        historyRestore: { snapshotId: "historical", revision: 1 },
        onLoad: (project) => {
            expect(useCanvasStore.getState().openProject("canvas")!.revision).toBe(1);
            expect(project.revision).toBe(2);
            applied = true;
        },
    });
    expect(applied).toBe(true);
    expect(restored.title).toBe("historical content");
    expect((await readCanvasSyncDrafts("canvas")).some((draft) => draft.project.nodes.some((node) => node.id === "unsaved-video"))).toBe(true);
    await saveRemoteUserDataNow("canvas");
    expect(requests.filter((request) => request.method === "post")).toHaveLength(1);
    expect(requests.filter((request) => request.method === "put")).toHaveLength(0);
});

test("a stale history restore preserves both current cloud content and local edits", async () => {
    remote.set("canvas", { ...addNode(canvas(), "new-cloud-video"), revision: 2 });
    useCanvasStore.getState().renameProject("canvas", "local draft");
    await expect(loadCanvasProjectForEditing("canvas", { historyRestore: { snapshotId: "historical", revision: 1 } })).rejects.toThrow("版本冲突");
    expect(remote.get("canvas")!.nodes.at(-1)!.id).toBe("new-cloud-video");
    expect(useCanvasStore.getState().openProject("canvas")!.title).toBe("local draft");
    expect((await readCanvasSyncDrafts("canvas"))[0].project.title).toBe("local draft");
});

test("reopened dirty cache with the same ancestor stays pending until actually saved", async () => {
    useCanvasStore.getState().renameProject("canvas", "offline draft");
    await flushCanvasStorePersistence();
    await initializeRemoteUserDataSession(scope);
    const loaded = await loadCanvasProjectForEditing("canvas");
    expect(loaded.title).toBe("offline draft");
    expect(useSyncProgressStore.getState().syncingProjects.canvas.phase).toBe("pending");
    expect(remote.get("canvas")!.title).toBe("canvas");
    await saveRemoteUserDataNow("canvas");
    expect(remote.get("canvas")!.title).toBe("offline draft");
    expect(remote.get("canvas")!.revision).toBe(2);
});

test("failed draft backup prevents a history restore request", async () => {
    const working = localforage.setItem;
    localforage.setItem = (async (key: string, value: unknown) => {
        if (key.includes("sync-drafts:")) throw new Error("disk full");
        return working(key, value);
    }) as typeof localforage.setItem;
    await expect(loadCanvasProjectForEditing("canvas", { historyRestore: { snapshotId: "historical", revision: 1 } })).rejects.toThrow("disk full");
    expect(requests.some((request) => request.method === "post")).toBe(false);
    expect(remote.get("canvas")!.revision).toBe(1);
});
