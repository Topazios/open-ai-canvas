import { useMemo, useState } from "react";
import { Button, Select } from "antd";
import { Pause, Play, RefreshCw, RotateCcw, Square } from "lucide-react";
import { groupExecutionRows, groupMemberState, groupSessionMembers, groupSessionTargets } from "@/lib/canvas/canvas-group-session";
import type { CanvasNodeData } from "@/types/canvas";
import type { GenerationTask } from "@/services/api/task-center";
import { canCancelGenerationTask } from "@/lib/generation-task-display";
import type { useProductionAgentRuns } from "./use-production-agent-runs";
import { CanvasExecutionJournal } from "./canvas-execution-journal";
import { useCanvasGroupSession } from "./use-canvas-group-session";

export function CanvasGroupTaskDetails({ node, nodes, submitting, onResume, onRetry, onCancel, agentState }: {
    node: CanvasNodeData; nodes: CanvasNodeData[]; submitting: boolean; onResume: (id: string) => void;
    onRetry: (node: CanvasNodeData) => void; onCancel: (task: GenerationTask) => void; agentState: ReturnType<typeof useProductionAgentRuns>;
}) {
    const members = useMemo(() => groupSessionMembers(node, nodes), [node, nodes]);
    const visibleMembers = members.filter(member => member.metadata?.shortDrama?.assetKey !== "$summary");
    const targets = useMemo(() => groupSessionTargets(members, node, nodes), [members, node, nodes]);
    const session = useCanvasGroupSession(node.id, targets);
    const [selected, setSelected] = useState("");
    const [order, setOrder] = useState<"asc" | "desc">("desc");
    const [visible, setVisible] = useState(100);
    const chosen = members.find(member => member.id === selected);
    const target = targets.find(item => item.nodeId === chosen?.id) || (!chosen ? targets.find(item => item.coordinator) : undefined);
    const controlled = chosen || members.find(member => member.id === target?.nodeId);
    const snapshot = target ? session.snapshots[target.key] : undefined;
    const task = snapshot?.kind === "task" ? snapshot.detail.task : undefined;
    const run = snapshot?.kind === "agent" ? snapshot.run : undefined;
    const active = run && ["running", "queued"].includes(run.status);
    const pending = members.filter(member => member.metadata?.shortDrama?.submission === "planned");
    const counts = visibleMembers.reduce<Record<string, number>>((result, member) => {
        const key = targets.find(item => item.nodeId === member.id)?.key;
        const state = groupMemberState(member, key ? session.snapshots[key] : undefined);
        result[state] = (result[state] || 0) + 1;
        return result;
    }, {});
    const rows = groupExecutionRows(members, session.snapshots, order, targets).filter(row => !chosen || row.nodeId === chosen.id);
    const errors = members.filter(member => (!chosen || member.id === chosen.id) && member.metadata?.errorDetails && !targets.some(target => target.nodeId === member.id && session.snapshots[target.key]));
    return <section className="canvas-node-inspector-section production-agent-details" aria-label="分组统一详情会话" data-canvas-no-zoom data-canvas-wheel-scroll>
        <div className="production-agent-overview">
            <div className="production-agent-heading"><strong>{node.title}</strong><span className="production-agent-status">{visibleMembers.length} 个节点</span></div>
            <div className="production-agent-note" role="status">{Object.entries(counts).map(([label, count]) => `${label} ${count}`).join(" · ")}</div>
        </div>
        <div className="production-agent-actions">
            <Select aria-label="筛选组内节点" value={chosen?.id || ""} style={{ width: "100%", maxWidth: 440 }} showSearch optionFilterProp="label" onChange={value => { setSelected(value); setVisible(100); }} options={[{ value: "", label: "全部节点" }, ...visibleMembers.map(member => ({ value: member.id, label: `${member.title} · ${groupMemberState(member, session.snapshots[targets.find(item => item.nodeId === member.id)?.key || ""])}` }))]} />
            {pending.length > 0 ? <Button icon={<Play size={14} />} loading={submitting} onClick={() => onResume(node.id)}>继续提交（{pending.length}）</Button> : null}
            <Button aria-label="刷新分组记录" title="刷新分组记录" loading={session.loading} icon={<RefreshCw size={14} />} onClick={session.refresh} />
            {chosen && task && ["failed", "cancelled"].includes(task.status) ? <Button icon={<RotateCcw size={14} />} onClick={() => onRetry(chosen)}>重试此节点</Button> : null}
            {task && canCancelGenerationTask(task) ? <Button icon={<Square size={14} />} onClick={() => onCancel(task)}>取消此任务</Button> : null}
            {controlled && run && (active || run.status === "failed") ? <Button loading={agentState.busy[controlled.id]} icon={active && !run.production?.paused ? <Pause size={14} /> : <Play size={14} />} onClick={async () => { await agentState.control(controlled.id, active && !run.production?.paused ? "pause" : "resume"); session.refresh(); }}>{active && !run.production?.paused ? "暂停任务" : "继续任务"}</Button> : null}
            {controlled && active ? <Button disabled={agentState.busy[controlled.id]} icon={<Square size={14} />} onClick={async () => { await agentState.control(controlled.id, "cancel"); session.refresh(); }}>取消任务</Button> : null}
        </div>
        {errors.map(member => <div key={member.id} role="alert" className="production-agent-error">{member.title}：{member.metadata?.errorDetails}</div>)}
        {targets.filter(target => (!chosen || target.nodeId === chosen.id) && session.errors[target.key]).map(target => <div key={target.key} role="alert" className="production-agent-error">{members.find(member => member.id === target.nodeId)?.title}：{session.errors[target.key]}</div>)}
        {chosen?.metadata?.prompt ? <details className="production-agent-parameters"><summary>运行参数 · {chosen.title}</summary><dl><div><dt>模型</dt><dd>{chosen.metadata.model || "未记录"}</dd></div><div><dt>推理强度</dt><dd>{chosen.metadata.reasoningEffort || "medium"}</dd></div><div><dt>提示词</dt><dd style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{chosen.metadata.prompt}</dd></div></dl></details> : null}
        <CanvasExecutionJournal rows={rows.slice(0, visible)} order={order} onOrder={value => { setOrder(value); setVisible(100); }} empty={pending.length ? "待提交节点尚未调用模型。" : session.loading ? "正在读取本组执行记录" : "本组暂无执行记录"} />
        {rows.length > visible ? <Button onClick={() => setVisible(value => value + 100)}>显示更多记录</Button> : null}
        {targets.some(target => target.kind === "agent") ? <Button loading={session.loading} onClick={() => { session.loadEarlier(); setVisible(value => value + 100); }}>读取更早记录</Button> : null}
        {targets.some(target => { const value = session.snapshots[target.key]; return value?.kind === "task" && value.detail.truncated; }) ? <p className="production-agent-note">部分任务仅显示最近 200 条执行记录。</p> : null}
    </section>;
}
