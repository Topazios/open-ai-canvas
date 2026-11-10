/** Exercise the real canvas UI and scheduler against in-memory APIs, never a model. */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import { createCanvasNode, createStoryboardRow } from "../src/lib/canvas/canvas-project-domain";
import { createCanvasPerformanceProject } from "../test/fixtures/canvas-performance-project";
import { CanvasNodeType } from "../src/types/canvas";
import { defaultModelCapabilityConfig } from "../src/lib/model-capabilities";

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const dist = resolve("dist"), output = resolve("../.local/canvas-benchmark/selected-frames");
mkdirSync(output, { recursive: true });
const features = { welcomeEnabled: false, shortDramaEnabled: true, taskCenterEnabled: true, creditsEnabled: false, customChannelsEnabled: false, frontendModelsEnabled: false, pluginCenterEnabled: false };
const fixtures: Record<string, unknown> = {
    "/auth/session": { user: { id: "selected-frames-qa", username: "fixture", role: "user", status: "active" }, features, runtimeLimits: { activeTaskLimit: 0, resourceUploadMB: 50, concurrency: { image: 20, text: 10, agent: 4, video: 2, audio: 3, other: 2, channel: 30, customRelay: 20, imagePreparation: 10, resourceDownload: 4, upload: 4, mediaRecovery: 2, agentSessions: 4 } } },
    "/features": { features }, "/channels/system": { channels: [] }, "/plugins": { plugins: [], states: {} }, "/plugins/status": { statuses: {}, states: {} },
    "/skills/added": { skills: [] }, "/skills/presets": { presets: [] }, "/skills": { skills: [], total: 0 }, "/public/appearance": { appearance: {} },
    "/announcements": { announcements: [], unreadCount: 0 }, "/banner-announcements": { banners: [] }, "/settings/prompt-templates": { preferences: [] },
    "/agent/profile": { revision: "1", hash: "fixture", layers: [] }, "/projects": { projects: [], total: 0 },
    "/assets": { assets: [], total: 0, hasMore: false, kindCounts: {}, categoryCounts: {}, folderCounts: {} }, "/assets/batch": { assets: [] },
    "/model-catalog": { source: "system", channels: [{ id: "fixture", displayName: "Fixture", models: [
        { id: "image", modelKey: "image", displayName: "Fixture image", capability: "image", protocol: "openai-image", capabilityConfig: defaultModelCapabilityConfig("openai-image"), available: true, priceTiers: [] },
        { id: "text", modelKey: "text", displayName: "Fixture text", capability: "text", protocol: "openai-responses", capabilityConfig: defaultModelCapabilityConfig("openai-responses"), available: true, priceTiers: [] },
    ] }] },
};
let project: any;
const tasks = new Map<string, any>(), requests: any[] = [];
const report = { passed: [] as string[], errors: [] as string[], blocked: [] as string[] };
const check = (ok: unknown, label: string) => { if (!ok) throw new Error(label); report.passed.push(label); };
const reply = (data: unknown) => Response.json({ code: 0, data, msg: "" });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/")) {
        const key = path.slice(4);
        if (request.method === "GET" && key in fixtures) return reply(fixtures[key]);
        if (key === `/canvas-projects/${project.id}`) {
            if (request.method === "PUT") project = { ...(await request.json()).project, revision: project.revision + 1 };
            return reply({ project });
        }
        if (key === "/user-data/snapshot") return reply({ projects: [project], assets: [] });
        if (key.endsWith("/history")) return reply({ snapshots: [], currentRevision: project.revision });
        if (key.endsWith("/tasks/reconcile")) return reply({ accepted: true });
        if (key.endsWith("/task-events")) return new Response(": fixture\n\n", { headers: { "Content-Type": "text/event-stream" } });
        if (key.startsWith("/assets/") && request.method === "PUT") return reply({ asset: (await request.json()).asset });
        if (key === "/tasks" && request.method === "POST") {
            const input = await request.json(); requests.push(input);
            const task = { id: `task-${requests.length}`, projectId: project.id, type: input.type, operation: input.operation, status: "running", stage: "测试任务", prompt: input.prompt, model: input.model, attempts: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), clientOperationId: input.clientOperationId || input.input?.metadata?.clientOperationId, clientContext: { nodeId: input.input?.metadata?.nodeId } };
            tasks.set(task.id, task);
            return reply(task);
        }
        if (key === "/tasks") return reply([...tasks.values()].filter(task => !new URL(request.url).searchParams.get("activeOnly") || task.status === "running"));
        const taskId = key.match(/^\/tasks\/([^/]+)$/)?.[1];
        if (taskId && tasks.has(taskId)) return reply(tasks.get(taskId));
        report.blocked.push(`${request.method} ${key}`);
        return Response.json({ code: 501, msg: "Unexpected fixture request" }, { status: 501 });
    }
    const pathOnDisk = resolve(dist, `.${decodeURIComponent(path)}`);
    if (pathOnDisk !== dist && !pathOnDisk.startsWith(dist + sep)) return new Response(null, { status: 403 });
    return new Response(pathOnDisk !== dist && await Bun.file(pathOnDisk).exists() ? Bun.file(pathOnDisk) : Bun.file(join(dist, "index.html")));
} });
const origin = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
let page: any;
try {
    for (const theme of ["dark", "light"]) {
        tasks.clear(); requests.length = 0;
        const rows = [1, 2, 3, 4].map(number => createStoryboardRow(number, { id: `row-${number}`, sceneId: number < 3 ? "S01" : "S02", shotCode: `S0${number < 3 ? 1 : 2}-00${number < 3 ? number : number - 2}`, durationSeconds: 12, videoMotionPrompt: `人物在房间放下相机，镜头${number}` }));
        const script = createCanvasNode(CanvasNodeType.Script, { x: 0, y: 0 }, { status: "success", storyboard: { rows, visibleColumns: [], referenceNodeIds: [] }, shortDrama: { pipelineId: "p", stage: "storyboard", step: "direction.shots", role: "document", sourceNodeIds: [], sourceSignatures: {}, submission: "submitted", episodeNumber: 1 } });
        script.width = 1280; script.height = 680; script.position = { x: 0, y: 0 };
        project = { ...createCanvasPerformanceProject(100), id: `selected-frames-${theme}`, nodes: [script], connections: [], viewport: { x: 100, y: 100, k: 0.9 }, appearance: { mode: theme } };
        const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: "block" });
        await context.addInitScript((value: string) => localStorage.setItem("infinite-canvas:canvas-theme", JSON.stringify({ state: { theme: value }, version: 0 })), theme);
        await context.route("**/*", (route: any) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        page = await context.newPage(); page.setDefaultTimeout(15000);
        page.on("pageerror", (error: Error) => report.errors.push(error.message));
        await page.goto(`${origin}/canvas/${project.id}`);
        const guide = page.getByRole("button", { name: "短剧流程", exact: true });
        await guide.waitFor();
        if (await guide.getAttribute("aria-pressed") === "true") await guide.click();
        const timeline = page.getByRole("region", { name: "分集视频分镜时间线" });
        const generate = timeline.getByRole("button", { name: "生成选中", exact: true });
        await generate.waitFor();
        check(await generate.isDisabled(), `${theme}: empty selection cannot submit`);
        const firstScene = timeline.locator('.timeline-frame-cell > .canvas-episode-frame-gallery > .canvas-episode-frame-item');
        for (let index = 0; index < 5; index++) await firstScene.nth(index).getByRole("checkbox").check();
        check(await timeline.locator('.canvas-episode-frame-item.is-selected').count() === 5, `${theme}: five frame slots checked`);
        await generate.click();
        const confirmation = page.getByRole("dialog");
        const content = await confirmation.innerText();
        check(content.includes("S01-001") && content.includes("S01-002") && !content.includes("S02-"), `${theme}: confirmation names only selected shots`);
        await page.waitForTimeout(300);
        await page.screenshot({ path: join(output, `${theme}-confirmation.png`), animations: "disabled" });
        await confirmation.getByRole("button", { name: "确认生成", exact: true }).click();
        for (let i = 0; i < 60 && requests.length < 5; i++) await page.waitForTimeout(250);
        const requestedBindings = () => requests.map(input => {
            const node = project.nodes.find((node: any) => node.id === input.input?.metadata?.nodeId);
            return node?.metadata?.storyboardFrame || node?.metadata?.storyboardFramePlan;
        });
        check(requests.length === 5, `${theme}: initial batch has three shared boundaries and two key plans`);
        check(requestedBindings().every(binding => binding && ["row-1", "row-2"].includes(binding.rowId)), `${theme}: submission targets only the two selected rows`);
        for (const task of tasks.values()) if (task.type === "canvas_text") Object.assign(task, { status: "succeeded", resultJson: JSON.stringify({ mode: "text", text: JSON.stringify({ frames: [{ timeSeconds: 3, prompt: "人物抬起相机" }, { timeSeconds: 8, prompt: "人物放下相机" }] }) }), updatedAt: new Date().toISOString() });
        for (let i = 0; i < 100 && requests.length < 9; i++) await page.waitForTimeout(250);
        check(requests.length === 9, `${theme}: selected key plans continue exactly four images`);
        check(requestedBindings().every(binding => binding && ["row-1", "row-2"].includes(binding.rowId)), `${theme}: no later scene tasks after automatic continuation`);
        const firstCell = timeline.locator('.timeline-frame-cell').first();
        check(await firstCell.locator('.canvas-episode-frame-item').count() === 3, `${theme}: multiple keyframes occupy one stack between boundaries`);
        check(await firstCell.locator('.canvas-storyboard-image-stack-count').innerText() === "2", `${theme}: stack reports both extracted keys`);
        await firstCell.getByRole("button", { name: "展开 关键帧", exact: true }).click();
        const panel = page.locator('.canvas-episode-keyframe-panel:visible');
        await panel.waitFor();
        await panel.getByRole("checkbox").nth(1).waitFor();
        check(await panel.locator('.canvas-episode-frame-item').count() === 2, `${theme}: opening stack reveals both individual keys`);
        await panel.getByRole("checkbox").first().uncheck();
        check(await firstCell.locator('.ant-checkbox-indeterminate').count() === 1, `${theme}: individual selection produces mixed stack state`);
        check(await panel.getByRole("checkbox").nth(1).isChecked(), `${theme}: deselecting one key preserves its sibling`);
        await page.screenshot({ path: join(output, `${theme}-keyframe-stack-open.png`), animations: "disabled" });
        await panel.getByRole("button", { name: "收起关键帧", exact: true }).click();
        await panel.waitFor({ state: "hidden" });
        await firstCell.getByRole("checkbox", { name: "选择镜头 01 全部关键帧", exact: true }).check();
        check(await firstCell.locator('.canvas-episode-keyframe-selection').innerText() === "2/2", `${theme}: stack checkbox selects its exact group`);
        const expandedWidth = await firstCell.evaluate((element: HTMLElement) => element.getBoundingClientRect().width);
        check(expandedWidth < 350, `${theme}: shot width does not expand with keyframe count`);
        await page.screenshot({ path: join(output, `${theme}-generated-selection.png`), animations: "disabled" });
        await timeline.getByRole("button", { name: /^缩\s*略$/ }).click();
        const compactWidth = await firstCell.evaluate((element: HTMLElement) => element.getBoundingClientRect().width);
        check(compactWidth < expandedWidth, `${theme}: compact mode reduces stack and column together`);
        await firstCell.getByRole("button", { name: "展开 关键帧", exact: true }).click();
        await panel.waitFor();
        await panel.getByRole("button", { name: "收起关键帧", exact: true }).focus();
        await page.keyboard.press("Escape");
        await panel.waitFor({ state: "hidden" });
        check(true, `${theme}: keyboard escape closes expanded stack`);
        await page.screenshot({ path: join(output, `${theme}-keyframe-stack-compact.png`), animations: "disabled" });
        await page.reload();
        await page.getByRole("region", { name: "分集视频分镜时间线" }).waitFor();
        await page.waitForTimeout(2500);
        check(requests.length === 9, `${theme}: reload neither broadens nor repeats the batch`);
        await context.close();
    }
    check(!report.errors.length && !report.blocked.length, "no page errors or unexpected API calls");
} catch (error) {
    if (page && !page.isClosed()) {
        await page.screenshot({ path: join(output, "failure.png") });
        writeFileSync(join(output, "failure.txt"), await page.locator("body").innerText());
    }
    throw error;
} finally {
    writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    await browser.close(); server.stop(true);
}
