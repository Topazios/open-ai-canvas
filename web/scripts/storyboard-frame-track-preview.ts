/** Real canvas route with in-memory API fixtures; no backend or model requests. */
import { resolve, join, sep } from "node:path";
import { createCanvasNode, createStoryboardRow } from "../src/lib/canvas/canvas-project-domain";
import { materializeStoryboardFrames, storyboardBoundaryFrames, storyboardFrameHash } from "../src/lib/canvas/episode-storyboard-frames";
import { createCanvasPerformanceProject } from "../test/fixtures/canvas-performance-project";
import { CanvasNodeType } from "../src/types/canvas";

const dist = resolve("dist");
const projects = new Map();
const assets = new Map();
for (const theme of ["dark", "light"]) {
    const rows = [1, 2, 3, 4].map(i => createStoryboardRow(i, { id: `shot-${i}`, sceneId: i < 4 ? "S01" : "S02", shotCode: `EP001-S0${i < 4 ? 1 : 2}-00${i}`, durationSeconds: 12, videoMotionPrompt: `人物在房间放下相机，镜头 ${i}` }));
    const script = createCanvasNode(CanvasNodeType.Script, { x: 0, y: 0 }, { status: "success", storyboard: { rows, visibleColumns: [], referenceNodeIds: [] }, shortDrama: { pipelineId: "p", stage: "storyboard", step: "direction.shots", role: "document", sourceNodeIds: [], sourceSignatures: {}, submission: "submitted", episodeNumber: 1 } });
    script.width = 1100;
    script.height = 620;
    script.position = { x: 0, y: 0 };
    const plan = createCanvasNode(CanvasNodeType.Text, { x: 0, y: 0 }, { status: "success", content: JSON.stringify({ frames: [{ timeSeconds: 6, prompt: "人物放下相机的瞬间" }] }), storyboardFramePlan: { scriptId: script.id, rowId: rows[0].id, sourcePromptHash: storyboardFrameHash(rows[0]) } });
    rows[0].framePlanNodeId = plan.id;
    const result = materializeStoryboardFrames(script, rows.slice(0, 2).map(row => ({ row, frames: storyboardBoundaryFrames(row) })), [script, plan], [], "fixture-image", { size: "16:9", quality: "standard", transparentBackground: "false" });
    const nodes = result.nodes.map((node, index) => node.metadata?.storyboardFrame && index < 4 ? { ...node, metadata: { ...node.metadata, status: "success" as const, content: "/welcome/charge/factory.webp" } } : node);
    projects.set(`frame-track-${theme}`, { ...createCanvasPerformanceProject(100), id: `frame-track-${theme}`, title: "分镜共享帧交互验证", nodes, connections: [], viewport: { x: 180, y: 100, k: 0.9 }, appearance: { mode: theme } });
}
const features = { welcomeEnabled: false, shortDramaEnabled: true, taskCenterEnabled: true, creditsEnabled: false, customChannelsEnabled: false, frontendModelsEnabled: false, pluginCenterEnabled: false };
const reply = (data: unknown) => Response.json({ code: 0, data, msg: "" });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/")) {
        const key = path.slice(4);
        if (key === "/auth/session") return reply({ user: { id: "frame-track-qa", username: "fixture", role: "user", status: "active" }, features, runtimeLimits: { activeTaskLimit: 20, resourceUploadMB: 50, concurrency: { image: 6, text: 4, agent: 4, video: 2, audio: 3, other: 2, channel: 12, customRelay: 12, imagePreparation: 4, resourceDownload: 4, upload: 4, mediaRecovery: 2, agentSessions: 4 } } });
        if (key === "/features") return reply({ features });
        if (key === "/model-catalog") return reply({ source: "system", channels: [] });
        const assetId = key.match(/^\/assets\/([^/]+)$/)?.[1];
        if (assetId && request.method === "PUT") {
            const { asset } = await request.json();
            assets.set(assetId, asset);
            return reply({ asset });
        }
        if (key.endsWith("/task-events")) return new Response(": fixture\n\n", { headers: { "Content-Type": "text/event-stream" } });
        const projectId = key.match(/^\/canvas-projects\/([^/]+)$/)?.[1];
        if (projectId && projects.has(projectId)) {
            let project = projects.get(projectId);
            if (request.method === "PUT") {
                const input = await request.json();
                project = { ...input.project, revision: project.revision + 1 };
                projects.set(projectId, project);
            }
            return reply({ project });
        }
        if (key.endsWith("/history")) return reply({ snapshots: [], currentRevision: 1 });
        if (key === "/user-data/snapshot") return reply({ projects: [...projects.values()], assets: [...assets.values()] });
        if (key.endsWith("/tasks/reconcile")) return reply({ accepted: true });
        const fixtures: Record<string, unknown> = { "/tasks": [], "/assets": { assets: [], total: 0, hasMore: false, kindCounts: {}, categoryCounts: {}, folderCounts: {} }, "/assets/batch": { assets: [] }, "/projects": { projects: [], total: 0 }, "/channels/system": { channels: [] }, "/plugins": { plugins: [], states: {} }, "/plugins/status": { statuses: {}, states: {} }, "/skills/added": { skills: [] }, "/skills/presets": { presets: [] }, "/skills": { skills: [], total: 0 }, "/public/appearance": { appearance: {} }, "/announcements": { announcements: [], unreadCount: 0 }, "/banner-announcements": { banners: [] }, "/settings/prompt-templates": { preferences: [] }, "/agent/profile": { revision: "1", hash: "fixture", layers: [] } };
        if (key in fixtures && request.method === "GET") return reply(fixtures[key]);
        console.log(`Blocked fixture request: ${request.method} ${key}`);
        return Response.json({ code: 501, msg: "Fixture does not submit generation requests" }, { status: 501 });
    }
    const filePath = resolve(dist, `.${decodeURIComponent(path)}`);
    if (filePath !== dist && !filePath.startsWith(dist + sep)) return new Response(null, { status: 403 });
    const file = Bun.file(filePath);
    return new Response(filePath !== dist && await file.exists() ? file : Bun.file(join(dist, "index.html")));
} });
console.log(`http://127.0.0.1:${server.port}/canvas/frame-track-dark`);
console.log(`http://127.0.0.1:${server.port}/canvas/frame-track-light`);
