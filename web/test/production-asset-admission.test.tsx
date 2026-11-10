import { expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { useProductionAgentRuns } from "@/pages/canvas/use-production-agent-runs";
import * as agentApi from "@/services/api/agent";
import * as canvasSync from "@/services/user-data-sync";
import { defaultConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function fixture() {
    const node: CanvasNodeData = {
        id: "plan", type: CanvasNodeType.Text, title: "制作方案", position: { x: 0, y: 0 }, width: 320, height: 240,
        metadata: { shortDrama: { stage: "story", step: "story.plan", role: "document", assetKey: "$summary", pipelineId: "pipeline", version: 1, sourceNodeIds: [], sourceSignatures: {}, productionAgent: { runId: "run" } } },
    };
    let api!: ReturnType<typeof useProductionAgentRuns>;
    function Harness() {
        api = useProductionAgentRuns("canvas", { current: [node] }, { current: false }, { config: defaultConfig, setNodes() {}, save: async () => true });
        return null;
    }
    renderToStaticMarkup(<Harness />);
    return api;
}

test("asset submission returns acceptance while canvas hydration is still pending", async () => {
    let release!: () => void;
    const hydration = new Promise<void>(resolve => { release = resolve; });
    const post = spyOn(agentApi, "controlProductionAgent").mockResolvedValue({ accepted: true });
    const refresh = spyOn(canvasSync, "refreshCanvasAfterAgent").mockImplementation(async () => { await hydration; return undefined as never; });
    try {
        const api = fixture();
        const result = await Promise.race([api.control("plan", "generate_assets", undefined, undefined, undefined, { model: "text" }, ["character"]), new Promise(resolve => setTimeout(() => resolve("blocked"), 250))]);
        expect(result).toEqual({ success: true });
        expect(post).toHaveBeenCalledTimes(1);
        expect(refresh).toHaveBeenCalledTimes(1);
    } finally {
        release();
        await hydration;
        post.mockRestore(); refresh.mockRestore();
    }
});

test("asset admission failure stays a submission error and does not refresh canvas", async () => {
    const post = spyOn(agentApi, "controlProductionAgent").mockRejectedValue(new Error("所选模型不可用"));
    const refresh = spyOn(canvasSync, "refreshCanvasAfterAgent").mockResolvedValue(undefined as never);
    try {
        const result = await fixture().control("plan", "generate_assets", undefined, undefined, undefined, undefined, ["character"]);
        expect(result).toEqual({ error: "所选模型不可用" });
        expect(refresh).not.toHaveBeenCalled();
    } finally { post.mockRestore(); refresh.mockRestore(); }
});

test("repeated click during acceptance sends only one asset request", async () => {
    let release!: () => void;
    const receipt = new Promise<void>(resolve => { release = resolve; });
    const post = spyOn(agentApi, "controlProductionAgent").mockImplementation(async () => { await receipt; return { accepted: true }; });
    const refresh = spyOn(canvasSync, "refreshCanvasAfterAgent").mockResolvedValue(undefined as never);
    let first: ReturnType<ReturnType<typeof useProductionAgentRuns>["control"]> | undefined;
    try {
        const api = fixture();
        first = api.control("plan", "generate_assets", undefined, undefined, undefined, undefined, ["character"]);
        expect(await api.control("plan", "generate_assets", undefined, undefined, undefined, undefined, ["character"])).toBeUndefined();
        expect(post).toHaveBeenCalledTimes(1);
        release();
        expect(await first).toEqual({ success: true });
    } finally { release(); await first; post.mockRestore(); refresh.mockRestore(); }
});
