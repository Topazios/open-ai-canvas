import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { taskExecutionRows, type ExecutionJournalRow } from "@/lib/task-execution-journal";
import { productionJournalRows } from "./production-agent-journal";
import type { TaskExecutionDetails } from "@/services/api/task-center";
import type { AgentRun } from "@/services/api/agent";

export function groupSessionOwner(node: CanvasNodeData | null, nodes: CanvasNodeData[]) {
    if (!node) return null;
    if (node.type === CanvasNodeType.Frame) return node;
    const parent = nodes.find(entry => entry.id === node.parentId && entry.type === CanvasNodeType.Frame);
    return parent || node;
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
    const status = snapshot?.kind === "task" ? snapshot.detail.task.status : snapshot?.kind === "agent" ? snapshot.run.status : node.metadata?.taskStatus;
    if (status === "succeeded" || status === "completed") return "已完成";
    if (status === "failed" || status === "rejected") return "执行失败";
    if (status === "cancelled") return "已取消";
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
            if (!target.scoped) return true;
            const payload = event.payload;
            const result = payload.result as Record<string, unknown> | undefined;
            const member = members.find(node => node.id === payload.nodeId || node.id === result?.nodeId ||
                [node.title, node.metadata?.shortDrama?.planAsset?.name, node.metadata?.shortDrama?.assetIdentity?.code].some(name => name && name === payload.itemName));
            if (member) eventMembers.set(event.seq, member);
            return !!member || (target.coordinator === true && !payload.itemName && !payload.nodeId && !result?.nodeId &&
                ["production_control", "run_failed", "run_completed", "run_cancelled"].includes(event.type));
        }) : [];
        const records = snapshot.kind === "task" ? taskExecutionRows(snapshot.detail) : productionJournalRows(events, target.id);
        for (const row of records) {
            const member = eventMembers.get(Number(row.id)) || byNode.get(target.nodeId);
            rows.push({ ...row, id: `${target.key}:${row.id}`, source: member?.title, nodeId: member?.id });
        }
    }
    return rows.sort((a, b) => (Date.parse(a.time) - Date.parse(b.time) || String(a.id).localeCompare(String(b.id))) * (order === "asc" ? 1 : -1));
}
