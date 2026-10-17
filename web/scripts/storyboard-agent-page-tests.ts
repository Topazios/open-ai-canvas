/** Actual production canvas with isolated APIs; no user data or model calls. */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import { workflowImageFixture } from "../test/fixtures/workflow-image-project";
import { createCanvasPerformanceProject } from "../test/fixtures/canvas-performance-project";
import { createWorkflowDocuments, defaultWorkflowSources } from "../src/lib/canvas/canvas-short-drama-workflow";

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const dist = resolve("dist");
const output = resolve("../.local/canvas-benchmark/storyboard-scenes");
mkdirSync(output, { recursive: true });
const features = { welcomeEnabled: false, shortDramaEnabled: true, taskCenterEnabled: true, creditsEnabled: false, customChannelsEnabled: false, frontendModelsEnabled: false, pluginCenterEnabled: false };
const fixtures: Record<string, unknown> = {
    "/auth/session": { user: { id: "canvas-benchmark", username: "fixture", role: "user", status: "active" }, features },
    "/features": { features }, "/channels/system": { channels: [] }, "/plugins": { plugins: [], states: [] },
    "/plugins/status": { statuses: {}, states: {} }, "/skills/added": { skills: [] }, "/skills/presets": { presets: [] },
    "/public/appearance": { appearance: {} }, "/agent/profile": { revision: "1", hash: "fixture", layers: [] },
    "/skills": { skills: [], total: 0 }, "/announcements": { announcements: [], unreadCount: 0 }, "/banner-announcements": { banners: [] },
    "/assets": { assets: [], total: 0, hasMore: false, kindCounts: {}, categoryCounts: {}, folderCounts: {}, page: 1, pageSize: 50 },
    "/projects": { projects: [], total: 0 }, "/settings/prompt-templates": { preferences: [] }, "/model-catalog": { source: "system", channels: [] },
};
let project: any;
const runs = new Map<string, any>();
const controls: Array<{ id: string; action: string }> = [];
const report = { passed: [] as string[], errors: [] as string[], blocked: [] as string[] };
const check = (value: unknown, label: string) => { if (!value) throw new Error(label); report.passed.push(label); };
const reply = (data: unknown, status = 200) => Response.json({ code: status === 200 ? 0 : status, data, msg: status === 200 ? "" : "isolated fixture" }, { status });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/")) {
        const api = path.slice(4);
        if (request.method === "GET" && api in fixtures) return reply(fixtures[api]);
        if (api === `/canvas-projects/${project?.id}`) {
            if (request.method === "PUT") project = { ...(await request.json()).project, revision: project.revision + 1 };
            return reply({ project });
        }
        if (api === "/user-data/snapshot") return reply({ projects: [project], assets: [] });
        if (api.endsWith("/history")) return reply({ snapshots: [], currentRevision: project.revision });
        if (api.endsWith("/tasks/reconcile")) return reply({ accepted: true });
        if (api === "/tasks" && request.method === "GET") return reply([]);
        if (api === "/assets/batch") return reply({ assets: [] });
        if (api.startsWith("/assets/") && request.method === "PUT") return reply({ asset: (await request.json()).asset });
        const match = api.match(/^\/agent\/runs\/([^/]+)(\/production-control)?$/);
        if (match && runs.has(match[1])) {
            const run = runs.get(match[1]);
            if (match[2] && request.method === "POST") {
                const input = await request.json(); controls.push({ id: run.id, action: input.action });
                run.status = "running"; run.failureMessage = ""; run.production.paused = input.action === "pause";
                const node = project.nodes.find((entry: any) => entry.id === run.production.targetNodeId);
                Object.assign(node.metadata, { status: "loading", errorDetails: undefined });
                return reply({ accepted: true });
            }
            return reply({ run });
        }
        report.blocked.push(`${request.method} ${api}`); return reply(null, 501);
    }
    const file = resolve(dist, `.${decodeURIComponent(path)}`);
    if (file !== dist && !file.startsWith(dist + sep)) return new Response(null, { status: 403 });
    return new Response(file !== dist && await Bun.file(file).exists() ? Bun.file(file) : Bun.file(join(dist, "index.html")), { headers: { "Cache-Control": "no-store", "Content-Security-Policy": "connect-src 'self' blob:; img-src 'self' data: blob:; media-src 'self' data: blob:" } });
} });
const origin = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
try {
    for (const theme of ["dark", "light"]) {
        const fixture = workflowImageFixture();
        const result = createWorkflowDocuments({ ...fixture.request, step: "direction.shots", model: "fixture::text", sourceNodeIds: defaultWorkflowSources("direction.shots", fixture.request.pipelineId, fixture.nodes).filter(Boolean) }, fixture.nodes, fixture.connections, { x: 0, y: 0 });
        const frame = result.nodes.find((node) => node.id === result.created[0].parentId)!;
        for (const node of result.nodes) { node.position = { x: node.position.x + 5000, y: node.position.y }; if (node.metadata?.shortDrama) node.metadata.shortDrama.productionAgent = undefined; }
        frame.position = { x: 100, y: 100 };
        runs.clear(); controls.length = 0;
        for (const [index, node] of result.created.entries()) {
            node.position = { x: 124 + index * 424, y: 200 };
            node.metadata!.shortDrama!.submission = "submitted";
            node.metadata!.shortDrama!.productionAgent = { runId: `story-run-${index}` };
            Object.assign(node.metadata!, { content: `S${index + 1}-001 已保存的镜头正文`, status: index === 0 ? "error" : "loading", errorDetails: index === 0 ? "测试中断，已保存镜头可恢复" : undefined, taskStage: `分镜已完成 ${index + 1}/6 场` });
            runs.set(`story-run-${index}`, { id: `story-run-${index}`, canvasId: "benchmark-100-spread", status: index === 0 ? "failed" : "running", model: "fixture", failureMessage: index === 0 ? "测试中断，已保存镜头可恢复" : "", events: [{ seq: 1, eventId: `progress-${index}`, runId: `story-run-${index}`, type: "production_progress", payload: { text: `仅第${index + 1}集的保存记录` }, createdAt: new Date().toISOString() }], production: { workKind: "storyboard", targetNodeId: node.id, processedPages: index + 1, totalPages: 6, artifactCount: (index + 1) * 8, paused: false, waitingForBoundary: false, validated: false } });
        }
        project = { ...createCanvasPerformanceProject(100, "spread"), nodes: result.nodes, connections: result.connections, projectId: "", appearance: { mode: theme }, viewport: { x: 0, y: 0, k: 0.8 } };
        const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, serviceWorkers: "block" });
        await context.addInitScript((value: string) => localStorage.setItem("infinite-canvas:canvas-theme", JSON.stringify({ state: { theme: value }, version: 0 })), theme);
        await context.route("**/*", (route: any) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        const page = await context.newPage(); page.setDefaultTimeout(15000);
        page.on("pageerror", (error: Error) => report.errors.push(error.message));
        await page.goto(`${origin}/canvas/${project.id}`);
        await page.locator(`[data-node-id="${frame.id}"]`).first().getByRole("button", { name: "查看分组任务详情", exact: true }).click();
        const container = page.getByLabel("制作执行进度", { exact: true });
        await container.waitFor();
        check(await container.getByRole("button", { name: "执行记录", exact: true }).count() === 2, `${theme}: container links to both independent episode runs`);
        await container.getByRole("button", { name: "执行记录", exact: true }).first().click();
        let details = page.getByRole("region", { name: "制作任务执行记录", exact: true });
        await details.waitFor(); await details.getByText("已完成 1/6 场 · 已保存 8 镜头", { exact: true }).waitFor();
        check(!(await details.innerText()).includes("仅第2集"), `${theme}: detail does not merge other episode logs`);
        await details.getByRole("button", { name: "继续任务", exact: true }).click();
        await page.waitForFunction(() => document.querySelector('.production-agent-status')?.textContent === "后台执行中");
        check(controls.length === 1 && controls[0].id === "story-run-0" && controls[0].action === "resume", `${theme}: resume controls the original run`);
        check(project.nodes.find((node: any) => node.id === result.created[0].id).metadata.content.includes("S1-001"), `${theme}: resume preserves saved shots`);
        await details.getByText("最早在前", { exact: true }).click();
        await page.screenshot({ path: join(output, `${theme}-details.png`), animations: "disabled" });
        await page.setViewportSize({ width: 390, height: 720 });
        check(await details.evaluate((element: HTMLElement) => element.scrollWidth <= element.clientWidth + 1), `${theme}: detail has no horizontal overflow`);
        await page.screenshot({ path: join(output, `${theme}-narrow.png`), animations: "disabled" });
        await page.reload();
        check(runs.get("story-run-0").status === "running", `${theme}: reload leaves the resumed run active`);
        await context.close();
    }
    check(report.errors.length === 0, "no page errors");
    check(!report.blocked.some((entry) => entry === "POST /agent/runs" || entry === "POST /tasks"), "no new model or generation requests");
} finally {
    await browser.close(); server.stop(true);
    writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
}
