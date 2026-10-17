import type { AgentEvent } from "@/services/api/agent";

export function mergeProductionEvents(previous: AgentEvent[], incoming: AgentEvent[]) {
    const events = new Map<string, AgentEvent>();
    for (const event of [...previous, ...incoming]) events.set(JSON.stringify([event.runId, event.seq]), event);
    const seen = new Set<string>();
    return [...events.values()].sort((a, b) => a.seq - b.seq).filter((event) => {
        const key = JSON.stringify([event.runId, event.eventId || event.seq]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function eventTaskId(event: AgentEvent) {
    return String(event.payload.taskId || event.payload.requestId || "");
}

function taskKey(event: AgentEvent) {
    return JSON.stringify([event.runId, eventTaskId(event) || event.eventId || event.seq]);
}

function messageKey(event: AgentEvent) {
    // The Go model bridge publishes messageId = taskId. Never infer identity
    // from similar prose, step numbers, or adjacency across history pages.
    return JSON.stringify([event.runId, event.payload.messageId || event.payload.taskId || event.eventId || event.seq]);
}

const tools: Record<string, string> = { production_status: "读取持久进度", production_read: "阅读来源集", production_facts: "保存本集事实", production_query: "查询共享事实", production_submit: "写入资产", production_check: "检查覆盖", production_storyboard_context: "读取场次检查点", production_storyboard_brief: "整理制作约束", production_storyboard_plan: "规划本集场次", production_storyboard_submit: "保存镜头批次", production_storyboard_review: "校验整集分镜", production_storyboard_read: "核对分镜来源" };
export type ProductionJournalRow = {
    id: number; kind: "message" | "model" | "tool" | "status"; title: string; detail: string;
    time: string; failed: boolean; pending?: boolean;
};
export function productionJournalRows(input: AgentEvent[], runId?: string) {
    const events = mergeProductionEvents([], runId ? input.filter((event) => event.runId === runId) : input);
    const rows: ProductionJournalRow[] = [];
    const rowEvents = new Map<ProductionJournalRow, AgentEvent>();
    const addRow = (event: AgentEvent, row: ProductionJournalRow) => {
        rowEvents.set(row, event);
        rows.push(row);
    };
    const starts = new Map<string, { event: AgentEvent; row: ProductionJournalRow }>();
    const messages = new Map<string, ProductionJournalRow>();
    const finalMessages = new Set<string>();
    const completions = new Set<string>();
    const dispatched = new Set(events.filter((event) => event.type === "production_model_started").map(taskKey));
    const finalized = new Set(events.filter((event) => event.type === "assistant_message" && event.payload.replace !== true && typeof event.payload.text === "string" && event.payload.text).map(messageKey));
    for (const event of events) {
        const p = event.payload;
        let title = "";
        let detail = "";
        let kind: ProductionJournalRow["kind"] = "status";
        const taskId = eventTaskId(event);
        const modelKey = taskKey(event);
        if (event.type === "assistant_message" || event.type === "assistant_delta" || event.type === "assistant_snapshot") {
            const messageId = messageKey(event);
            const isFinal = event.type === "assistant_message" && p.replace !== true;
            if (!isFinal && finalized.has(messageId)) continue;
            const text = typeof p.text === "string" ? p.text : "";
            if (isFinal) {
                if (!text) continue;
                const receipt = JSON.stringify([messageId, text]);
                if (finalMessages.has(receipt)) continue;
                finalMessages.add(receipt);
                addRow(event, { id: event.seq, kind: "message", title: "进展说明", detail: text, time: event.createdAt, failed: false });
                continue;
            }
            if (!text && event.type !== "assistant_snapshot" && p.replace !== true) continue;
            const existing = messages.get(messageId);
            if (existing) existing.detail = event.type === "assistant_delta" && p.replace !== true ? existing.detail + text : text;
            else {
                const row: ProductionJournalRow = { id: event.seq, kind: "message", title: "进展说明", detail: text, time: event.createdAt, failed: false };
                messages.set(messageId, row); addRow(event, row);
            }
            continue;
        } else if (event.type === "production_model_started" || event.type === "context_pressure") {
            if (event.type === "context_pressure" && (!taskId || dispatched.has(modelKey))) continue;
            if (starts.has(modelKey)) continue;
            title = `模型调用${p.step ? ` · 第 ${p.step} 次` : ""}${p.itemName ? ` · ${p.itemName}` : ""} · 等待响应`;
            const row: ProductionJournalRow = { id: event.seq, kind: "model", title, detail: taskId, time: event.createdAt, failed: false, pending: true };
            starts.set(modelKey, { event, row }); addRow(event, row);
            continue;
        } else if (event.type === "production_model_completed") {
            kind = "model";
            const receipt = JSON.stringify([modelKey, p.status, p.text, p.error, p.queueMs, p.executionMs]);
            if (completions.has(receipt)) continue;
            completions.add(receipt);
            const start = starts.get(modelKey);
            const step = p.step || start?.event.payload.step;
            title = `模型调用${step ? ` · 第 ${step} 次` : ""}${p.itemName ? ` · ${p.itemName}` : ""} · ${p.status === "succeeded" ? "完成" : "未成功"}`;
            const seconds = start ? Math.max(0, (Date.parse(event.createdAt) - Date.parse(start.event.createdAt)) / 1000) : undefined;
            const timing = typeof p.executionMs === "number" ? `排队 ${(Number(p.queueMs || 0) / 1000).toFixed(1)} 秒 · 执行 ${(p.executionMs / 1000).toFixed(1)} 秒` : seconds !== undefined ? `总等待 ${seconds.toFixed(1)} 秒` : "";
            const elapsed = typeof p.executionMs === "number" ? `执行 ${(p.executionMs / 1000).toFixed(1)} 秒` : seconds !== undefined ? `总等待 ${seconds.toFixed(1)} 秒` : "";
            if (elapsed) title += ` · ${elapsed}`;
            detail = [String(p.text || p.error || ""), timing, taskId].filter(Boolean).join(" · ");
            if (start?.row.pending) {
                start.row.title = title;
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
        addRow(event, { id: event.seq, kind, title, detail, time: event.createdAt, failed: event.type === "tool_failed" || event.type === "run_failed" || (event.type === "production_model_completed" && p.status !== "succeeded") });
    }
    const lastChecks = new Map<string, string>();
    const savedNodes = new Set(events.filter((event) => event.type === "production_progress" && event.payload.nodeId).map((event) => JSON.stringify([event.runId, event.payload.nodeId])));
    return rows.filter((row) => {
        const event = rowEvents.get(row)!;
        if (row.failed || row.kind === "model") return true;
        if (row.kind === "message") return !!row.detail;
        if (event.type === "production_progress") { lastChecks.delete(event.runId); return !!row.detail; }
        if (row.kind !== "tool") return true;
        if (event.payload.toolName === "production_check") {
            const result = event.payload.result as Record<string, unknown> | undefined;
            if (!result || (result.valid !== true && result.valid !== false)) return false;
            const signature = JSON.stringify([result.valid, result.issues, result.missingCount, result.artifactCount]);
            if (signature === lastChecks.get(event.runId)) return false;
            lastChecks.set(event.runId, signature);
            row.title = result.valid ? "产物覆盖检查通过" : "检查发现待补内容";
            return true;
        }
        const result = event.payload.result as Record<string, unknown> | undefined;
        return event.payload.toolName === "production_submit" && !savedNodes.has(JSON.stringify([event.runId, result?.nodeId]));
    });
}
