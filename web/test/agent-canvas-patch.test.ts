import { expect, test } from "bun:test";
import { applyAgentCanvasPatch, mergeCanvasSnapshot, mergeAgentCanvasEditor, recoverCompletedProductionDocuments, type AgentCanvasPatch } from "@/lib/canvas/agent-canvas-patch";
import { isCanvasNodeGenerating } from "@/lib/canvas/canvas-node-task-state";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const node: CanvasNodeData = { id: "video-1", title: "满月动画", type: CanvasNodeType.Video, position: { x: 10, y: 20 }, width: 320, height: 180, metadata: { status: "loading", taskId: "task-1", taskStatus: "running", prompt: "原始提示词" } };
const project: CanvasProject = { id: "canvas", title: "画布", nodes: [node], connections: [], chatSessions: [], activeChatId: null, viewport: { x: 12, y: 24, k: 1 }, createdAt: "2026-09-13", updatedAt: "2026-09-13" };
const failed: CanvasNodeData = { ...node, metadata: { ...node.metadata, status: "error", taskStatus: "failed", errorDetails: "上游拒绝" } };
const patch: AgentCanvasPatch = { canvasId: project.id, updatedAt: "2026-09-13T12:00:00Z", nodes: [{ before: node, after: failed }], connections: [] };

const productionNode: CanvasNodeData = { ...node, id: "plan", type: CanvasNodeType.Text, metadata: {
    status: "loading", taskStage: "正在提交制作 Agent", prompt: "original prompt",
    shortDrama: { stage: "story", step: "story.plan", pipelineId: "pipeline", sourceNodeIds: [], sourceSignatures: {}, role: "document", submission: "submitting", productionAgent: {} },
} };
const bindRun = (node: CanvasNodeData, runId = "run-1"): CanvasNodeData => ({ ...node, metadata: { ...node.metadata,
    shortDrama: { ...node.metadata!.shortDrama!, submission: "submitted", productionAgent: { runId } },
} });

test("production receipt and checkpoint progress cannot block new document nodes", () => {
    const local = bindRun({ ...productionNode, metadata: { ...productionNode.metadata, taskStage: "已排队等待制作 Agent", prompt: "local prompt" } });
    const incoming = bindRun({ ...productionNode, metadata: { ...productionNode.metadata, taskStage: "制作 Agent 正在执行" } });
    const document = { ...productionNode, id: "story", metadata: { status: "success" as const, content: "generated story" } };
    const baseline = { ...project, nodes: [productionNode] };
    const merged = mergeAgentCanvasEditor(baseline, { ...baseline, nodes: [incoming, document] }, [local], []);
    expect(merged.nodes.map((node) => node.id)).toEqual(["plan", "story"]);
    expect(merged.nodes[0].metadata).toMatchObject({ taskStage: "制作 Agent 正在执行", prompt: "local prompt" });
});

test("late production checkpoints preserve locally known terminal state and still deliver documents", () => {
    const before = bindRun(productionNode);
    const current = { ...before, metadata: { ...before.metadata, status: "error" as const, taskStage: "制作 Agent 已停止", errorDetails: "HTTP 503",
        shortDrama: { ...before.metadata!.shortDrama!, submission: "rejected" as const } } };
    const after = { ...before, metadata: { ...before.metadata, taskStage: "写入文稿" } };
    const document = { ...productionNode, id: "inventory", metadata: { content: "generated inventory" } };
    const merged = applyAgentCanvasPatch({ ...project, nodes: [current] }, { ...patch, nodes: [{ before, after }, { before: null, after: document }] });
    expect(merged.nodes).toHaveLength(2);
    expect(merged.nodes[0].metadata).toMatchObject({ status: "error", taskStage: "制作 Agent 已停止", errorDetails: "HTTP 503", shortDrama: { submission: "rejected" } });
});

test("production terminal receipts merge while newer run bindings and content remain protected", () => {
    const before = bindRun(productionNode);
    const local = { ...before, metadata: { ...before.metadata, taskStage: "本地进度" } };
    const after = { ...before, metadata: { ...before.metadata, status: "error" as const, taskStage: "已停止", errorDetails: "model failed" } };
    const delta = { ...patch, nodes: [{ before, after }] };
    expect(applyAgentCanvasPatch({ ...project, nodes: [local] }, delta).nodes[0].metadata?.status).toBe("error");
    expect(() => applyAgentCanvasPatch({ ...project, nodes: [bindRun(local, "run-2")] }, delta)).toThrow("冲突");
    expect(() => applyAgentCanvasPatch({ ...project, nodes: [{ ...local, metadata: { ...local.metadata, content: "local edit" } }] }, {
        ...delta, nodes: [{ before, after: { ...after, metadata: { ...after.metadata, content: "remote edit" } } }],
    })).toThrow("冲突");
});

