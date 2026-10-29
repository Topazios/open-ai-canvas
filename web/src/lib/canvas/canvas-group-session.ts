import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { taskExecutionRows, type ExecutionJournalRow } from "@/lib/task-execution-journal";
import { productionJournalRows, productionRunExternalFailure } from "./production-agent-journal";
import { canvasNodeWarning, executionTaskWarning } from "../execution-warning";
import type { TaskExecutionDetails } from "@/services/api/task-center";
import type { AgentRun } from "@/services/api/agent";

export function groupSessionOwner(node: CanvasNodeData | null, nodes: CanvasNodeData[]) {
    if (!node) return null;
    if (node.type === CanvasNodeType.Frame) return node;
    const parent = nodes.find(entry => entry.id === node.parentId && entry.type === CanvasNodeType.Frame);
    return parent || node;
}

// A node that owns a generation task shows its own generation details.
// Other members (planned items, production agent outputs) resolve to the group.
export function nodeDetailsTarget(node: CanvasNodeData | null, nodes: CanvasNodeData[]) {
    if (node && node.type !== CanvasNodeType.Frame && node.metadata?.taskId && !node.metadata.shortDrama?.productionAgent?.runId) return node;
    return groupSessionOwner(node, nodes);
}

export function groupSessionMembers(group: CanvasNodeData, nodes: CanvasNodeData[]) {
    const ids = new Set(group.metadata?.shortDrama?.role === "collection" ? group.metadata.shortDrama.sourceNodeIds : []);
    return nodes.filter(node => node.id !== group.id && node.type !== CanvasNodeType.Frame &&
        (node.parentId === group.id || (!node.parentId && ids.has(node.id))));
}

export type GroupSessionTarget = { key: string; id: string; kind: "task" | "agent"; nodeId: string; scoped?: boolean; coordinator?: boolean };
export type GroupSessionSnapshot = { kind: "task"; detail: TaskExecutionDetails } | { kind: "agent"; run: AgentRun };

export function groupSessionTargets(members: CanvasNodeData[], group?: CanvasNodeData, nodes: CanvasNodeData[] = members) {
    const targets = new Map<string, GroupSessionTarget>();
    for (const node of members) {
        const runId = node.metadata?.shortDrama?.productionAgent?.runId;
        const id = runId || node.metadata?.taskId;
        if (!id) continue;
        const kind = runId ? "agent" : "task";
        const key = `${kind}:${id}`;
        if (!targets.has(key)) targets.set(key, { key, id, kind, nodeId: node.id });
    }
    const manifestId = group?.metadata?.shortDrama?.assetGroup?.manifestId;
    const manifest = nodes.find(node => node.id === manifestId);
    const runId = manifest?.metadata?.shortDrama?.productionAgent?.runId;
    if (manifest && runId && manifest.metadata?.shortDrama?.pipelineId === group?.metadata?.shortDrama?.pipelineId) {
        targets.set(`agent:${runId}`, { key: `agent:${runId}`, id: runId, kind: "agent", nodeId: manifest.id, scoped: true, coordinator: manifest.parentId === group?.id });
    }
    return [...targets.values()];
}

export function groupMemberState(node: CanvasNodeData, snapshot?: GroupSessionSnapshot) {
    if (snapshot?.kind === "task" && executionTaskWarning(snapshot.detail.task.status, snapshot.detail.task.diagnostic)) return "内容待处理";
    const status = snapshot?.kind === "task" ? snapshot.detail.task.status : snapshot?.kind === "agent" ? snapshot.run.status : node.metadata?.taskStatus;
    if (!snapshot && !node.metadata?.shortDrama?.productionAgent?.runId && !["queued", "running", "succeeded", "completed", "cancelled"].includes(status || "") && canvasNodeWarning(node.metadata)) return "内容待处理";
    if (status === "succeeded" || status === "completed") return "已完成";
    if (snapshot?.kind === "agent" && ["failed", "rejected"].includes(status || "")) return productionRunExternalFailure(snapshot.run.events, snapshot.run.id) ? "执行失败" : "已暂停";
    if (status === "failed" || status === "rejected") return "执行失败";
    if (status === "cancelled") return "已取消";
    if (snapshot?.kind === "agent" && status === "waiting_user") return "已暂停";
    if (snapshot?.kind === "agent" && snapshot.run.production?.paused) return "已暂停";
    if (status === "running") return "执行中";
    if (status === "queued") return "排队中";
    if (node.metadata?.status === "error") return "执行失败";
    if (node.metadata?.shortDrama?.submission === "planned") return "待提交";
    if (node.metadata?.status === "loading") return "执行中";
    if (node.metadata?.status === "success" || node.metadata?.content?.trim()) return "已完成";
    return "待提交";
}

export function groupExecutionRows(members: CanvasNodeData[], snapshots: Record<string, GroupSessionSnapshot>, order: "asc" | "desc", targets = groupSessionTargets(members)) {
    const byNode = new Map(members.map(node => [node.id, node]));
    const rows: ExecutionJournalRow[] = [];
    for (const target of targets) {
        const snapshot = snapshots[target.key];
        if (!snapshot) continue;
        const eventMembers = new Map<number, CanvasNodeData>();
        const events = snapshot.kind === "agent" ? (snapshot.run.events || []).filter(event => {
            if (event.runId !== target.id) return false;
            if (!target.scoped) return true;
            const payload = event.payload;
            const result = payload.result as Record<string, unknown> | undefined;
            const member = members.find(node => node.id === payload.nodeId || node.id === result?.nodeId ||
                [node.title, node.metadata?.shortDrama?.planAsset?.name, node.metadata?.shortDrama?.assetIdentity?.code].some(name => name && name === payload.itemName));
            if (member) eventMembers.set(event.seq, member);
            // The owning group shows the whole execution, including model calls
            // before the first artifact. Derived groups remain member-scoped.
            return target.coordinator === true || !!member;
        }) : [];
        const records = snapshot.kind === "task" ? taskExecutionRows(snapshot.detail) : productionJournalRows(events, target.id);
        for (const row of records) {
            const member = eventMembers.get(Number(row.id)) || byNode.get(target.nodeId);
            rows.push({ ...row, id: `${target.key}:${row.id}`, source: member?.title, nodeId: member?.id });
        }
    }
    return rows.sort((a, b) => (Date.parse(a.time) - Date.parse(b.time) || String(a.id).localeCompare(String(b.id))) * (order === "asc" ? 1 : -1));
}

export function groupSessionHasEarlier(targets: GroupSessionTarget[], snapshots: Record<string, GroupSessionSnapshot>) {
    return targets.some(target => {
        const snapshot = snapshots[target.key];
        return target.kind === "agent" && snapshot?.kind === "agent" && (snapshot.run.events?.[0]?.seq || 0) > 1;
    });
}
