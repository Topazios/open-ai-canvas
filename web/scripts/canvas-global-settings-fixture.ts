/** Serve the real frontend with isolated, in-memory APIs for creation UI checks. No model requests or user data. */
import { resolve, join, sep } from "node:path";
import type { CanvasProject } from "../src/stores/canvas/use-canvas-store";
import { createStoryDevelopmentChain } from "../src/lib/canvas/canvas-story-development";
import { defaultShortDramaSettings } from "../src/lib/short-drama-settings";
import type { GenerationTask } from "../src/services/api/task-center";
import { createShortDramaPipeline } from "../src/lib/canvas/canvas-short-drama";
import { createWorkflowDocuments, nodeWorkflow } from "../src/lib/canvas/canvas-short-drama-workflow";
import { completeUnifiedWorkflowPlan } from "../test/fixtures/workflow-plan";
const dist = resolve("dist");
const projects = new Map<string, CanvasProject>();
const topicFixture = process.env.CANVAS_TOPIC_UI_TEST === "1";
const planFixture = process.env.CANVAS_PLAN_UI_TEST === "1";
const tasks = new Map<string, GenerationTask>();
if (topicFixture) {
    const { nodes } = createStoryDevelopmentChain({ x: 80, y: 120 }, "topic-ui-pipeline");
    nodes[0].id = "topic-ui-node";
    nodes[0].metadata!.storyDevelopment!.candidates = ["最后一班渡船", "明年还会发芽", "请回答，归途车队", "重逢在灯火之前"].map((title, index) => ({ id: `candidate-${index}`, title, logline: "当熟悉的生活突然改变，一个普通人决定守住亲人和邻里的约定。", conflict: "主角需要在有限的时间内找到失联的家人，同时兑现对同行者的承诺。选择带来新的代价，每个人都需要为自己的决定负责。", appeal: "以具体行动推进情感，伏笔与人物成长相互呼应，最终完成主线收束。" }));
    const now = new Date().toISOString();
    projects.set("topic-ui", { id: "topic-ui", title: "选题交互验证", revision: 1, createdAt: now, updatedAt: now, nodes: [nodes[0]], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "dots", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 }, directorScenes: [], starterMode: "guided", globalSettings: { ...defaultShortDramaSettings(), premise: "围绕亲情与承诺展开故事。人物的每一次选择都有明确代价；最后完成主线收束，并通过行动表现关系的变化。" } });
}
if (planFixture) {
    const pipeline = createShortDramaPipeline({ x: 40, y: 80 }, true);
    pipeline.nodes[0].metadata!.content = "林岚回到旧照相馆，寻找家人留下的秘密。";
    const globalSettings = { ...defaultShortDramaSettings(), episodeCount: 3 };
    const result = createWorkflowDocuments({ step: "story.plan", pipelineId: nodeWorkflow(pipeline.nodes[0])!.pipelineId, sourceNodeIds: [pipeline.storyNodeId], model: "topic-fixture::topic-text", instruction: "", episodeCount: 3, minutesPerEpisode: "2", start: 1, count: 1, globalSettings }, pipeline.nodes, pipeline.connections, { x: 0, y: 0 });
    const { frame, docs } = completeUnifiedWorkflowPlan(result);
    frame.width = 1296; frame.height = 1040;
    frame.metadata!.frame = { collapsed: false, expandedWidth: 1296, expandedHeight: 1040 };
    docs.forEach((node, index) => { node.position = { x: frame.position.x + 24 + (index % 3) * 424, y: frame.position.y + 100 + Math.floor(index / 3) * 304 }; });
    const now = new Date().toISOString();
    projects.set("plan-ui", { id: "plan-ui", title: "制作方案前置资产验证", revision: 1, createdAt: now, updatedAt: now, nodes: result.nodes, connections: result.connections, chatSessions: [], activeChatId: null, backgroundMode: "dots", showImageInfo: false, viewport: { x: 0, y: 0, k: 0.65 }, directorScenes: [], starterMode: "guided", globalSettings });
}
const features = { welcomeEnabled: false, shortDramaEnabled: true, taskCenterEnabled: true, creditsEnabled: false, customChannelsEnabled: false, frontendModelsEnabled: false, pluginCenterEnabled: false };
const fixtures: Record<string, unknown> = {
    "/auth/session": { user: { id: "canvas-settings-fixture", username: "fixture", role: "user", status: "active" }, features },
    "/features": { features }, "/channels/system": { channels: [] }, "/plugins": { plugins: [], states: [] },
    "/plugins/status": { statuses: {}, states: {} }, "/skills/added": { skills: [] }, "/skills/presets": { presets: [] },
    "/public/appearance": { appearance: {} }, "/agent/profile": { revision: "1", hash: "fixture", layers: [] },
    "/skills": { skills: [], total: 0 }, "/announcements": { announcements: [], unreadCount: 0 }, "/banner-announcements": { banners: [] },
    "/assets": { assets: [], total: 0, hasMore: false, kindCounts: {}, categoryCounts: {}, folderCounts: {}, page: 1, pageSize: 50 },
    "/projects": { projects: [], total: 0 }, "/settings/prompt-templates": { preferences: [] }, "/model-catalog": { source: "system", channels: [] },
};
const envelope = (data: unknown, status = 200) => Response.json({ code: status === 200 ? 0 : status, data, msg: status === 200 ? "" : "isolated fixture" }, { status });
if (topicFixture || planFixture) fixtures["/model-catalog"] = { source: "system", channels: [{ id: "topic-fixture", displayName: "验证模型", models: [{ id: "topic-text", modelKey: "topic-text", displayName: "文本测试模型", capability: "text", protocol: "openai", available: true, priceTiers: [] }, { id: "plan-image", modelKey: "plan-image", displayName: "生图测试模型", capability: "image", protocol: "openai-image", available: true, priceTiers: [] }] }] };
const server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.CANVAS_SETTINGS_TEST_PORT || 4028), async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/")) {
        const api = path.slice(4);
        if (topicFixture && api === "/tasks" && request.method === "POST") {
            const input = await request.json();
            const count = Number(/一次生成 (\d+) 个/.exec(input.prompt)?.[1] || 4);
            const text = /一次生成 (\d+) 个/.test(input.prompt) ? JSON.stringify({ topics: Array.from({ length: count }, (_, index) => ({ title: `新的选题 ${index + 1}`, logline: "普通人守护亲人的故事", conflict: "承诺与现实之间的抉择", appeal: "真实情感与成长" })) }) : "调整后的选题正文，保留人物目标与核心冲突。";
            const task: GenerationTask = { id: `topic-task-${tasks.size + 1}`, type: "canvas_text", projectId: input.projectId, status: "succeeded", model: "topic-text", prompt: input.prompt, resultJson: JSON.stringify({ text }), attempts: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), clientContext: input.input?.metadata };
            tasks.set(task.id, task); return envelope(task);
        }
        if (topicFixture && api.startsWith("/tasks/topic-task-") && request.method === "GET") return envelope(tasks.get(api.split("/")[2]));
        if (request.method === "GET" && api in fixtures) return envelope(fixtures[api]);
        if (api === "/user-data/snapshot") return envelope({ projects: [...projects.values()], assets: [] });
        if (api === "/canvas-projects") return envelope({ projects: [...projects.values()].map((project) => ({ ...project, nodeCount: project.nodes.length, previewNodes: project.nodes.slice(0, 4) })), page: 1, pageSize: 40, total: projects.size, hasMore: false });
        const match = api.match(/^\/canvas-projects\/([^/]+)$/);
        if (match) {
            const id = match[1];
            if (request.method === "PUT") {
                const incoming = (await request.json()).project;
                if (incoming.id !== id) return envelope(null, 400);
                const previous = projects.get(id);
                if ((previous?.revision || 0) !== (incoming.revision || 0)) return envelope(null, 409);
                const project = { ...incoming, revision: (previous?.revision || 0) + 1, viewport: { x: 0, y: 0, k: 1 } };
                projects.set(id, project); return envelope({ project });
            }
            if (request.method === "DELETE") { projects.delete(id); return envelope({ id }); }
            return projects.has(id) ? envelope({ project: projects.get(id) }) : envelope(null, 404);
        }
        if (api.endsWith("/history")) return envelope({ snapshots: [], currentRevision: 1 });
        if (api.endsWith("/tasks/reconcile")) return envelope({ accepted: true });
        if (api === "/tasks" && request.method === "GET") return envelope([...tasks.values()]);
        if (api === "/assets/batch") return envelope({ assets: [] });
        return envelope(null, 501);
    }
    const file = resolve(dist, `.${decodeURIComponent(path)}`);
    if (file !== dist && !file.startsWith(dist + sep)) return new Response(null, { status: 403 });
    return new Response(file !== dist && await Bun.file(file).exists() ? Bun.file(file) : Bun.file(join(dist, "index.html")), { headers: { "Cache-Control": "no-store", "Content-Security-Policy": "connect-src 'self' blob:; img-src 'self' data: blob:; media-src 'self' data: blob:" } });
} });
console.log(`Isolated global settings fixture: http://127.0.0.1:${server.port}/canvas`);
