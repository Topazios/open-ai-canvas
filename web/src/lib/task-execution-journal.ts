import type { TaskExecutionDetails } from "@/services/api/task-center";
import { generationTaskStageLabel, generationTaskStatusLabel } from "./generation-task-display";

export type ExecutionJournalRow = { id: string | number; kind: string; title: string; detail: string; time: string; failed: boolean; pending?: boolean; source?: string; nodeId?: string };

export function taskElapsed(start?: string, end?: string, now = Date.now()) {
    const from = Date.parse(start || "");
    const to = end ? Date.parse(end) : now;
    if (!Number.isFinite(from) || !Number.isFinite(to)) return "未记录";
    const seconds = Math.max(0, Math.floor((to - from) / 1000));
    return seconds >= 60 ? `${Math.floor(seconds / 60)}分${seconds % 60}秒` : `${seconds}秒`;
}

export function taskExecutionRows(detail: TaskExecutionDetails, now = Date.now()): ExecutionJournalRow[] {
    const task = detail.task;
    const startedAt = detail.firstStartedAt || task.startedAt;
    const terminal = ["succeeded", "failed", "cancelled"].includes(task.status);
    const end = task.completedAt || (terminal ? task.updatedAt : undefined);
    const rows: ExecutionJournalRow[] = [{ id: `${task.id}:created`, kind: "status", title: "任务已提交", detail: `排队等待 ${taskElapsed(task.createdAt, startedAt || end, now)}`, time: task.createdAt, failed: false }];
    if (startedAt) rows.push({ id: `${task.id}:started`, kind: "model", title: task.operation === "short_drama_batch" ? "开始分批处理" : "开始执行", detail: task.operation === "short_drama_batch" ? `本次请求包含 ${detail.unitCount || "多"} 份材料，执行过程中逐份保存结果。` : generationTaskStageLabel(task), time: startedAt, failed: false });
    for (const step of detail.steps) {
        const pending = step.status === "running" || step.status === "queued";
        const status = generationTaskStatusLabel({ ...task, ...step });
        rows.push({ id: step.id, kind: "model", title: `${step.label} · ${status}`, time: step.startedAt || step.createdAt, failed: step.status === "failed", pending,
            detail: [step.stage, `排队等待 ${taskElapsed(step.createdAt, step.startedAt || step.completedAt, now)}`,
                step.startedAt ? `执行耗时 ${taskElapsed(step.startedAt, step.completedAt, now)}` : "尚未开始调用模型",
                step.error, step.outputPreview ? `已保存 ${step.outputChars} 字\n${step.outputPreview}${step.outputChars > Array.from(step.outputPreview).length ? "\n（内容较长，此处显示摘要）" : ""}` : pending ? "尚未收到可展示的正文，正在等待模型响应。" : ""].filter(Boolean).join("\n") });
    }
    for (const event of detail.events || []) rows.push({ id: event.id, kind: "status", title: event.title, detail: "", time: event.createdAt, failed: event.failed });
    if (detail.qualityWarnings?.length) rows.push({ id: `${task.id}:quality`, kind: "status", title: "正文完成度需复核", detail: detail.qualityWarnings.join("\n"), time: task.completedAt || task.updatedAt, failed: false });
    if (!terminal && task.status === "running") rows.push({ id: `${task.id}:current`, kind: "model", title: generationTaskStageLabel(task), detail: `${task.operation === "short_drama_batch" ? "流程历时（含重试间隔）" : "执行耗时"} ${taskElapsed(startedAt, undefined, now)}${task.textDraft ? `\n已接收 ${Array.from(task.textDraft).length} 字` : "\n尚未收到最终结果，后台任务仍在执行。"}`, time: task.updatedAt, failed: false, pending: true });
    if (task.completedAt || ["succeeded", "failed", "cancelled"].includes(task.status)) rows.push({ id: `${task.id}:terminal`, kind: "status", title: generationTaskStatusLabel(task), detail: task.error || task.stage || "", time: task.completedAt || task.updatedAt, failed: task.status === "failed" });
    return rows.sort((a,b) => Date.parse(a.time) - Date.parse(b.time) || String(a.id).localeCompare(String(b.id)));
}
