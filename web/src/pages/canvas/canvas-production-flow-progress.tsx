import { useState } from "react";
import { Button } from "antd";
import { RefreshCw } from "lucide-react";
import type { AgentRun } from "@/services/api/agent";
import { controlProductionAgent } from "@/services/api/agent";
import { productionFlowStageStatus } from "@/lib/canvas/production-flow-display";

type Flow = NonNullable<NonNullable<AgentRun["production"]>["flow"]>;
type Unit = Flow["units"][number];
const statuses: Record<string, string> = { completed: "已完成", accepted: "已通过", queued: "排队中", running: "执行中", repair: "自动修复中", blocked: "待重试", held: "待重试", pending: "待执行", split: "拆分补充中", paused: "已暂停", cancelled: "已取消" };

export function CanvasProductionFlowProgress({ flow, runId, runStatus, paused, onRefresh }: { flow: Flow; runId?: string; runStatus?: AgentRun["status"]; paused?: boolean; onRefresh: () => void }) {
    const [expanded, setExpanded] = useState<Record<string, boolean>>({});
    const [limits, setLimits] = useState<Record<string, number>>({});
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");
    const stopped = !!flow.stopReason || !!paused || !!runStatus && ["waiting_user", "failed", "rejected", "cancelled"].includes(runStatus);
    const stoppedLabel = runStatus === "cancelled" ? "已取消" : runStatus === "failed" || runStatus === "rejected" ? "已停止" : "已暂停";
    const resume = async () => {
        if (!runId) return;
        setBusy("resume"); setError("");
        try { await controlProductionAgent(runId, "resume"); onRefresh(); }
        catch (cause) { setError(cause instanceof Error ? cause.message : "恢复未成功"); }
        finally { setBusy(""); }
    };
    const retry = async (unit: Unit) => {
        if (!runId) return;
        setBusy(unit.id); setError("");
        try { await controlProductionAgent(runId, "retry_item", undefined, undefined, [unit.key]); onRefresh(); }
        catch (cause) { setError(cause instanceof Error ? cause.message : "重试未成功"); }
        finally { setBusy(""); }
    };
    const rowsByStage = new Map<string, Unit[]>();
    for (const unit of flow.units) {
        const rows = rowsByStage.get(unit.stage) || [];
        rows.push(unit); rowsByStage.set(unit.stage, rows);
    }
    const blocked = flow.units.filter(unit => unit.status === "held");
    const renderUnit = (unit: Unit) => <div className="production-flow-unit" key={unit.id}>
        <div className="production-flow-unit-heading">
            <span>{unit.name}</span>
            <span>{unit.percent ?? (unit.status === "accepted" ? 100 : 0)}% · {stopped && ["running", "queued", "repair", "pending"].includes(unit.status) ? stoppedLabel : statuses[unit.status] || unit.status}</span>
            {unit.status === "held" && runId && <Button size="small" icon={<RefreshCw size={14} />} loading={busy === unit.id} disabled={!!busy && busy !== unit.id} onClick={() => void retry(unit)}>重试此步骤</Button>}
        </div>
        {unit.retryAt && !stopped ? <div className="production-agent-note">已安排第 {unit.retryAttempts || 1} 次自动重试 · 不需要手动修改内容</div> : null}
        {unit.status !== "accepted" && unit.issues.map((issue, index) => <div className="production-agent-note" key={index}>
            <div>原因：{issue.message}</div>
            <div>处理：{stopped ? `${issue.action}（任务已停止派发，尚未执行）` : unit.retryAt ? "系统将自动重新执行当前步骤，保留其他成果" : issue.action}</div>
            {issue.code && <div>错误码：{issue.code}</div>}
        </div>)}
    </div>;
    return <section className="production-flow-progress" aria-label="分步骤完成进度">
        <strong>{flow.root === "inventory" ? "资产总表" : "故事总纲"}制作进度</strong>
        <div className="production-agent-note">{flow.stage} · 已保存 {flow.saved}/{flow.total} · 已通过 {flow.accepted}{stopped ? " · 任务已停止派发" : ` · 排队 ${flow.queued || 0} · 执行中 ${flow.running}`} · 待修复 {flow.repair + flow.held}</div>
        {flow.scheduler && <div className="production-agent-note">本阶段请求 {flow.scheduler.submitted || 0} 次 · 已接收 {flow.scheduler.received || 0} 次{!stopped && flow.running > 0 && !flow.scheduler.received ? " · 等待首份结果" : ""} · 并发窗口 {flow.scheduler.window} · 累计自动重试 {flow.scheduler.totalRetries || 0} 次 · 连续无进展重试 {flow.scheduler.retrySpent || 0}/{flow.scheduler.retryBudget}{!stopped && flow.scheduler.cooldownUntil && flow.scheduler.cooldownUntil > Date.now() ? " · 正在退避，稍后自动恢复，无需手动继续" : ""}</div>}
        {flow.stopReason && <div role="alert" className="production-agent-error">停止原因：{flow.stopReason}{runId && <Button size="small" icon={<RefreshCw size={14} />} loading={busy === "resume"} disabled={!!busy && busy !== "resume"} onClick={() => void resume()}>继续未完成部分</Button>}</div>}
        {blocked.length > 0 && <div className="production-flow-blockers" aria-label="未完成步骤与恢复">
            <strong>需要恢复的步骤（{blocked.length}）</strong>
            {blocked.slice(0, limits.blocked || 6).map(renderUnit)}
            {blocked.length > (limits.blocked || 6) && <Button size="small" onClick={() => setLimits(value => ({ ...value, blocked: (value.blocked || 6) + 20 }))}>显示更多未完成步骤</Button>}
        </div>}
        {error && <div role="alert" className="production-agent-error">重试或继续操作未成功：{error}。请刷新核对任务状态。</div>}
        {flow.stages?.map(stage => {
            const rows = rowsByStage.get(stage.key) || [];
            const open = !!expanded[stage.key];
            const limit = limits[stage.key] || 30;
            const stageStatus = productionFlowStageStatus(stage, rows, stopped);
            return <details className="production-flow-stage" key={stage.key} open={open} onToggle={event => {
                const next = event.currentTarget.open;
                setExpanded(value => value[stage.key] === next ? value : { ...value, [stage.key]: next });
            }}>
                <summary>
                    <span className="production-flow-stage-name">{stage.name}</span>
                    <span className="production-flow-count">{stage.totalKnown ? `${stage.completed}/${stage.total}` : stage.total > 0 ? `${stage.completed}/${stage.total}（已规划）` : "待规划"}</span>
                    <span className="production-flow-percent">{stage.percent}%</span>
                    <span className="production-flow-status">{stageStatus === "paused" ? stoppedLabel : statuses[stageStatus] || stageStatus}</span>
                    <progress aria-label={`${stage.name}完成进度`} value={stage.percent} max={100} />
                </summary>
                {open && <div className="production-flow-stage-body">
                    {rows.length ? rows.slice(0, limit).map(renderUnit) : <span className="production-agent-note">{stage.status === "completed" ? "已完成" : "等待前置步骤完成"}</span>}
                    {rows.length > limit && <Button size="small" onClick={() => setLimits(value => ({ ...value, [stage.key]: limit + 30 }))}>显示更多步骤（剩余 {rows.length - limit}）</Button>}
                </div>}
            </details>;
        })}
    </section>;
}
