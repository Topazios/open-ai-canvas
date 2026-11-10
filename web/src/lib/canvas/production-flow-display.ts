import type { AgentRun } from "@/services/api/agent";

type Flow = NonNullable<NonNullable<AgentRun["production"]>["flow"]>;
type RunState = Pick<AgentRun, "status"> & { production?: Pick<NonNullable<AgentRun["production"]>, "paused" | "waitingForBoundary"> };

export function productionFlowDisplay(flow: Flow, run?: RunState) {
    if (run?.status === "cancelled") return { label: "已取消", detail: "生成已停止，已保存内容保留。" };
    if (run?.status === "completed") return { label: "已完成", detail: "本轮任务已结束。" };
    if (run?.production?.paused && run.production.waitingForBoundary) return { label: "正在暂停", detail: "已停止派发新任务，等待当前请求结束。" };
    if (run?.status === "failed" || run?.status === "rejected") return { label: "已停止", detail: "当前任务未完成，需处理失败原因后继续。" };
    if (flow.stopReason || run?.production?.paused || run?.status === "waiting_user") return { label: "已暂停", detail: "不会继续派发生成请求，已保存内容保留，等待手动继续。" };
    if (flow.running > 0) return { label: "正在执行", detail: `${flow.running} 个请求正在处理，等待模型返回${flow.scheduler?.received === 0 ? "首份结果" : "结果"}。` };
    if ((flow.queued || 0) > 0) return { label: "排队中", detail: `${flow.queued} 个请求等待执行，目前没有正在生成的请求。` };
    if (flow.scheduler?.cooldownUntil && flow.scheduler.cooldownUntil > Date.now()) return { label: "等待自动恢复", detail: "正在短暂退避，稍后自动继续未完成步骤，无需手动操作。" };
    if (flow.repair > 0) return { label: "自动修复中", detail: "正在补充未通过的内容，已通过部分保留。" };
    if (flow.held > 0) return { label: "等待处理", detail: "部分步骤未通过，当前没有正在生成的请求。" };
    return { label: "正在安排下一步", detail: "正在检查已返回内容或准备后续步骤。" };
}

export function productionFlowStageStatus(stage: NonNullable<Flow["stages"]>[number], units: Flow["units"], stopped: boolean) {
    if (stage.status === "completed") return "completed";
    if (stopped) return "paused";
    if (stage.status === "blocked") return "blocked";
    const assigned = units.filter(unit => unit.stage === stage.key && ["queued", "running"].includes(unit.status));
    if (assigned.some(unit => unit.status === "running")) return "running";
    if (assigned.length) return "queued";
    return stage.status;
}
