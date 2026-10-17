import { formatTaskKind, generationTaskStageLabel } from "@/lib/generation-task-display";
import { shortDramaStep } from "@/lib/short-drama-steps";
import type { GenerationTask } from "@/services/api/task-center";
import type { CanvasNodeData } from "@/types/canvas";

export type CanvasTaskPresentation = {
    title: string;
    work: string;
    source: string;
    stage: string;
    nodeId?: string;
    parentTaskId?: string;
};

// Detail polling returns safe metadata rather than the list's clientContext.
export function taskPresentationContext(task: GenerationTask): NonNullable<GenerationTask["clientContext"]> {
    let metadata: Record<string, unknown> = {};
    try {
        const input = JSON.parse(task.inputJson || "{}");
        if (input?.metadata && typeof input.metadata === "object") metadata = input.metadata;
    } catch { /* Older summaries can omit inputs. */ }
    const string = (key: string) => typeof metadata[key] === "string" ? metadata[key] as string : undefined;
    const child = metadata.source === "canvas-workflow-batch-child";
    return {
        nodeId: child ? undefined : string("nodeId"),
        storyNodeId: string("storyNodeId"),
        workflowStepId: string("workflowStepId") || string("workflowStep"),
        parentTaskId: child ? string("parentTaskId") : undefined,
        batchKey: child ? string("batchKey") : undefined,
        ...task.clientContext,
    };
}

export function canvasTaskPresentation(task: GenerationTask, tasks: readonly GenerationTask[] = [], nodes: readonly CanvasNodeData[] = []): CanvasTaskPresentation {
    const context = taskPresentationContext(task);
    const parent = tasks.find((item) => item.id === context.parentTaskId && item.projectId === task.projectId);
    const parentContext = parent ? taskPresentationContext(parent) : undefined;
    const nodeId = context.parentTaskId ? context.parentNodeId || parentContext?.nodeId : context.nodeId || context.storyNodeId;
    const ownerTaskId = context.parentTaskId || task.id;
    const node = nodes.find((item) => item.id === nodeId) || nodes.find((item) => item.metadata?.taskId === ownerTaskId);
    const step = node?.metadata?.shortDrama?.step || context.workflowStepId || parentContext?.workflowStepId;
    const stepLabel = step ? shortDramaStep(step)?.label : undefined;
    const title = node?.title?.trim() || stepLabel || (context.parentTaskId ? "分批制作任务" : formatTaskKind(task));
    let work = stepLabel || formatTaskKind(task);
    const map = /^map-(\d+)$/.exec(context.batchKey || "");
    const merge = /^merge-(\d+)-(\d+)$/.exec(context.batchKey || "");
    const outlineRange = /^outline-range-(\d+)-(\d+)$/.exec(context.batchKey || "");
    if (map) work = `材料提取 · 第 ${Number(map[1]) + 1} 批`;
    else if (merge) work = `跨集归并 · 第 ${Number(merge[1]) + 1} 轮 · 第 ${Number(merge[2]) + 1} 批`;
    else if (context.batchKey === "shared-facts-v1") work = "共享正文解析";
    else if (context.batchKey === "outline-spine") work = "锁定全剧分集主线";
    else if (outlineRange) work = `生成第 ${outlineRange[1]}–${outlineRange[2]} 集集纲`;
    else if (context.batchKey?.startsWith("outline-context-")) work = "整理集纲所需故事要点";
    else if (context.batchKey === "body-final") work = "扩写本集正文";
    else if (context.batchKey?.startsWith("body-reference-")) work = "整理本集引用资产";
    else if (context.parentTaskId) work = "分批处理";
    else if (task.operation === "short_drama_batch") work = "总任务 · 汇总分批结果";
    const promptPreview = task.prompt?.trim().replace(/\s+/g, " ").slice(0, 100) || "";
    // Internal prompts contain full instructions; never use them as a task title.
    const source = context.sourceLabel || (!node && !stepLabel && !context.parentTaskId && task.operation !== "short_drama_batch" ? promptPreview : "");
    return { title, work, source, stage: generationTaskStageLabel(task), nodeId: node?.id, parentTaskId: context.parentTaskId };
}

export function canvasTaskCounts(tasks: readonly GenerationTask[]) {
    const roots = new Set<string>();
    let children = 0;
    for (const task of tasks) {
        const parent = taskPresentationContext(task).parentTaskId;
        roots.add(parent || task.id);
        if (parent) children++;
    }
    return { roots: roots.size, children, running: tasks.filter((task) => task.status === "running").length, queued: tasks.filter((task) => task.status === "queued").length };
}
