import { expect, spyOn, test } from "bun:test";
import * as generation from "../src/lib/canvas/canvas-project-generation";
import { generateSubtitleHighlights } from "../src/lib/timeline/subtitle-highlight-runner";
import { installRuntimeLimits } from "./fixtures/runtime-limits";
import type { AiConfig } from "../src/stores/use-config-store";

test("subtitle batches share live global text slots across invocations and ignore legacy options", async () => {
    installRuntimeLimits({ text: 1 });
    const release: Array<() => void> = [];
    const run = spyOn(generation, "runBackendCanvasGenerationTask").mockImplementation(() => new Promise((resolve) => release.push(() => resolve({ text: '{"highlights":[]}' } as never))));
    const entries = Array.from({ length: 3 }, (_, index) => ({ index, text: "字幕", startMs: index * 1000, endMs: index * 1000 + 900 }));
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    try {
        const options = { projectId: "project", nodeId: "node", config: {} as AiConfig, batchSize: 1, concurrency: 999 };
        const first = generateSubtitleHighlights(entries, options);
        const second = generateSubtitleHighlights(entries, { ...options, nodeId: "second" });
        await tick(); expect(run).toHaveBeenCalledTimes(1);
        installRuntimeLimits({ text: 2 });
        await tick(); expect(run).toHaveBeenCalledTimes(2);
        for (let index = 0; index < 6; index++) { release[index](); await tick(); }
        expect(await first).toEqual([]); expect(await second).toEqual([]);
        expect(run).toHaveBeenCalledTimes(6);
    } finally { run.mockRestore(); }
});
