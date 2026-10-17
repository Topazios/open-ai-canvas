/** Real canvas route, isolated APIs and no upstream model requests. */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import { createCanvasPerformanceProject } from "../test/fixtures/canvas-performance-project";
import { CanvasNodeType } from "../src/types/canvas";
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const dist = resolve("dist"), output = resolve("../.local/canvas-benchmark/task-details");
mkdirSync(output, { recursive: true });
const base = createCanvasPerformanceProject(100);
base.connections = []; base.viewport = { x: 100, y: 150, k: 1 }; base.projectId = "";
base.nodes = [CanvasNodeType.Text, CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio].map((type, i) => ({ ...base.nodes[0], id: `node-${i}`, type, title: `${type}任务`, position: { x: i * 360, y: 0 }, width: 320, height: 280, metadata: { status: "loading", taskId: `task-${i}`, taskStatus: "running", taskStage: "正在生成", taskCreatedAt: "2026-10-17T00:00:00Z" } }));
let project: any = structuredClone(base), reads = 0, failRead = false, paidRequests = 0;
const task = (id: string) => ({ id, type: "canvas_text", status: "running", operation: id === "task-0" ? "short_drama_batch" : "generate", stage: `当前进度 ${reads}`, prompt: "隔离测试提示词\n".repeat(50), model: "fixture", attempts: 1, createdAt: "2026-10-17T00:00:00Z", startedAt: "2026-10-17T00:05:00Z", updatedAt: "2026-10-17T00:06:00Z" });
const features = { welcomeEnabled: false, shortDramaEnabled: true, taskCenterEnabled: true, creditsEnabled: false, customChannelsEnabled: false, frontendModelsEnabled: false, pluginCenterEnabled: false };
const fixtures: Record<string, unknown> = {
    "/auth/session": { user: { id: "detail-fixture", username: "fixture", role: "user", status: "active" }, features }, "/features": { features },
    "/channels/system": { channels: [] }, "/plugins": { plugins: [], states: {} }, "/plugins/status": { statuses: {}, states: {} },
    "/skills/added": { skills: [] }, "/skills/presets": { presets: [] }, "/public/appearance": { appearance: {} }, "/agent/profile": { revision: "1", hash: "fixture", layers: [] },
    "/skills": { skills: [], total: 0 }, "/announcements": { announcements: [], unreadCount: 0 }, "/banner-announcements": { banners: [] },
    "/assets": { assets: [], total: 0, hasMore: false, kindCounts: {}, categoryCounts: {}, folderCounts: {}, page: 1, pageSize: 50 }, "/projects": { projects: [], total: 0 }, "/settings/prompt-templates": { preferences: [] },
    "/agent/runs": { runs: [] }, "/model-catalog": { source: "system", channels: [] },
};
const report = { passed: [] as string[], errors: [] as string[], blocked: [] as string[] };
const check = (condition: unknown, label: string) => { if (!condition) throw new Error(label); report.passed.push(label); };
const reply = (data: unknown, status = 200) => Response.json({ code: status === 200 ? 0 : status, data, msg: status === 200 ? "" : "隔离读取失败" }, { status });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/")) {
        const api = path.slice(4);
        if (api === `/canvas-projects/${project.id}`) { if (request.method === "PUT") project = { ...(await request.json()).project, revision: project.revision + 1 }; return reply({ project }); }
        if (api in fixtures) return reply(fixtures[api]);
        if (api.endsWith("/history")) return reply({ snapshots: [], currentRevision: project.revision });
        if (api.endsWith("/tasks/reconcile")) return reply({ accepted: true });
        if (api === "/user-data/snapshot") return reply({ projects: [project], assets: [] });
        if (api === "/assets/batch") return reply({ assets: [] });
        if (api === "/tasks" && request.method === "POST") { paidRequests++; return reply(null, 403); }
        if (api === "/tasks") return reply([]);
        if (api.endsWith("/text-events")) return new Response("", { headers: { "Content-Type": "text/event-stream" } });
        if (api.startsWith("/tasks/task-")) {
            const id = api.split("/")[2];
            if (api.endsWith("/execution")) {
                reads++; if (failRead) return reply(null, 503);
                return reply({ task: task(id), unitCount: 2, truncated: false, parameters: { reasoningEffort: "medium" }, events: [], steps: [{ id: `${id}-child`, label: `专属记录 ${id}`, status: "succeeded", createdAt: "2026-10-17T00:05:00Z", startedAt: "2026-10-17T00:05:10Z", completedAt: "2026-10-17T00:06:00Z", outputChars: 4, outputPreview: "实际结果" }] });
            }
            return reply(task(id));
        }
        report.blocked.push(`${request.method} ${api}`); return reply(null, 501);
    }
    const file = resolve(dist, `.${decodeURIComponent(path)}`);
    if (file !== dist && !file.startsWith(dist + sep)) return new Response(null, { status: 403 });
    return new Response(file !== dist && await Bun.file(file).exists() ? Bun.file(file) : Bun.file(join(dist, "index.html")), { headers: { "Cache-Control": "no-store" } });
} });
const origin = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
try {
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
        const context = await browser.newContext({ viewport, serviceWorkers: "block" });
        await context.route("**/*", (route: any) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        const page = await context.newPage(); page.setDefaultTimeout(15000); page.on("pageerror", (error: Error) => report.errors.push(error.message));
        for (let i = 0; i < 4; i++) {
            project = structuredClone(base); project.id = `details-${viewport.width}-${i}`; project.viewport = { x: 35 - i * 360, y: 150, k: 1 }; project.appearance = { mode: i % 2 ? "dark" : "light" }; reads = 0; failRead = false;
            await page.goto(`${origin}/canvas/${project.id}`);
            const node = page.locator(`[data-node-id="node-${i}"]`);
            try { await node.waitFor({ state: "visible" }); } catch (error) { await page.screenshot({ path: join(output, "failure.png") }); console.log(page.url(), await page.locator("body").innerText()); throw error; }
            const toggle = page.getByRole("button", { name: "隐藏短剧导引", exact: true }); if (await toggle.isVisible()) await toggle.click();
            await node.getByRole("button", { name: "详情", exact: true }).click();
            const modal = page.locator(".canvas-node-task-modal:visible"); await modal.getByText(`专属记录 task-${i} · 已完成`, { exact: true }).waitFor();
            check((await modal.innerText()).includes("执行记录"), `${viewport.width}/${i}: unified journal`);
            check(!(await modal.innerText()).includes(`专属记录 task-${(i + 1) % 4}`), `${viewport.width}/${i}: node isolation`);
            const before = reads; await page.waitForFunction(() => document.querySelector(".production-agent-note")?.textContent?.includes("当前进度 2"), { timeout: 10000 });
            check(reads > before, `${viewport.width}/${i}: live polling`);
            await modal.getByText("最早在前", { exact: true }).click();
            check((await modal.locator(".production-agent-event").first().innerText()).includes("任务已提交"), `${viewport.width}/${i}: chronological sort`);
            await modal.locator(".production-agent-parameters > summary").click();
            const scrolls = await modal.evaluate((element: Element) => [...element.querySelectorAll("*")].filter((item) => { const s = getComputedStyle(item); return /auto|scroll/.test(s.overflowY) && item.scrollHeight > item.clientHeight + 2; }).length);
            check(scrolls === 1, `${viewport.width}/${i}: single vertical scroll (${scrolls})`);
            check(await modal.evaluate((element: Element) => element.scrollWidth <= element.clientWidth + 2), `${viewport.width}/${i}: no horizontal overflow`);
            await page.screenshot({ path: join(output, `${viewport.width}-${i}.png`), animations: "disabled" });
            if (i === 0) { failRead = true; await modal.getByRole("alert").waitFor(); check((await modal.innerText()).includes("专属记录 task-0"), `${viewport.width}: transient failure keeps snapshot`); failRead = false; await modal.getByRole("button", { name: "刷新执行记录", exact: true }).click(); await modal.getByRole("alert").waitFor({ state: "hidden" }); }
            await page.keyboard.press("Escape"); await modal.waitFor({ state: "hidden" });
            const stopped = reads; await page.waitForTimeout(3300); check(reads === stopped, `${viewport.width}/${i}: polling stopped on close`);
        }
        await context.close();
    }
    check(paidRequests === 0, "no paid generation calls"); check(report.errors.length === 0, "no page errors");
} catch (error) { report.errors.push(String(error)); process.exitCode = 1; }
finally { writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); await browser.close(); server.stop(true); }
