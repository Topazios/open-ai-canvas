import { expect, test } from "bun:test";
import { canvasPayloadBytes } from "../src/lib/canvas/canvas-payload";
import { apiClient } from "../src/services/api/request";
import { upsertRemoteCanvasProject } from "../src/services/api/user-data";
import type { CanvasProject } from "../src/stores/canvas/use-canvas-store";

test("UTF-8 count matches encoder without a duplicate binary payload", () => {
    for (const value of ["abc", "中文", "é", "😀", "\ud800", JSON.stringify({ text: "中文\n😀" })]) {
        expect(canvasPayloadBytes(value)).toBe(new TextEncoder().encode(value).byteLength);
    }
});

test("canvas above former 8MiB limit is sent once with JSON envelope intact", async () => {
    const previous = apiClient.defaults.adapter;
    let count = 0;
    apiClient.defaults.adapter = async config => {
        count++;
        const body = JSON.parse(config.data);
        expect(body.project.nodes[0].metadata.content.length).toBe(9 * 1024 * 1024);
        expect(body.repairMissingResources).toBe(true);
        expect(body.project.viewport).toBeUndefined();
        return { status: 200, statusText: "OK", headers: {}, config, data: { code: 0, data: { project: { id: "test", revision: 1 } } } };
    };
    try {
        await upsertRemoteCanvasProject({ id: "test", nodes: [{ id: "text", type: "text", metadata: { content: "x".repeat(9 * 1024 * 1024) } }], connections: [] } as unknown as CanvasProject, { repairMissingResources: true });
        expect(count).toBe(1);
    } finally { apiClient.defaults.adapter = previous; }
});
