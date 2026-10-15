import type { AgentEvent } from "@/services/api/agent";

export function mergeProductionEvents(previous: AgentEvent[], incoming: AgentEvent[]) {
    const events = new Map(previous.map((event) => [event.seq, event]));
    for (const event of incoming) events.set(event.seq, event);
    return [...events.values()].sort((a, b) => a.seq - b.seq);
}

const tools: Record<string, string> = { production_status: "读取持久进度", production_read: "阅读来源集", production_facts: "保存本集事实", production_query: "查询共享事实", production_submit: "写入资产", production_check: "检查覆盖" };
export type ProductionJournalRow = {
    id: number; kind: "message" | "model" | "tool" | "status"; title: string; detail: string;
    time: string; failed: boolean; pending?: boolean;
};
export function productionJournalRows(input: AgentEvent[], runId?: string) {
    const events = runId ? input.filter((event) => event.runId === runId) : input;
    const rows: ProductionJournalRow[] = [];
    const starts = new Map<string, { event: AgentEvent; row: ProductionJournalRow }>();
    const messages = new Map<string, ProductionJournalRow>();
    const dispatched = new Set(events.filter((event) => event.type === "production_model_started").map((event) => String(event.payload.taskId)));
    const finalized = new Set(events.filter((event) => event.type === "assistant_message" && event.payload.messageId).map((event) => String(event.payload.messageId)));
    for (const event of events) {
        const p = event.payload;
        let title = "";
        let detail = "";
        let kind: ProductionJournalRow["kind"] = "status";
        const taskId = String(p.taskId || p.requestId || "");
        if (event.type === "assistant_message" || event.type === "assistant_delta") {
            const messageId = String(p.messageId || event.eventId);
            if (event.type === "assistant_delta" && finalized.has(messageId)) continue;
            const text = typeof p.text === "string" ? p.text : "";
            if (!text) continue;
            const existing = messages.get(messageId);
            if (existing) existing.detail = event.type === "assistant_delta" ? existing.detail + text : text;
            else {
                const row: ProductionJournalRow = { id: event.seq, kind: "message", title: "进展说明", detail: text, time: event.createdAt, failed: false };
                messages.set(messageId, row); rows.push(row);
            }
            continue;
        } else if (event.type === "production_model_started" || event.type === "context_pressure") {
            if (event.type === "context_pressure" && (!taskId || dispatched.has(taskId))) continue;
            title = `调度模型${p.step ? ` · 第 ${p.step} 次` : ""}`;
            const row: ProductionJournalRow = { id: event.seq, kind: "model", title, detail: taskId, time: event.createdAt, failed: false, pending: true };
            starts.set(taskId, { event, row }); rows.push(row);
            continue;
        } else if (event.type === "production_model_completed") {
            kind = "model";
            title = p.status === "succeeded" ? "模型响应完成" : "模型调用未成功";
            const start = starts.get(taskId);
            const seconds = start ? Math.max(0, (Date.parse(event.createdAt) - Date.parse(start.event.createdAt)) / 1000) : undefined;
            detail = [String(p.text || ""), seconds !== undefined ? `${seconds.toFixed(1)} 秒` : "", taskId].filter(Boolean).join(" · ");
            if (start) {
                start.row.title += ` · ${p.status === "succeeded" ? "完成" : "未成功"}`;
                start.row.detail = detail; start.row.failed = p.status !== "succeeded"; start.row.pending = false;
                continue;
            }
        } else if (event.type === "tool_completed" || event.type === "tool_failed") {
            kind = "tool";
            title = `${tools[String(p.toolName)] || String(p.toolName || "工具")} · ${event.type === "tool_failed" ? "失败" : "完成"}`;
            const result = p.result as Record<string, unknown> | undefined;
            detail = String(p.text || "");
            if (result) {
                const summary = [result.pageId ? `集 ${String(result.pageId).slice(0, 12)}` : "", typeof result.processedPages === "number" ? `${result.processedPages}/${result.totalPages} 集` : "", typeof result.artifactCount === "number" ? `${result.artifactCount} 项产物` : "", result.valid === false ? "覆盖尚未通过" : "", result.reused === true ? "复用已保存结果" : "", typeof result.nextOffset === "number" ? `分页进度 ${result.nextOffset}` : ""];
                detail = [...summary.filter(Boolean), detail].join(" · ");
                if (Array.isArray(result.issues)) detail += ` · ${result.issues.filter((item) => typeof item === "string").join("；")}`;
            }
        } else if (["production_progress", "production_control", "run_failed", "run_completed", "run_cancelled", "unreadable_event"].includes(event.type)) {
            title = ({ production_progress: "保存进度", production_control: "调度操作", run_failed: "任务停止", run_completed: "任务完成", run_cancelled: "任务取消", unreadable_event: "记录不可读" } as Record<string, string>)[event.type];
            detail = String(p.text || p.error || "");
            if (event.type === "production_progress" && detail) title = detail;
        } else continue;
        rows.push({ id: event.seq, kind, title, detail, time: event.createdAt, failed: event.type === "tool_failed" || event.type === "run_failed" || (event.type === "production_model_completed" && p.status !== "succeeded") });
    }
    let lastCheck = "";
    const savedNodes = new Set(events.filter((event) => event.type === "production_progress").map((event) => event.payload.nodeId));
    const bySeq = new Map(events.map((event) => [event.seq, event]));
    return rows.filter((row) => {
        const event = bySeq.get(row.id)!;
        if (row.failed || row.kind === "message") return true;
        if (row.kind === "model") return false;
        if (event.type === "production_progress") { lastCheck = ""; return !!row.detail; }
        if (row.kind !== "tool") return true;
        if (event.payload.toolName === "production_check") {
            const result = event.payload.result as Record<string, unknown> | undefined;
            if (!result || (result.valid !== true && result.valid !== false)) return false;
            const signature = JSON.stringify([result.valid, result.issues, result.missingCount, result.artifactCount]);
            if (signature === lastCheck) return false;
            lastCheck = signature;
            row.title = result.valid ? "产物覆盖检查通过" : "检查发现待补内容";
            return true;
        }
        const result = event.payload.result as Record<string, unknown> | undefined;
        return event.payload.toolName === "production_submit" && !savedNodes.has(result?.nodeId);
    });
}
