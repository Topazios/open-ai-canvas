/** Real canvas route with isolated APIs; all task results are synthetic. Run from web/. */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { createShortDramaPipeline } from "../src/lib/canvas/canvas-short-drama";
import { createWorkflowDocuments, nodeWorkflow } from "../src/lib/canvas/canvas-short-drama-workflow";
import { defaultShortDramaSettings } from "../src/lib/short-drama-settings";
import { CanvasNodeType } from "../src/types/canvas";
import { createCanvasPerformanceProject } from "../test/fixtures/canvas-performance-project";
import { completeUnifiedWorkflowPlan } from "../test/fixtures/workflow-plan";

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || resolve("../.local/canvas-tools/node_modules/playwright"));
const dist = resolve("dist"), output = resolve("../.local/canvas-benchmark/workflow-episodes");
if (!await Bun.file(join(dist, "index.html")).exists()) throw new Error("Build web/dist before running this script.");
mkdirSync(output, { recursive: true });
let project: any, requests: any[] = [], tasks: any[] = [], resultText = "";
const report = { passed: [] as string[], errors: [] as string[], blocked: [] as string[] };
const check = (condition: unknown, label: string) => { if (!condition) throw new Error(label); report.passed.push(label); };
const features = { welcomeEnabled: false, shortDramaEnabled: true, taskCenterEnabled: true, creditsEnabled: false, customChannelsEnabled: false, frontendModelsEnabled: false, pluginCenterEnabled: false };
const fixtures: Record<string, unknown> = {
    "/auth/session": { user: { id: "episodes-fixture", username: "fixture", role: "user", status: "active" }, features },
    "/features": { features }, "/channels/system": { channels: [] }, "/plugins": { plugins: [], states: {} }, "/plugins/status": { statuses: {}, states: {} },
    "/skills/added": { skills: [] }, "/skills/presets": { presets: [] }, "/public/appearance": { appearance: {} }, "/agent/profile": { revision: "1", hash: "fixture", layers: [] },
    "/skills": { skills: [], total: 0 }, "/announcements": { announcements: [], unreadCount: 0 }, "/banner-announcements": { banners: [] },
    "/assets": { assets: [], total: 0, hasMore: false, kindCounts: {}, categoryCounts: {}, folderCounts: {}, page: 1, pageSize: 50 },
    "/projects": { projects: [], total: 0 }, "/settings/prompt-templates": { preferences: [] }, "/agent/runs": { runs: [] },
    "/model-catalog": { source: "system", channels: [{ id: "fixture", displayName: "Fixture", models: [
        { id: "text", modelKey: "text", displayName: "Fixture text", capability: "text", protocol: "chat-completion", available: true, priceTiers: [] },
    ] }] },
};
const reply = (data: unknown, status = 200) => Response.json({ code: status === 200 ? 0 : status, data, msg: status === 200 ? "" : "isolated fixture" }, { status });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname, method = request.method;
    if (path.startsWith("/api/")) {
        const api = path.slice(4);
        if (api === `/canvas-projects/${project?.id}`) {
            if (method === "PUT") {
                const input = await request.json();
                if (input.project.revision !== project.revision) return reply(null, 409);
                project = { ...input.project, revision: project.revision + 1 };
                return reply({ project });
            }
            if (method === "GET") return reply({ project });
        }
        if (method === "GET" && api in fixtures) return reply(fixtures[api]);
        if (method === "GET" && api.endsWith("/history")) return reply({ snapshots: [], currentRevision: project.revision });
        if (method === "POST" && api === `/canvas-projects/${project?.id}/tasks/reconcile`) return reply({ accepted: true });
        if (method === "GET" && api === "/user-data/snapshot") return reply({ projects: [project], assets: [] });
        if (method === "POST" && api === "/assets/batch") return reply({ assets: [] });
        if (method === "POST" && api === "/tasks") {
            const input = await request.json(); requests.push(input);
            const metadata = input.input?.metadata;
            if (input.type !== "canvas_text" || metadata?.workflowStep !== "story.episodes") {
                report.errors.push("Unexpected task submission"); return reply(null, 403);
            }
            const task = { id: `episodes-task-${tasks.length + 1}`, projectId: project.id, type: input.type, status: "running", operation: input.operation,
                prompt: input.prompt, model: input.model, attempts: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
                resultJson: JSON.stringify({ text: resultText }), clientOperationId: input.clientOperationId || metadata.clientOperationId,
                clientContext: { nodeId: metadata.nodeId, clientOperationId: input.clientOperationId || metadata.clientOperationId } };
            tasks.push(task); return reply(task);
        }
        if (method === "GET" && api === "/tasks") return reply(tasks);
        if (method === "GET" && /^\/tasks\/episodes-task-\d+\/text-events$/.test(api)) return new Response("", { headers: { "Content-Type": "text/event-stream" } });
        if (method === "GET" && /^\/tasks\/episodes-task-\d+$/.test(api)) return reply(tasks.find((task) => task.id === api.split("/")[2]));
        report.blocked.push(`${method} ${api}`); return reply(null, 501);
    }
    if (method !== "GET") { report.blocked.push(`${method} ${path}`); return new Response(null, { status: 405 }); }
    const file = resolve(dist, `.${decodeURIComponent(path)}`);
    if (file !== dist && !file.startsWith(dist + sep)) return new Response(null, { status: 403 });
    return new Response(file !== dist && await Bun.file(file).exists() ? Bun.file(file) : Bun.file(join(dist, "index.html")), {
        headers: { "Cache-Control": "no-store", "Content-Security-Policy": "connect-src 'self' blob:; img-src 'self' data: blob:; media-src 'self' data: blob:" },
    });
} });
const origin = `http://127.0.0.1:${server.port}`;
let browser: any;
try {
    browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    for (const scenario of [{ theme: "dark", total: 6, width: 1440, height: 1000 }, { theme: "light", total: 12, width: 390, height: 844 }]) {
        const label = `${scenario.theme}/${scenario.width}/${scenario.total}`;
        const pipeline = createShortDramaPipeline({ x: 0, y: 0 }, true);
        pipeline.nodes[0].metadata!.content = "林岚回到旧照相馆，寻找家人留下的秘密。";
        const globalSettings = { ...defaultShortDramaSettings(), episodeCount: scenario.total };
        const plan = createWorkflowDocuments({ step: "story.plan", pipelineId: nodeWorkflow(pipeline.nodes[0])!.pipelineId,
            sourceNodeIds: [pipeline.storyNodeId], model: "fixture::text", instruction: "", episodeCount: scenario.total,
            minutesPerEpisode: "2", start: 1, count: 1, globalSettings }, pipeline.nodes, pipeline.connections, { x: 0, y: 0 });
        const { frame } = completeUnifiedWorkflowPlan(plan);
        for (const node of plan.nodes) if (nodeWorkflow(node)) { nodeWorkflow(node)!.productionAgent = undefined; nodeWorkflow(node)!.submission = "submitted"; }
        project = { ...createCanvasPerformanceProject(100), id: `episodes-${scenario.width}`, projectId: "", nodes: plan.nodes, connections: plan.connections,
            globalSettings, appearance: { mode: scenario.theme }, viewport: { x: 60 - frame.position.x * 0.65, y: 150 - frame.position.y * 0.65, k: 0.65 } };
        const originalIds = new Set(project.nodes.map((node: any) => node.id));
        const originalContent = new Map(project.nodes.map((node: any) => [node.id, node.metadata?.content]));
        requests = []; tasks = [];
        resultText = Array.from({ length: scenario.total }, (_, index) => `第 ${index + 1} 集\n隔离测试集纲 ${index + 1}：冲突、转折和结尾。`).join("\n\n");
        const context = await browser.newContext({ viewport: { width: scenario.width, height: scenario.height }, serviceWorkers: "block" });
        await context.route("**/*", (route: any) => {
            if (new URL(route.request().url()).origin === origin) return route.continue();
            report.blocked.push(`external ${route.request().method()} ${new URL(route.request().url()).origin}`); return route.abort();
        });
        const page = await context.newPage(); page.setDefaultTimeout(15000);
        page.on("pageerror", (error: Error) => report.errors.push(error.message));
        const wait = async (predicate: () => boolean, message: string) => {
            const deadline = Date.now() + 20000;
            while (!predicate() && Date.now() < deadline) await page.waitForTimeout(100);
            check(predicate(), `${label}: ${message}`);
        };
        try {
            await page.goto(`${origin}/canvas/${project.id}`);
            const toggle = page.getByRole("button", { name: "短剧流程", exact: true }); await toggle.waitFor();
            if (await toggle.getAttribute("aria-pressed") === "false") await toggle.click();
            const guide = page.getByRole("region", { name: "短剧完整制作流程", exact: true });
            await guide.getByRole("combobox", { name: "短剧制作阶段" }).selectOption("story");
            await guide.locator('[data-task-key="story.episodes"] button').click();
            const panel = page.locator(".canvas-workflow-generator"); await panel.waitFor();
            check((await panel.getByLabel("集纲生成范围", { exact: true }).innerText()).trim() === `第 1–${scenario.total} 集 · 1 个集纲节点`, `${label}: full-series range and one output node`);
            check(await panel.getByRole("spinbutton", { name: /起始集数|本次生成集数/ }).count() === 0, `${label}: no per-episode range controls`);
            check(await panel.evaluate((element: HTMLElement) => { const rect = element.getBoundingClientRect(); return element.scrollWidth <= element.clientWidth + 1 && rect.left >= 0 && rect.right <= innerWidth + 1; }), `${label}: form fits viewport`);
            await panel.getByRole("button", { name: "选择模型", exact: true }).click();
            const picker = page.locator(".canvas-model-picker-menu:visible");
            if (await picker.locator(".canvas-model-picker-brands").count()) await picker.locator(".canvas-model-picker-brand").first().click();
            await picker.locator(".canvas-model-picker-option").first().click(); await picker.waitFor({ state: "hidden" });
            await page.screenshot({ path: join(output, `${scenario.width}-range.png`), animations: "disabled" });
            const submit = panel.getByRole("button", { name: "生成全剧集纲", exact: true });
            check(await submit.isEnabled(), `${label}: full-series generation enabled`);
            await submit.click(); await panel.waitFor({ state: "hidden" });
            await wait(() => requests.length > 0, "fixture received outline submission");
            const added = () => project.nodes.filter((node: any) => !originalIds.has(node.id));
            check(added().length === 1 && added()[0].type === CanvasNodeType.Text, `${label}: submission persists exactly one new text node and no container`);
            const outlineId = added()[0].id;
            const data = nodeWorkflow(added()[0])!;
            check(data.step === "story.episodes" && data.role === "document" && data.episodeNumber == null && data.parameters?.episodeCount === scenario.total, `${label}: outline metadata covers the whole series`);
            check(data.sourceNodeIds.includes(frame.id) && project.connections.some((edge: any) => edge.fromNodeId === frame.id && edge.toNodeId === outlineId), `${label}: selected plan remains linked`);
            check(requests.every((input) => input.input.metadata.nodeId === outlineId), `${label}: all submitted work targets the same text node`);
            check(requests.some((input) => input.prompt?.includes(`第 1–${scenario.total} 集`) && input.prompt.includes("同一份文稿")), `${label}: prompt requests all episodes in one document`);
            for (const task of tasks) task.status = "succeeded";
            await wait(() => added()[0]?.metadata?.status === "success" && added()[0]?.metadata?.content === resultText, "all synthetic episode sections saved in the one text node");
            const submissions = requests.length;
            await page.reload(); await page.locator(`[data-node-id="${outlineId}"]`).waitFor({ state: "visible" });
            await page.waitForTimeout(3500);
            check(requests.length === submissions && added().length === 1 && added()[0].id === outlineId && added()[0].metadata.content === resultText, `${label}: reload preserves one complete outline without duplicate submission`);
            check([...originalContent].every(([id, content]) => project.nodes.find((node: any) => node.id === id)?.metadata?.content === content), `${label}: source content preserved`);
            await page.screenshot({ path: join(output, `${scenario.width}-complete.png`), animations: "disabled" });
        } catch (error) {
            await page.screenshot({ path: join(output, `${scenario.width}-failure.png`), animations: "disabled" }).catch(() => {});
            throw error;
        } finally { await context.close(); }
    }
    check(report.errors.length === 0, "no browser runtime errors");
    check(!report.blocked.some((entry) => /^(POST|PUT|PATCH|DELETE) /.test(entry)), "no unhandled write or agent requests");
} catch (error) { report.errors.push(String(error)); process.exitCode = 1; }
finally {
    await browser?.close(); server.stop(true);
    writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
}
