import { useState } from "react";
import { Button, Checkbox, Input, Select, Tag } from "antd";
import { Play, RotateCcw } from "lucide-react";
import { planAssetCategories, productionPlanAssetSubmitted } from "@/lib/canvas/production-plan-asset-menu";
import type { AgentRun, ProductionPlanAsset } from "@/services/api/agent";
import type { useProductionAgentRuns } from "./use-production-agent-runs";
import "./canvas-plan-asset-selector.css";

const kinds: Record<string, string> = Object.fromEntries(planAssetCategories.map(item => [item.kind, item.label]));
const statuses: Record<ProductionPlanAsset["status"], string> = { pending: "未生成", blocked: "未生成", failed: "失败", stopped: "已停止", queued: "排队中", running: "生成中", saving: "模型已返回，正在保存", retrying: "自动重试中", complete: "已完成", warning: "待检查" };

export function CanvasPlanAssetSelector({ run, state, initialKind = "", onRequestGeneration }: {
    run: AgentRun; state: ReturnType<typeof useProductionAgentRuns>; initialKind?: string; onRequestGeneration: (targetId: string, keys: string[], label: string) => void;
}) {
    const [selected, setSelected] = useState<string[]>([]);
    const [query, setQuery] = useState("");
    const [kind, setKind] = useState(initialKind);
    const progress = run.production;
    const assets = [...(progress?.assets || [])].sort((left, right) => {
        const categoryOrder = planAssetCategories.findIndex(category => category.kind === left.kind) - planAssetCategories.findIndex(category => category.kind === right.kind);
        return categoryOrder || (left.priority ?? Number.MAX_SAFE_INTEGER) - (right.priority ?? Number.MAX_SAFE_INTEGER) || left.key.localeCompare(right.key);
    });
    const target = progress?.targetNodeId || "";
    const active = ["running", "queued"].includes(run.status);
    const locked = !!state.busy[target] || (active && !!progress?.waitingForBoundary);
    const terminalPlan = ["completed", "failed", "cancelled", "waiting_user"].includes(run.status);
    const ready = progress?.assetGenerationReady === true || (progress?.assetGenerationReady === undefined && progress?.planReady && (progress.assetsStarted || (terminalPlan && progress.validated)));
    const choices = assets.filter(item => selected.includes(item.key) && !productionPlanAssetSubmitted(run, item.key) && item.status !== "complete").map(item => item.key);
    const visible = assets.filter(item => (!kind || item.kind === kind) && `${item.name} ${item.code}`.toLowerCase().includes(query.trim().toLowerCase()));
    const generate = async (keys: string[]) => {
        const label = keys.length === 1 ? assets.find(item => item.key === keys[0])?.name || "资产" : `所选 ${keys.length} 项资产`;
        onRequestGeneration(target, keys, `生成${label}`);
    };
    if (progress?.workKind !== "plan") return null;
    return <section className="plan-asset-selector" aria-label="选择资产生成">
        <div className="plan-asset-selector-heading"><strong>资产清单</strong><span>已完成 {assets.filter(item => item.status === "complete").length}/{assets.length} · 已选 {choices.length}</span></div>
        <div className="plan-asset-selector-filters">
            <Input aria-label="搜索资产" placeholder="搜索名称或编码" value={query} onChange={event => setQuery(event.target.value)} allowClear />
            <Select aria-label="资产类别" value={kind} onChange={setKind} options={[{ value: "", label: "全部类别" }, ...Object.entries(kinds).map(([value, label]) => ({ value, label }))]} />
        </div>
        {!ready ? <p role="status">制作方案全部完成后可生成资产。</p> : locked ? <p role="status">{state.busy[target] ? "正在提交资产任务。" : "正在暂停，请等待当前调用收尾。"}</p> : null}
        {!assets.length ? <p role="status">资产清单尚未就绪，可刷新任务状态后重试。</p> : <ul className="plan-asset-list">
            {visible.map(item => {
                const retry = item.status === "failed" || item.status === "stopped";
                const submitted = productionPlanAssetSubmitted(run, item.key);
                return <li key={item.key}>
                    <Checkbox aria-label={`选择 ${item.name}`} checked={choices.includes(item.key)} disabled={locked || !ready || submitted || item.status === "complete"} onChange={event => setSelected(current => event.target.checked ? [...current, item.key] : current.filter(key => key !== item.key))} />
                    <div className="plan-asset-list-content">
                        <div className="plan-asset-list-title"><strong>{item.name}</strong><Tag color={item.severity === "warning" ? "warning" : retry ? "error" : item.status === "complete" ? "success" : undefined}>{item.severity === "warning" && retry ? "待处理" : statuses[item.status]}</Tag></div>
                        <div className="plan-asset-list-meta">{item.code} · {kinds[item.kind] || item.kind}</div>
                        {item.error && <div className={`plan-asset-list-reason${item.severity === "warning" ? " production-agent-warning" : ""}`} role={item.severity === "warning" ? "status" : "alert"}>{item.error}</div>}
                    </div>
                    {item.status !== "complete" && <Button disabled={locked || !ready || submitted} icon={retry ? <RotateCcw size={14} /> : <Play size={14} />} onClick={() => void generate([item.key])}>{submitted ? "已提交" : retry ? "重试" : "生成"}</Button>}
                </li>;
            })}
        </ul>}
        <div className="plan-asset-selector-actions">
            <Button type="primary" disabled={!ready || locked || choices.length === 0} loading={!!state.busy[target]} icon={<Play size={14} />} onClick={() => void generate(choices)}>生成所选（{choices.length}）</Button>
            <Button disabled={locked || !choices.length} onClick={() => setSelected([])}>清空选择</Button>
        </div>
    </section>;
}
