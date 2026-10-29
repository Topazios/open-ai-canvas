import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { groupExecutionRows, groupMemberState, groupSessionMembers, groupSessionOwner, nodeDetailsTarget, groupSessionTargets, groupSessionHasEarlier, type GroupSessionSnapshot } from "../src/lib/canvas/canvas-group-session";
import { CanvasGroupTaskDetails } from "../src/pages/canvas/canvas-group-task-details";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

const node = (id: string, parentId?: string, taskId?: string) => ({ id, title: id, type: CanvasNodeType.Text, parentId, metadata: { taskId }, position: { x: 0, y: 0 }, width: 400, height: 280 }) as CanvasNodeData;
const group = { ...node("group"), type: CanvasNodeType.Frame };

test("all member entries resolve to one owning group and never include another group", () => {
    const nodes = [group, node("one", group.id, "task"), node("two", group.id, "task"), node("other", "elsewhere", "other-task")];
    expect(groupSessionOwner(nodes[1], nodes)).toBe(group);
    expect(groupSessionMembers(group, nodes).map(node => node.id)).toEqual(["one", "two"]);
    expect(groupSessionTargets(groupSessionMembers(group, nodes))).toHaveLength(1);
    const nested = { ...group, id: "nested", parentId: group.id };
    expect(groupSessionOwner(nested, [...nodes, nested])).toBe(nested);
});

test("a node with its own task opens its own details while task-less members open the group", () => {
    const own = node("own", group.id, "task-own");
    const plain = node("plain", group.id);
    const nodes = [group, own, plain];
    expect(nodeDetailsTarget(own, nodes)).toBe(own);
    expect(nodeDetailsTarget(plain, nodes)).toBe(group);
    expect(nodeDetailsTarget(group, nodes)).toBe(group);
});

test("asset groups show only their own records from the shared production agent", () => {
    const member = node("人物甲", group.id);
    const other = node("其他组人物", "other-group");
    const run = { id: "shared", events: [
        { seq: 1, runId: "shared", type: "production_progress", createdAt: "2026-10-17T10:00:00Z", payload: { nodeId: member.id, text: "已保存人物甲" } },
        { seq: 2, runId: "shared", type: "production_progress", createdAt: "2026-10-17T11:00:00Z", payload: { nodeId: other.id, text: "已保存其他组人物" } },
    ] };
    const rows = groupExecutionRows([member], { "agent:shared": { kind: "agent", run: run as any } }, "asc", [{ key: "agent:shared", kind: "agent", id: "shared", nodeId: "manifest", scoped: true }]);
    expect(rows).toHaveLength(1);
    expect(rows[0].nodeId).toBe(member.id);
    expect(rows[0].title).toBe("已保存人物甲");
});

test("journal combines chronological records with unique ids and source labels", () => {
    const members = [node("one", group.id, "a"), node("two", group.id, "b")];
    const snapshot = (id: string, createdAt: string): GroupSessionSnapshot => ({ kind: "task", detail: { task: { id, createdAt, status: "queued", updatedAt: createdAt } as any, steps: [], events: [], unitCount: 0, truncated: false, parameters: {} } });
    const rows = groupExecutionRows(members, { "task:a": snapshot("a", "2026-10-17T10:00:00Z"), "task:b": snapshot("b", "2026-10-17T11:00:00Z"), "task:c": snapshot("c", "2026-10-17T12:00:00Z") }, "desc");
    expect(rows.map(row => row.source)).toEqual(["two", "one"]);
    expect(new Set(rows.map(row => row.id)).size).toBe(rows.length);
    expect(groupExecutionRows(members, { "task:a": snapshot("a", "2026-10-17T10:00:00Z"), "task:b": snapshot("b", "2026-10-17T11:00:00Z") }, "asc")[0].source).toBe("one");
});

test("streaming drafts are not reported completed and planned failures stay visible", () => {
    expect(groupMemberState({ ...node("a"), metadata: { status: "loading", content: "未完成草稿" } })).toBe("执行中");
    expect(groupMemberState({ ...node("a"), metadata: { status: "error" } })).toBe("执行失败");
});

