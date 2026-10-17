import { expect, test } from "bun:test";
import { availableTaskSlots, taskConcurrencyKind } from "@/lib/task-concurrency";

test("media and ordinary text never consume Agent model slots", () => {
    for (const type of ["image", "video", "audio"] as const) expect(taskConcurrencyKind({ type: `canvas_${type}`, operation: "cloud_agent_step" })).toBe(type);
    expect(taskConcurrencyKind({ type: "canvas_text", operation: "short_drama_batch" })).toBe("text");
    for (const operation of ["cloud_agent", "cloud_agent_step", "cloud_agent_context_compaction", "agent_memory_compact"]) expect(taskConcurrencyKind({ type: "canvas_text", operation })).toBe("agent");
    expect(taskConcurrencyKind({ type: "video_extend" })).toBe("video");
    expect(taskConcurrencyKind({ type: "timeline_transcription" })).toBe("audio");
});

test("batch capacity counts only its media lane, including reservations and other projects", () => {
    const tasks = [
        { type: "canvas_image", status: "running", projectId: "other" },
        { type: "canvas_image", status: "queued" },
        { type: "canvas_image", status: "failed" },
        { type: "canvas_video", status: "running" },
        { type: "canvas_text", operation: "cloud_agent_step", status: "running" },
    ];
    expect(availableTaskSlots(3, "image", tasks, 1)).toBe(0);
    expect(availableTaskSlots(3, "video", tasks, 0)).toBe(2);
    expect(availableTaskSlots(3, "text", tasks, 0)).toBe(3);
    expect(availableTaskSlots(3, "agent", tasks, 0)).toBe(2);
    expect(availableTaskSlots(0, "image", tasks, 200)).toBe(Infinity);
});
