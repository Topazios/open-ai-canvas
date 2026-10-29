import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { listGenerationTasks, subscribeCanvasTaskEvents, type CanvasTaskEvent, type GenerationTask } from "@/services/api/task-center";
import { useUserStore } from "@/stores/use-user-store";

export function useCanvasActiveTasks(projectId: string, enabled: boolean) {
    const queryClient = useQueryClient();
    const fallbackPollMinSeconds = useUserStore((state) => state.runtimeLimits.canvas?.taskFallbackPollMinSeconds ?? 3);
    const fallbackPollMaxSeconds = useUserStore((state) => state.runtimeLimits.canvas?.taskFallbackPollMaxSeconds ?? 60);
    const query = useQuery<GenerationTask[]>({
        queryKey: ["canvas-active-tasks", projectId],
        // Agent 由面板按持久 run 展示，内部模型调用不重复占据任务卡片。
        queryFn: ({ signal }) => listGenerationTasks(100, { projectId, activeOnly: true }, undefined, signal).then((tasks) => tasks.filter((task) => !isInternalAgentTask(task))),
        enabled: enabled && Boolean(projectId),
        // The canvas event stream provides live updates. This slower batch
        // refresh repairs missed events and discovers tasks created in another tab.
        refetchInterval: (current) => {
            const hasActive = (current.state.data || []).some((task) => task.status === "queued" || task.status === "running");
            return (hasActive ? fallbackPollMinSeconds : fallbackPollMaxSeconds) * 1000;
        },
        refetchIntervalInBackground: false,
        refetchOnWindowFocus: true,
    });
    const { refetch } = query;

    useEffect(() => {
        if (!enabled || !projectId) return;
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
                queryClient.setQueryData<GenerationTask[]>(["canvas-active-tasks", projectId], (current) => current?.filter((item) => item.id !== event.taskId));
                return;
            }
            queryClient.setQueryData<GenerationTask[]>(["canvas-active-tasks", projectId], (current) => {
                if (!current) return current;
                const previous = current.find((item) => item.id === event.taskId);
                if (!previous) {
                    scheduleRefresh();
                    return current;
                }
                if (event.updatedAt && previous.updatedAt > event.updatedAt) return current;
                if (event.status !== "queued" && event.status !== "running") {
                    scheduleRefresh();
                    return current.filter((item) => item.id !== event.taskId);
                }
                return current.map((item) => item.id === event.taskId ? {
                    ...item,
                    status: event.status,
                    ...(event.stage !== undefined ? { stage: event.stage } : {}),
                    ...(event.progress !== undefined ? { progress: event.progress } : {}),
                    updatedAt: event.updatedAt || item.updatedAt,
                } : item);
            });
        };
        const unsubscribe = subscribeCanvasTaskEvents(projectId, applyEvent);
        return () => {
            unsubscribe();
            if (refreshTimer) globalThis.clearTimeout(refreshTimer);
        };
    }, [enabled, projectId, queryClient, refetch]);

    useEffect(() => {
        if (!enabled || !projectId) return;
        const handleTaskChanged = (event: Event) => {
            const task = (event as CustomEvent<{ task?: GenerationTask }>).detail?.task;
            if (task?.projectId === projectId) void refetch();
        };
        window.addEventListener("canvas:task-created", handleTaskChanged);
        window.addEventListener("canvas:task-cancelled", handleTaskChanged);
        return () => {
            window.removeEventListener("canvas:task-created", handleTaskChanged);
            window.removeEventListener("canvas:task-cancelled", handleTaskChanged);
        };
    }, [enabled, projectId, refetch]);

    return {
        tasks: query.data || [],
        loading: query.isLoading,
        refreshing: query.isFetching,
        refetch: query.refetch,
    };
}

function isInternalAgentTask(task: GenerationTask) {
    return task.operation?.startsWith("cloud_agent") === true;
}
