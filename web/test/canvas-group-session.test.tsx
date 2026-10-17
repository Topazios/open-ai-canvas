import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { groupExecutionRows, groupMemberState, groupSessionMembers, groupSessionOwner, groupSessionTargets, type GroupSessionSnapshot } from "../src/lib/canvas/canvas-group-session";
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

test("group detail renders one journal without per-child execution-record buttons", () => {
    const html = renderToStaticMarkup(<CanvasGroupTaskDetails node={group} nodes={[group, node("one", group.id), node("two", group.id)]} submitting={false} onResume={() => {}} onRetry={() => {}} onCancel={() => {}} agentState={{ runs: [], nodeErrors: {}, readErrors: {}, syncError: "", busy: {}, control: async () => {}, refresh: () => {} }} />);
    expect(html.match(/aria-label="逐次执行记录"/g)).toHaveLength(1);
    expect(html).toContain("2 个节点");
    expect(html).toContain("全部节点");
    expect(html).not.toContain(">执行记录</button>");
});