test("an authoritative resume of the same run can replace an acknowledged failure", () => {
    const before = bindRun({ ...productionNode, metadata: { ...productionNode.metadata, status: "error", taskStage: "已停止" } });
    const after = bindRun(productionNode);
    expect(applyAgentCanvasPatch({ ...project, nodes: [before] }, { ...patch, nodes: [{ before, after }] }).nodes[0].metadata?.status).toBe("loading");
});

test("failed Agent task patches only its node and unlocks generation", () => {
    expect(isCanvasNodeGenerating(node)).toBe(true);
    const result = applyAgentCanvasPatch(project, patch);
    expect(result.nodes[0]).toEqual(failed);
    expect(isCanvasNodeGenerating(result.nodes[0])).toBe(false);
    expect(result.viewport).toBe(project.viewport);
    expect(result.connections).toBe(project.connections);
    expect(project.nodes[0].metadata?.status).toBe("loading");
});

test("unrelated local edits and editor-only dragging survive completion", () => {
    const local = { ...node, position: { x: 800, y: 400 }, metadata: { ...node.metadata, prompt: "正在编辑的新提示词" } };
    const merged = mergeAgentCanvasEditor(project, applyAgentCanvasPatch(project, patch), [local], []);
    expect(merged.nodes[0].position).toEqual(local.position);
    expect(merged.nodes[0].metadata?.prompt).toBe("正在编辑的新提示词");
    expect(merged.nodes[0].metadata?.status).toBe("error");
});

test("replay is idempotent and cannot roll a completed node back to loading", () => {
    const result = applyAgentCanvasPatch(project, patch);
    expect(applyAgentCanvasPatch(result, patch)).toBe(result);
    const old: AgentCanvasPatch = { ...patch, nodes: [{ before: { ...node, metadata: { status: "idle" } }, after: node }] };
    expect(() => applyAgentCanvasPatch(result, old)).toThrow("冲突");
    expect(result.nodes[0].metadata?.status).toBe("error");
});

test("new nodes and reference connections are applied atomically", () => {
    const draft = { ...node, id: "video-2", metadata: { status: "idle" as const } };
    const edge = { id: "edge", fromNodeId: node.id, toNodeId: draft.id };
    const result = applyAgentCanvasPatch(project, { ...patch, nodes: [{ before: null, after: draft }], connections: [{ before: null, after: edge }] });
    expect(result.nodes[0]).toBe(node);
    expect(result.nodes[1]).toEqual(draft);
    expect(result.connections).toEqual([edge]);
});

test("deleted nodes and a newer task binding are not overwritten", () => {
    expect(() => applyAgentCanvasPatch({ ...project, nodes: [] }, patch)).toThrow("冲突");
    // A replacement task can have the same running status; its task identity is a fence.
    const replacement = { ...node, metadata: { ...node.metadata, taskId: "task-2" } };
    expect(() => applyAgentCanvasPatch({ ...project, nodes: [replacement] }, patch)).toThrow();
});

test("task state covers Agent, manual submissions and historical terminal tasks", () => {
    for (const status of ["queued", "running"]) expect(isCanvasNodeGenerating({ ...node, metadata: { status: "idle", taskId: "task", taskStatus: status } })).toBe(true);
    for (const status of ["succeeded", "failed", "cancelled"]) expect(isCanvasNodeGenerating({ ...node, metadata: { status: "loading", taskId: "old", taskStatus: status } })).toBe(false);
    expect(isCanvasNodeGenerating({ ...node, metadata: { status: "loading" } })).toBe(true);
    expect(isCanvasNodeGenerating({ ...node, metadata: { status: "success", taskId: "historical" } })).toBe(false);
    expect(isCanvasNodeGenerating({ ...node, metadata: { status: "idle" } }, node.id)).toBe(true);
});


test("task progress ahead of the server checkpoint still accepts terminal state", () => {
    const queued = { ...node, metadata: { ...node.metadata, taskStatus: "queued", taskProgress: 0 } };
    const running = { ...node, metadata: { ...node.metadata, taskProgress: 67 } };
    const result = applyAgentCanvasPatch({ ...project, nodes: [running] }, { ...patch, nodes: [{ before: queued, after: failed }] });
    expect(result.nodes[0].metadata?.taskStatus).toBe("failed");
    expect(isCanvasNodeGenerating(result.nodes[0])).toBe(false);
});

test("full Agent refresh removes unchanged nodes but preserves conflicting local edits", () => {
    const remaining = { ...node, id: "remaining", metadata: {} };
    const previous = { ...project, nodes: [node, remaining] };
    const incoming = { ...previous, nodes: [remaining] };
    expect(mergeAgentCanvasEditor(previous, incoming, previous.nodes, []).nodes).toEqual([remaining]);
    const local = { ...node, title: "Unsaved local title" };
    expect(() => mergeAgentCanvasEditor(previous, incoming, [local, remaining], [])).toThrow("冲突");
    expect(local.title).toBe("Unsaved local title");
});