test("retained content on a warning node stays pending until a current receipt proves recovery", () => {
    const retained: CanvasNodeData = { ...node("a"), metadata: { status: "idle", content: "保留的原稿", generationWarning: { severity: "warning", message: "待补齐" } } };
    expect(groupMemberState(retained)).toBe("内容待处理");
    for (const [taskStatus, label] of [["running", "执行中"], ["queued", "排队中"], ["succeeded", "已完成"], ["cancelled", "已取消"]] as const) {
        expect(groupMemberState({ ...retained, metadata: { ...retained.metadata, taskStatus } })).toBe(label);
    }
    for (const [status, label] of [["completed", "已完成"], ["running", "执行中"], ["cancelled", "已取消"], ["failed", "执行失败"]]) {
        expect(groupMemberState(retained, { kind: "agent", run: { id: "current", status } as any })).toBe(label);
    }
});

test("group counts and rows retain structured warning semantics without marking outputs complete", () => {
    const member = node("a", group.id, "task");
    const task: GroupSessionSnapshot = { kind: "task", detail: { task: { id: "task", status: "failed", diagnostic: { severity: "warning", errorSource: "content", outcome: "not_saved" }, createdAt: "2026-10-25", updatedAt: "2026-10-25" } as any, steps: [], events: [], unitCount: 0, truncated: false, parameters: {} } };
    expect(groupMemberState(member, task)).toBe("内容待处理");
    const event = (seq: number, runId: string, severity: string) => ({ seq, eventId: `${runId}-${seq}`, runId, type: "run_failed", payload: { severity, text: "内容未完整保存" }, createdAt: "2026-10-25" });
    const agent: GroupSessionSnapshot = { kind: "agent", run: { id: "run", status: "failed", events: [event(8, "other", "error"), event(2, "run", "warning"), event(1, "run", "error")] } as any };
    expect(groupMemberState(member, agent)).toBe("内容待处理");
    expect(groupExecutionRows([member], { "task:task": task }, "asc").find(row => String(row.id).endsWith("terminal"))).toMatchObject({ warning: true, failed: false });
});

test("group detail renders one journal without per-child execution-record buttons", () => {
    const html = renderToStaticMarkup(<CanvasGroupTaskDetails node={group} nodes={[group, node("one", group.id), node("two", group.id)]} submitting={false} onResume={() => {}} onRetry={() => {}} onCancel={() => {}} agentState={{ runs: [], nodeErrors: {}, readErrors: {}, syncError: "", busy: {}, control: async () => {}, refresh: () => {} }} />);
    expect(html.match(/aria-label="逐次执行记录"/g)).toHaveLength(1);
    expect(html).toContain("2 个节点");
    expect(html).toContain("全部节点");
    expect(html).not.toContain(">执行记录</button>");
});

test("plan task details do not expand the asset checklist", () => {
    const manifest = { ...node("manifest", group.id), metadata: { shortDrama: { pipelineId: "pipeline", assetKey: "$summary", productionAgent: { runId: "run" } } } } as CanvasNodeData;
    const plan = { ...group, metadata: { shortDrama: { pipelineId: "pipeline", role: "collection", step: "story.plan", sourceNodeIds: [manifest.id], assetGroup: { manifestId: manifest.id } } } } as CanvasNodeData;
    const run = { id: "run", canvasId: "canvas", status: "completed", permissionMode: "auto", createdAt: "2026-10-24", updatedAt: "2026-10-24", production: { targetNodeId: manifest.id, workKind: "plan", planReady: true, assets: [{ key: "character", code: "CHR-1", name: "角色", kind: "character", status: "pending", missingDependencies: [] }] } } as any;
    const html = renderToStaticMarkup(<CanvasGroupTaskDetails node={plan} nodes={[plan, manifest]} submitting={false} onResume={() => {}} onRetry={() => {}} onCancel={() => {}} agentState={{ runs: [run], nodeErrors: {}, readErrors: {}, syncError: "", busy: {}, control: async () => {}, refresh: () => {} }} />);
    expect(html).not.toContain("资产清单");
    expect(html).not.toContain("选择 角色");
});

function coordinatorFixture() {
    const manifest = { ...node("manifest", group.id), metadata: { shortDrama: { pipelineId: "pipeline", assetKey: "$summary", productionAgent: { runId: "run" } } } } as CanvasNodeData;
    const owner = { ...group, metadata: { shortDrama: { pipelineId: "pipeline", role: "collection", sourceNodeIds: [manifest.id], assetGroup: { manifestId: manifest.id } } } } as CanvasNodeData;
    const targets = groupSessionTargets([manifest], owner, [owner, manifest]);
    return { owner, manifest, targets };
}

