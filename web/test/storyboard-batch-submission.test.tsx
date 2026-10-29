import { expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "antd";
import { useShortDramaWorkflowGeneration } from "@/pages/canvas/use-short-drama-workflow-generation";
import * as productionAgent from "@/services/production-agent";
import * as canvasSync from "@/services/user-data-sync";
import * as workflow from "@/lib/canvas/canvas-short-drama-workflow";
import { createCanvasNode } from "@/lib/canvas/canvas-project-domain";
import { CanvasNodeType } from "@/types/canvas";
import type { AiConfig } from "@/stores/use-config-store";
import type { AgentRun } from "@/services/api/agent";
import { installRuntimeLimits } from "./fixtures/runtime-limits";

test("storyboard episodes submit independently after one save, without waiting for first receipt or refresh", async () => {
    installRuntimeLimits({ agent: 3 });
    const nodesRef = { current: [1, 2, 3].map(episodeNumber => createCanvasNode(CanvasNodeType.Script, { x: 0, y: 0 }, { shortDrama: {
        pipelineId: "p", stage: "storyboard", step: "direction.shots", role: "document", sourceNodeIds: [], sourceSignatures: {},
        episodeNumber, operationId: `ep-${episodeNumber}`, submission: "planned", productionAgent: {},
    } })) };
    const ids = nodesRef.current.map(node => node.id);
    const saves: string[][] = [], posts: string[] = [];
    let releaseFirst!: () => void;
    const first = new Promise<void>(resolve => { releaseFirst = resolve; });
    let releaseRefresh!: () => void;
    const refresh = new Promise<void>(resolve => { releaseRefresh = resolve; });
    const prepare = spyOn(productionAgent, "prepareProductionAgent").mockImplementation(async (canvasId, node) => ({ canvasId, prompt: "shot", idempotencyKey: node.metadata!.shortDrama!.operationId!, production: { targetNodeId: node.id } }));
    const sources = spyOn(workflow, "workflowGenerationSources").mockReturnValue([]);
    const post = spyOn(productionAgent, "submitProductionAgent").mockImplementation(async request => {
        expect(saves).toHaveLength(1);
        expect(saves[0]).toEqual(["submitting", "submitting", "submitting"]);
        posts.push(request.idempotencyKey!);
        if (request.idempotencyKey === "ep-1") await first;
        if (request.idempotencyKey === "ep-2") throw new Error("simulated network failure");
        return { run: { id: `run-${request.idempotencyKey}`, status: "queued" } as AgentRun };
    });
    const sync = spyOn(canvasSync, "refreshCanvasAfterAgent").mockImplementation(() => refresh as never);
    let api!: ReturnType<typeof useShortDramaWorkflowGeneration>;
    function Harness() {
        api = useShortDramaWorkflowGeneration({ projectId: "canvas", config: {} as AiConfig, nodesRef, connectionsRef: { current: [] },
            setNodes(update) { nodesRef.current = (typeof update === "function" ? update(nodesRef.current) : update) as typeof nodesRef.current; },
            setConnections() {}, save: async () => { saves.push(nodesRef.current.filter(node => ids.includes(node.id)).map(node => node.metadata!.shortDrama!.submission!)); return true; },
            center: () => ({ x:0, y:0 }), focus() {}, bindTask() {}, applyResult: async () => {},
        });
        return null;
    }
    try {
        renderToStaticMarkup(<App><Harness /></App>);
        const group = createCanvasNode(CanvasNodeType.Frame, { x:0, y:0 }, { shortDrama: { ...nodesRef.current[0].metadata!.shortDrama!, role:"collection", sourceNodeIds:ids } });
        nodesRef.current.push(group);
        const submitted = api.resume(group.id);
        for (let i=0; i<30 && posts.length < 3; i++) await new Promise(resolve => setTimeout(resolve, 1));
        expect(posts).toEqual(["ep-1", "ep-2", "ep-3"]);
        expect(nodesRef.current.find(node => node.id === ids[2])?.metadata?.shortDrama?.productionAgent?.runId).toBe("run-ep-3");
        releaseFirst();
        await submitted;
        expect(nodesRef.current.find(node => node.id === ids[0])?.metadata?.shortDrama?.productionAgent?.runId).toBe("run-ep-1");
        expect(nodesRef.current.find(node => node.id === ids[1])?.metadata?.taskStage).toBe("制作任务提交待确认");
        expect(sync).toHaveBeenCalledTimes(1);
        await api.resume(group.id);
        expect(posts).toHaveLength(3);
    } finally {
        releaseFirst(); releaseRefresh(); prepare.mockRestore(); post.mockRestore(); sync.mockRestore(); sources.mockRestore();
    }
});
