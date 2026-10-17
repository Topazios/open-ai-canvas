export const TaskConcurrencyKind = { Image: "image", Text: "text", Agent: "agent", Video: "video", Audio: "audio", Other: "other" } as const;
export type TaskConcurrencyKind = (typeof TaskConcurrencyKind)[keyof typeof TaskConcurrencyKind];

// Keep classification aligned with the backend admission and worker queues.
export function taskConcurrencyKind(task: { type: string; operation?: string }): TaskConcurrencyKind {
    if (["canvas_image", "image"].includes(task.type)) return TaskConcurrencyKind.Image;
    if (["canvas_video", "video", "timeline_render"].includes(task.type) || task.type.startsWith("video_")) return TaskConcurrencyKind.Video;
    if (["canvas_audio", "audio", "timeline_transcription"].includes(task.type)) return TaskConcurrencyKind.Audio;
    if (["canvas_text", "text"].includes(task.type)) return task.operation?.startsWith("cloud_agent") || task.operation === "agent_memory_compact" ? TaskConcurrencyKind.Agent : TaskConcurrencyKind.Text;
    return TaskConcurrencyKind.Other;
}

export function availableTaskSlots(limit: number, kind: TaskConcurrencyKind, tasks: Array<{ type: string; operation?: string; status: string }>, pending: number) {
    if (limit <= 0) return Number.POSITIVE_INFINITY;
    const active = tasks.filter((task) => ["queued", "running"].includes(task.status) && taskConcurrencyKind(task) === kind).length;
    return Math.max(0, limit - active - pending);
}
