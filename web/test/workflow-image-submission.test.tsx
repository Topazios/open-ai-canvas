import { expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "antd";
import { useShortDramaWorkflowGeneration } from "@/pages/canvas/use-short-drama-workflow-generation";
import { createWorkflowImages, workflowImageSubjects } from "@/lib/canvas/canvas-workflow-images";
import { defaultWorkflowSources, nodeWorkflow } from "@/lib/canvas/canvas-short-drama-workflow";
import { createModelChannel, defaultConfig } from "@/stores/use-config-store";
import * as taskApi from "@/services/api/task-center";
import { workflowImageFixture } from "./fixtures/workflow-image-project";
import { installRuntimeLimits } from "./fixtures/runtime-limits";

function fixture() {
    installRuntimeLimits({ image: 2 });
    const f = workflowImageFixture();
    const channel = createModelChannel({ id: "fixture", baseUrl: "https://example.invalid/v1", apiKey: "fixture-only", models: ["image"], modelCosts: [{ model: "image", capability: "image", protocol: "openai-images", billingMode: "fixed_request", unitPriceMicrocredits: 1 }] });
    const config = { ...defaultConfig, channels: [channel], model: f.request.model, imageModel: f.request.model };
    const character = { ...f.request, imageSubjectIds: [workflowImageSubjects(f.request, f.nodes)[0].id] };
    const environmentRequest = { ...f.request, step: "assets.environment_references" as const, sourceNodeIds: defaultWorkflowSources("assets.environment_references", f.request.pipelineId, f.nodes).filter(Boolean) };
    const environment = { ...environmentRequest, imageSubjectIds: [workflowImageSubjects(environmentRequest, f.nodes)[0].id] };
    const initial = createWorkflowImages(environment, f.nodes, f.connections, { x: 0, y: 0 });
    const original = initial.created[0];
    Object.assign(original.metadata!, { status: "success", content: "saved-scene.png" });
    nodeWorkflow(original)!.submission = "submitted";
    const nodesRef = { current: initial.nodes };
    const connectionsRef = { current: initial.connections };
    const submissionNodeIdsRef = { current: new Set<string>() };
    let api!: ReturnType<typeof useShortDramaWorkflowGeneration>;
    const mount = (save: () => Promise<boolean> = async () => true) => {
        function Harness() {
            api = useShortDramaWorkflowGeneration({ projectId: "canvas", config, nodesRef, connectionsRef, submissionNodeIdsRef,
                setNodes(update) { nodesRef.current = typeof update === "function" ? update(nodesRef.current) : update; },
                setConnections(connections) { connectionsRef.current = connections; }, save,
                center: () => ({ x: 0, y: 0 }), focus() {},
                bindTask(id, task) { const node = nodesRef.current.find(node => node.id === id); if (node) Object.assign(node.metadata!, { taskId: task.id, taskStatus: task.status }); },
                async applyResult(id) { const node = nodesRef.current.find(node => node.id === id); if (node) Object.assign(node.metadata!, { status: "success", content: "new-image.png" }); },
            });
            return null;
        }
        renderToStaticMarkup(<App><Harness /></App>);
        return api;
    };
    return { nodesRef, original, character, environment, submissionNodeIdsRef, mount };
}

async function until(check: () => boolean) {
    for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 2));
    expect(check()).toBe(true);
}

test("append a scene image while a character submission is pending, retaining the existing group and active lock", async () => {
    const f = fixture();
    const api = f.mount();
    let release!: () => void;
    const firstReceipt = new Promise<void>(resolve => { release = resolve; });
    const posts: taskApi.CreateTaskInput[] = [];
    const post = spyOn(taskApi, "createGenerationTask").mockImplementation(async input => {
        posts.push(input);
        const index = posts.length;
        if (index === 1) await firstReceipt;
        return { id: `task-${index}`, type: "canvas_image", status: "succeeded", prompt: input.prompt, attempts: 1, createdAt: "now", updatedAt: "now" };
    });
    let first: Promise<void> | undefined;
    try {
        first = api.run(f.character);
        await until(() => posts.length === 1);
        const pendingCharacter = f.nodesRef.current.find(node => nodeWorkflow(node)?.mediaSubjectId === f.character.imageSubjectIds[0])!;
        await api.resume(pendingCharacter.id);
        expect(posts).toHaveLength(1);
        await api.run(f.environment);
        expect(posts).toHaveLength(2);
        expect(api.submissionLock.current).toBe(true);
        expect(f.submissionNodeIdsRef.current.has(pendingCharacter.id)).toBe(true);
        const sceneImages = f.nodesRef.current.filter(node => nodeWorkflow(node)?.mediaSubjectId === f.environment.imageSubjectIds[0]);
        expect(sceneImages).toHaveLength(2);
        expect(sceneImages.map(node => node.parentId)).toEqual([f.original.parentId, f.original.parentId]);
        expect(sceneImages[0].metadata?.content).toBe("saved-scene.png");
        release();
        await first;
        expect(api.submissionLock.current).toBe(false);
        expect(f.submissionNodeIdsRef.current.size).toBe(0);
    } finally {
        release();
        await first;
        post.mockRestore();
    }
});

test("stop further submissions cancels every pending image batch and releases ownership", async () => {
    const f = fixture();
    let release!: () => void;
    const saved = new Promise<boolean>(resolve => { release = () => resolve(true); });
    let saves = 0;
    const api = f.mount(async () => { saves++; return saved; });
    const post = spyOn(taskApi, "createGenerationTask").mockRejectedValue(new Error("unexpected paid submission"));
    const runs = [api.run(f.character), api.run(f.environment)];
    try {
        await until(() => saves === 2);
        api.cancel();
        release();
        await Promise.all(runs);
        expect(post).not.toHaveBeenCalled();
        expect(api.submissionLock.current).toBe(false);
        expect(f.submissionNodeIdsRef.current.size).toBe(0);
        const stopped = f.nodesRef.current.filter(node => node.metadata?.taskStage === "已停止后续提交");
        expect(stopped).toHaveLength(2);
        expect(stopped.every(node => nodeWorkflow(node)?.submission === "planned")).toBe(true);
        expect(f.nodesRef.current.find(node => node.id === f.original.id)?.metadata?.content).toBe("saved-scene.png");
    } finally {
        release();
        await Promise.all(runs);
        post.mockRestore();
    }
});