test("deleting a container prevents its late new children and edges from entering the merged canvas", () => {
    const frame = { ...node, id: "frame", type: CanvasNodeType.Frame };
    const before = { ...project, revision: 1, nodes: [frame, { ...node, parentId: frame.id }] };
    const incoming = { ...before, revision: 2, nodes: [...before.nodes, { ...node, id: "late-child", parentId: frame.id }], connections: [{ id: "edge", fromNodeId: node.id, toNodeId: "late-child" }] };
    const current = { ...before, nodes: [{ ...node, parentId: undefined }] };
    const merged = mergeCanvasSnapshot(before, current, incoming);
    expect(merged.nodes).toEqual(current.nodes);
    expect(merged.connections).toEqual([]);
    expect(merged.revision).toBe(2);
});

test("new metadata fields merge independently but the same content field still conflicts", () => {
    const before = { ...project, nodes: [{ ...node, metadata: undefined }] };
    const current = { ...before, nodes: [{ ...node, metadata: { prompt: "local prompt" } }] };
    const incoming = { ...before, nodes: [{ ...node, metadata: { status: "success" as const } }] };
    expect(mergeCanvasSnapshot(before, current, incoming).nodes[0].metadata).toEqual({ prompt: "local prompt", status: "success" });
    expect(() => mergeCanvasSnapshot(before, current, { ...incoming, nodes: [{ ...node, metadata: { prompt: "remote prompt" } }] })).toThrow("冲突");
});

test("snapshot reconciliation cannot apply old task results to a rebound node", () => {
    const current = { ...project, nodes: [{ ...node, metadata: { ...node.metadata, taskId: "replacement" } }] };
    expect(() => mergeCanvasSnapshot(project, current, { ...project, nodes: [failed] })).toThrow("冲突");
});

test("recovery imports completed plan documents from stale journal patches and preserves local edits", () => {
    const frame: CanvasNodeData = { id: "plan-frame", type: CanvasNodeType.Frame, title: "制作方案", position: { x: 100, y: 100 }, width: 1200, height: 600,
        metadata: { shortDrama: { stage: "story", step: "story.plan", role: "collection", sourceNodeIds: ["summary"], sourceSignatures: {}, planReady: false } } };
    const summary: CanvasNodeData = { ...productionNode, id: "summary", parentId: frame.id, title: "故事总结与世界规则 · 第 5 版",
        metadata: { status: "success", content: "summary", shortDrama: { ...productionNode.metadata!.shortDrama!, role: "collection", sourceNodeIds: [] } } };
    const existing: CanvasNodeData = { ...node, id: "local-note", title: "本地笔记" };
    const document: CanvasNodeData = { id: "inventory-doc", parentId: frame.id, title: "资产总表与编码", type: CanvasNodeType.Text,
        position: { x: 124, y: 220 }, width: 400, height: 280,
        metadata: { status: "success", content: "完整资产清单", shortDrama: { stage: "story", step: "story.plan", role: "document", planSection: "inventory", sourceNodeIds: [] } } };
    const parentAfter: CanvasNodeData = { ...frame, metadata: { ...frame.metadata, shortDrama: { ...frame.metadata!.shortDrama!, sourceNodeIds: ["summary", document.id], planReady: true } } };
    const stalePatch: AgentCanvasPatch = { canvasId: project.id, baseRevision: 2, revision: 3, updatedAt: "2026-09-13T12:00:00Z",
        nodes: [{ before: null, after: document }, { before: frame, after: parentAfter }], connections: [] };
    const current = { ...project, nodes: [frame, summary, existing] };
    const recovered = recoverCompletedProductionDocuments(current, [stalePatch]);
    expect(recovered.nodes.map((entry) => entry.id)).toEqual([frame.id, summary.id, existing.id, document.id]);
    expect(recovered.nodes.find((entry) => entry.id === frame.id)?.metadata?.shortDrama).toMatchObject({ sourceNodeIds: ["summary", document.id], planReady: true });
    expect(recovered.nodes.find((entry) => entry.id === existing.id)).toEqual(existing);
    expect(recoverCompletedProductionDocuments(recovered, [stalePatch])).toBe(recovered);
});

test("recovery skips completed documents whose original container was removed", () => {
    const document: CanvasNodeData = { id: "orphan-doc", parentId: "deleted-frame", title: "规范", type: CanvasNodeType.Text, position: { x: 0, y: 0 }, width: 400, height: 280,
        metadata: { status: "success", content: "完整规范", shortDrama: { stage: "story", step: "story.plan", role: "document", planSection: "visual", sourceNodeIds: [] } } };
    const stalePatch: AgentCanvasPatch = { canvasId: project.id, baseRevision: 2, revision: 3, updatedAt: "2026-09-13T12:00:00Z", nodes: [{ before: null, after: document }], connections: [] };
    expect(recoverCompletedProductionDocuments(project, [stalePatch])).toBe(project);
});
