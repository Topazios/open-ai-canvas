import { useUserStore } from "@/stores/use-user-store";
import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { listGenerationTasks, subscribeCanvasTaskEvents, type CanvasTaskEvent, type GenerationTask } from "@/services/api/task-center";

export function useCanvasWorkspaceTasks(projectId: string, enabled: boolean) {
    const userId = useUserStore((s) => s.user?.id);
    const fallbackPollMinSeconds = useUserStore((state) => state.runtimeLimits.canvas?.taskFallbackPollMinSeconds ?? 3);
    const fallbackPollMaxSeconds = useUserStore((state) => state.runtimeLimits.canvas?.taskFallbackPollMaxSeconds ?? 60);
    const queryClient = useQueryClient();
    const query = useQuery<GenerationTask[]>({
        queryKey: ["canvas-workspace-tasks", userId, projectId],
        queryFn: () => listGenerationTasks(30, { projectId }),
        enabled: enabled && Boolean(projectId) && Boolean(userId),
        refetchInterval: (current) => {
            const data = current.state.data;
            if (!data?.length) return fallbackPollMaxSeconds * 1000;
            const hasActive = data.some((task) => (task.status === "queued" || task.status === "running") && !isInternalAgentTask(task));
            return (hasActive ? fallbackPollMinSeconds : fallbackPollMaxSeconds) * 1000;
        },
        refetchIntervalInBackground: false,
        refetchOnWindowFocus: true,
    });
    const { refetch } = query;

    useEffect(() => {
        if (!enabled) return;
        let refreshTimer: ReturnType<typeof setTimeout> | undefined;
        const scheduleRefresh = () => {
            if (refreshTimer) return;
            refreshTimer = globalThis.setTimeout(() => {
                refreshTimer = undefined;
                void refetch();
            }, 150);
        };
        const applyEvent = (event: CanvasTaskEvent) => {
            if (event.projectId !== projectId) return;
            if (event.eventType === "task.removed") {
                queryClient.setQueryData<GenerationTask[]>(["canvas-workspace-tasks", userId, projectId], (current) => current?.filter((item) => item.id !== event.taskId));
                return;
            }
            queryClient.setQueryData<GenerationTask[]>(["canvas-workspace-tasks", userId, projectId], (current) => {
                if (!current) return current;
                const previous = current.find((item) => item.id === event.taskId);
                if (!previous) {
                    scheduleRefresh();
                    return current;
                }
                if (event.updatedAt && previous.updatedAt > event.updatedAt) return current;
                return current.map((item) => item.id === event.taskId ? {
                    ...item,
                    status: event.status,
                    ...(event.stage !== undefined ? { stage: event.stage } : {}),
                    ...(event.progress !== undefined ? { progress: event.progress } : {}),
                    updatedAt: event.updatedAt || item.updatedAt,
                } : item);
            });
            if (event.status === "succeeded" || event.status === "failed" || event.status === "cancelled") scheduleRefresh();
        };
        const unsubscribe = subscribeCanvasTaskEvents(projectId, applyEvent);
        const handleTaskChanged = (event: Event) => {
            const task = (event as CustomEvent<{ task?: GenerationTask }>).detail?.task;
            if (task?.projectId === projectId) void refetch();
        };
        window.addEventListener("canvas:task-created", handleTaskChanged);
        window.addEventListener("canvas:task-cancelled", handleTaskChanged);
        return () => {
            unsubscribe();
            if (refreshTimer) globalThis.clearTimeout(refreshTimer);
            window.removeEventListener("canvas:task-created", handleTaskChanged);
            window.removeEventListener("canvas:task-cancelled", handleTaskChanged);
        };
    }, [enabled, projectId, queryClient, refetch, userId]);

    // 任务面板隐藏 Agent 内部任务；历史面板消费全量 allTasks。
    const tasks = useMemo(() => (query.data || []).filter((task) => !isInternalAgentTask(task)), [query.data]);

    return {
        tasks,
        allTasks: query.data || [],
        error: query.error,
        loading: query.isLoading,
        refreshing: query.isFetching,
        refetch: query.refetch,
    };
}

function isInternalAgentTask(task: GenerationTask) {
    return task.operation?.startsWith("cloud_agent") === true;
}