test("owning group shows model dispatch and commentary before any artifact exists", () => {
    const { manifest, targets } = coordinatorFixture();
    expect(targets[0]).toMatchObject({ scoped: true, coordinator: true });
    const snapshots: Record<string, GroupSessionSnapshot> = { "agent:run": { kind: "agent", run: { id: "run", status: "running", events: [
        { seq: 1, runId: "run", type: "assistant_message", createdAt: "2026-10-18T00:00:00Z", payload: { text: "开始核对第1集正文" } },
        { seq: 2, runId: "run", type: "production_model_started", createdAt: "2026-10-18T00:00:01Z", payload: { taskId: "task", step: 1 } },
        { seq: 3, runId: "run", type: "tool_failed", createdAt: "2026-10-18T00:00:02Z", payload: { toolName: "production_facts", text: "证据不符" } },
        { seq: 4, runId: "run", type: "reasoning_message", createdAt: "2026-10-18T00:00:03Z", payload: { text: "private reasoning" } },
    ] } as any } };
    const rows = groupExecutionRows([manifest], snapshots, "asc", targets);
    expect(rows.map(row => row.kind)).toEqual(["message", "model", "tool"]);
    expect(rows[1].pending).toBe(true);
    expect(rows[2].failed).toBe(true);
    expect(rows[0].detail).toBe("开始核对第1集正文");
    expect(JSON.stringify(rows)).not.toContain("private reasoning");
});

test("owning group keeps member attribution and ignores unrelated run events", () => {
    const { manifest, targets } = coordinatorFixture();
    const member = node("saved-asset", group.id);
    const snapshots: Record<string, GroupSessionSnapshot> = { "agent:run": { kind: "agent", run: { id: "run", events: [
        { seq: 1, runId: "run", type: "production_progress", createdAt: "2026-10-18T00:00:01Z", payload: { nodeId: member.id, text: "已保存资产" } },
        { seq: 2, runId: "other", type: "run_failed", createdAt: "2026-10-18T00:00:02Z", payload: { text: "other-run-error" } },
    ] } as any } };
    const rows = groupExecutionRows([manifest, member], snapshots, "asc", targets);
    expect(rows).toHaveLength(1);
    expect(rows[0].nodeId).toBe(member.id);
    expect(rows[0].source).toBe(member.title);
});

test("derived shared group does not inherit coordinator calls or failures", () => {
    const { manifest, owner } = coordinatorFixture();
    const derived = { ...owner, id: "derived" };
    const member = node("saved-asset", derived.id);
    const targets = groupSessionTargets([member], derived, [owner, manifest, derived, member]);
    expect(targets[0].coordinator).toBe(false);
    const snapshots: Record<string, GroupSessionSnapshot> = { "agent:run": { kind: "agent", run: { id: "run", events: [
        { seq: 1, runId: "run", type: "production_model_started", createdAt: "2026-10-18T00:00:01Z", payload: { taskId: "unrelated-call" } },
        { seq: 2, runId: "run", type: "run_failed", createdAt: "2026-10-18T00:00:02Z", payload: { text: "coordinator-error" } },
        { seq: 3, runId: "run", type: "production_progress", createdAt: "2026-10-18T00:00:03Z", payload: { nodeId: member.id, text: "已保存本组资产" } },
    ] } as any } };
    const rows = groupExecutionRows([member], snapshots, "asc", targets);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("已保存本组资产");
});

test("earlier history is offered only when an unread older page exists", () => {
    const { targets } = coordinatorFixture();
    const snapshot = (seq: number): Record<string, GroupSessionSnapshot> => ({ "agent:run": { kind: "agent", run: { id: "run", events: seq ? [{ seq }] : [] } as any } });
    expect(groupSessionHasEarlier(targets, {})).toBe(false);
    expect(groupSessionHasEarlier(targets, snapshot(0))).toBe(false);
    expect(groupSessionHasEarlier(targets, snapshot(1))).toBe(false);
    expect(groupSessionHasEarlier(targets, snapshot(30))).toBe(true);
    expect(groupSessionHasEarlier([], snapshot(30))).toBe(false);
});

test("coordinator control errors stay visible before first artifact", () => {
    const { manifest, owner } = coordinatorFixture();
    const html = renderToStaticMarkup(<CanvasGroupTaskDetails node={owner} nodes={[owner, manifest]} submitting={false} onResume={() => {}} onRetry={() => {}} onCancel={() => {}} agentState={{ runs: [], nodeErrors: { [manifest.id]: "暂停操作未成功" }, readErrors: {}, syncError: "", busy: {}, control: async () => {}, refresh: () => {} }} />);
    expect(html).toContain("0 个节点");
    expect(html).toContain("暂停操作未成功");
    expect(html).not.toContain("读取更早记录");
});
