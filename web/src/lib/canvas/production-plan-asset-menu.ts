import { PlannedAssetKind } from "@/lib/production-plan";
import type { AgentRun } from "@/services/api/agent";

export const planAssetCategories = [
    { kind: PlannedAssetKind.Character, label: "人物" },
    { kind: PlannedAssetKind.Environment, label: "场景" },
    { kind: PlannedAssetKind.Prop, label: "道具" },
    { kind: PlannedAssetKind.Sound, label: "声音" },
    { kind: PlannedAssetKind.Special, label: "特殊资产" },
] as const;

export function productionPlanAssetSubmitted(run: AgentRun | undefined, key: string) {
    const progress = run?.production;
    return !!run && ["running", "queued"].includes(run.status) && !!progress?.assetsStarted && !progress.paused &&
        (progress.selectedAssetKeys === undefined || progress.selectedAssetKeys.includes(key)) &&
        !progress.assets?.some(asset => asset.key === key && ["failed", "stopped"].includes(asset.status));
}

export function productionPlanInventoryRecoveryAvailable(run?: AgentRun) {
    const progress = run?.production;
    return Boolean(progress?.inventoryRecoveryAvailable && run && ["completed", "failed", "cancelled", "waiting_user"].includes(run.status));
}

/**
 * Category commands never block on plan or asset state. The only disabled state is an in-flight
 * submission from this client (anti double click). Every other condition is shown as a hint and the
 * backend decides how to create the task (new asset, new version, or a readable conflict error).
 */
export function productionPlanAssetMenu(run?: AgentRun, busy = false) {
    const progress = run?.production;
    const assets = progress?.assets || [];
    const active = run && ["running", "queued"].includes(run.status);
    const waitingBoundary = Boolean(active && progress?.waitingForBoundary);
    const terminalPlan = run && ["completed", "failed", "cancelled", "waiting_user"].includes(run.status);
    const ready = progress?.assetGenerationReady === true || (progress?.assetGenerationReady === undefined && progress?.planReady && (progress.assetsStarted || (terminalPlan && progress.validated)));
    return planAssetCategories.map(category => {
        const members = assets.filter(asset => asset.kind === category.kind)
            .sort((left, right) => (left.priority ?? Number.MAX_SAFE_INTEGER) - (right.priority ?? Number.MAX_SAFE_INTEGER) || left.key.localeCompare(right.key));
        const unfinished = members.filter(asset => asset.status !== "complete");
        const pending = unfinished.filter(asset => !productionPlanAssetSubmitted(run, asset.key));
        const saving = unfinished.some(asset => asset.status === "saving");
        const hint = busy ? "正在提交资产任务"
            : !run ? "将读取制作方案状态后创建资产任务"
            : waitingBoundary ? "当前调用收尾后开始"
            : !ready ? "将直接按制作方案创建资产任务"
            : !members.length ? "Agent 将依据制作方案提取此类资产并生成"
            : !pending.length ? (saving ? "模型已返回，正在保存资产；再次生成会追加新版本" : unfinished.length ? "此类资产已提交；再次提交会由系统判断是否重复" : "此类资产已全部完成；再次生成会追加新版本")
            : "生成全部未完成项";
        return { ...category, label: `生成${category.label}`, kinds: [category.kind], disabled: busy, detail: hint };
    });
}
