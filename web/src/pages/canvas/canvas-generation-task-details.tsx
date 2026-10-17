import { useEffect, useMemo, useState } from "react";
import { Button, Tooltip } from "antd";
import { ChevronRight, Play, RefreshCw, SlidersHorizontal, Square } from "lucide-react";
import { queryTaskExecutionDetails, type GenerationTask, type TaskExecutionDetails } from "@/services/api/task-center";
import { generationTaskStageLabel, generationTaskStatusLabel, canCancelGenerationTask } from "@/lib/generation-task-display";
import { taskElapsed, taskExecutionRows } from "@/lib/task-execution-journal";
import { modelDisplayName, useEffectiveConfig } from "@/stores/use-config-store";
import type { CanvasNodeData } from "@/types/canvas";
import { CanvasExecutionJournal } from "./canvas-execution-journal";

export function CanvasGenerationTaskDetails({ node, onRetry, onCancel }: {
    node: CanvasNodeData; onRetry: (node: CanvasNodeData) => void; onCancel: (task: GenerationTask) => void;
}) {
    const id = node.metadata?.taskId;
    const [detail, setDetail] = useState<TaskExecutionDetails | null>(null);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);
    const [refresh, setRefresh] = useState(0);
    const [order, setOrder] = useState<"desc" | "asc">("desc");
    const config = useEffectiveConfig();
    useEffect(() => {
        setDetail(null); setError("");
        if (!id) return;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const poll = async () => {
            setLoading(true);
            let keepPolling = true;
            try {
                const snapshot = await queryTaskExecutionDetails(id, controller.signal);
                if (controller.signal.aborted) return;
                if (snapshot.task.id !== id) throw new Error("任务记录与当前节点不匹配");
                setDetail(snapshot); setError("");
                keepPolling = ["queued", "running"].includes(snapshot.task.status);
            } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "执行记录读取失败"); }
            finally {
                if (!controller.signal.aborted) {
                    setLoading(false);
                    if (keepPolling) timer = setTimeout(() => void poll(), 3000);
                }
            }
        };
        void poll();
        return () => { controller.abort(); clearTimeout(timer); };
    }, [id, node.id, refresh]);
    const current = detail?.task.id === id ? detail : null;
    const task = current?.task;
    const startedAt = current?.firstStartedAt || task?.startedAt;
    const endedAt = task?.completedAt || (task && !["queued", "running"].includes(task.status) ? task.updatedAt : undefined);
    const rows = useMemo(() => { const rows = current ? taskExecutionRows(current) : []; return order === "desc" ? rows.reverse() : rows; }, [current, order]);
    const names: Record<string,string> = { size:"尺寸 / 比例",quality:"质量",vquality:"分辨率",videoSeconds:"时长（秒）",audioVoice:"音色",audioFormat:"音频格式",audioSpeed:"语速",reasoningEffort:"推理强度",count:"数量" };
    return <section className="canvas-node-inspector-section production-agent-details" aria-label="任务执行记录" data-canvas-no-zoom data-canvas-wheel-scroll>
        <div className="production-agent-overview">
            <div className="production-agent-heading"><strong>{node.title}</strong><span className="production-agent-status" role="status">{task ? generationTaskStatusLabel(task) : error ? "状态读取失败" : "正在核对后台状态"}</span></div>
            <div className="production-agent-note">{task ? generationTaskStageLabel(task) : node.metadata?.taskStage}</div>
            {task && <div className="production-agent-note">首次排队 {taskElapsed(task.createdAt,startedAt || endedAt)}{startedAt ? ` · ${task.operation === "short_drama_batch" ? "流程历时（含重试间隔）" : "执行"} ${taskElapsed(startedAt,endedAt)}` : ""}{task.operation === "short_drama_batch" && current ? ` · ${current.truncated ? "当前记录中" : ""}已保存 ${current.steps.filter((step) => step.status === "succeeded").length} 次调用结果` : ""}</div>}
        </div>
        {error && <div className="production-agent-error" role="alert">{error}{current ? "，已保留上次读取的记录。" : "，正在重新读取后台状态。"}</div>}
        {task?.error && <div className="production-agent-error" role="alert">{task.error}</div>}
        <div className="production-agent-actions">
            {task && ["failed","cancelled"].includes(task.status) && <Button type="primary" icon={<Play size={14} />} onClick={() => onRetry(node)}>重试任务</Button>}
            {task && canCancelGenerationTask(task) && <Button icon={<Square size={14} />} onClick={() => onCancel(task)}>取消任务</Button>}
            <Tooltip title="刷新执行记录"><Button aria-label="刷新执行记录" loading={loading} icon={<RefreshCw size={14} />} onClick={() => setRefresh((value) => value+1)} /></Tooltip>
        </div>
        <details className="production-agent-parameters"><summary><SlidersHorizontal size={14} /><span>运行参数</span><ChevronRight size={14} className="production-agent-chevron" /></summary><dl>
            <div><dt>模型</dt><dd>{modelDisplayName(config,task?.model || node.metadata?.model || "") || "未记录"}</dd></div>
            <div><dt>任务 ID</dt><dd>{id}</dd></div>
            {Object.entries(current?.parameters || {}).map(([key,value]) => <div key={key}><dt>{names[key] || key}</dt><dd>{value}</dd></div>)}
            <div className="production-agent-prompt"><dt>提示词</dt><dd>{task?.prompt || node.metadata?.prompt || "未记录"}</dd></div>
        </dl></details>
        <CanvasExecutionJournal rows={rows} order={order} onOrder={setOrder} empty={error ? "记录暂时不可用，可刷新重试" : loading ? "正在读取执行记录" : "尚无执行记录"}>
            {current?.truncated && <p className="production-agent-note">当前展示最近的调用和关键事件，较早记录未全部展开。</p>}
        </CanvasExecutionJournal>
    </section>;
}
