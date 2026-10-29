import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { createCanvasPerformanceProject } from "../test/fixtures/canvas-performance-project";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const output = resolve("../.local/canvas-benchmark/connection-flow"), dist = resolve("dist");
mkdirSync(output, { recursive: true });
const report = { passed: [] as string[], errors: [] as string[], blocked: [] as string[] };
const check = (condition: boolean, label: string) => { if (!condition) throw new Error(label); report.passed.push(label); };
const features = { welcomeEnabled: false, shortDramaEnabled: true, taskCenterEnabled: true, creditsEnabled: false, customChannelsEnabled: false, frontendModelsEnabled: false, pluginCenterEnabled: false };
const fixtures: Record<string, unknown> = {
    "/auth/session": { user: { id: "canvas-benchmark", username: "fixture", role: "user", status: "active" }, features },
    "/features": { features }, "/model-catalog": { channels: [], models: [] }, "/channels/system": { channels: [] },
    "/plugins": { plugins: [], states: {} }, "/plugins/status": { statuses: {}, states: {} }, "/skills/added": { skills: [] },
    "/skills/presets": { presets: [] }, "/skills": { skills: [], total: 0 }, "/public/appearance": { appearance: {} },
    "/announcements": { announcements: [], unreadCount: 0 }, "/banner-announcements": { banners: [] }, "/tasks": [],
    "/settings/prompt-templates": { preferences: [] }, "/agent/profile": { revision: "1", hash: "fixture", layers: [] },
    "/assets": { assets: [], total: 0, hasMore: false, kindCounts: {}, categoryCounts: {}, folderCounts: {} },
    "/assets/batch": { assets: [] }, "/projects": { projects: [], total: 0 },
};
let project = createCanvasPerformanceProject(100);
const reply = (data: unknown) => Response.json({ code: 0, data, msg: "" });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/")) {
        const key = path.slice(4);
        if (key === `/canvas-projects/${project.id}`) {
            if (request.method === "PUT") project = { ...(await request.json()).project, revision: (project.revision || 0) + 1 };
            return reply({ project });
        }
        if (key.endsWith("/history")) return reply({ snapshots: [], currentRevision: project.revision });
        if (key === "/user-data/snapshot") return reply({ projects: [project], assets: [] });
        if (key.endsWith("/tasks/reconcile")) return reply({ accepted: true });
        if (key in fixtures && (request.method === "GET" || key === "/assets/batch")) return reply(fixtures[key]);
        report.blocked.push(`${request.method} ${key}`);
        return Response.json({ code: 501, msg: "Isolated fixture blocked request" }, { status: 501 });
    }
    const file = resolve(dist, `.${decodeURIComponent(path)}`);
    if (file !== dist && !file.startsWith(dist + sep)) return new Response(null, { status: 403 });
    return new Response(file !== dist && await Bun.file(file).exists() ? Bun.file(file) : Bun.file(join(dist, "index.html")));
} });
const origin = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
try {
    for (const theme of ["dark", "light"]) for (const mobile of [false, true]) {
        const label = `${theme}-${mobile ? "mobile" : "desktop"}`;
        const nodes: CanvasNodeData[] = [["source", 0, 0], ["above", 0, -300], ["below", 0, 300], ["left", -380, 0], ["right", 380, 0]].map(([id, x, y]) => ({
            id: String(id), title: String(id), type: CanvasNodeType.Text, position: { x: Number(x), y: Number(y) }, width: 200, height: 130,
            metadata: { content: `Node ${id}`, status: "success" },
        }));
        project = { ...createCanvasPerformanceProject(100), projectId: "", nodes, connections: nodes.slice(1).map(node => ({ id: `edge-${node.id}`, fromNodeId: "source", toNodeId: node.id })),
            appearance: { mode: theme as "dark" | "light" }, viewport: mobile ? { x: 160, y: 320, k: 0.35 } : { x: 630, y: 365, k: 0.8 } };
        const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 740 } : { width: 1440, height: 945 }, serviceWorkers: "block", reducedMotion: "no-preference" });
        await context.addInitScript((theme: string) => {
            if (location.protocol === "http:") localStorage.setItem("infinite-canvas:canvas-theme", JSON.stringify({ state: { theme }, version: 0 }));
        }, theme);
        await context.route("**/*", (route: any) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        const page = await context.newPage(); page.setDefaultTimeout(15000);
        page.on("pageerror", (error: Error) => report.errors.push(error.message));
        const underlay = page.locator("[data-canvas-leafer-underlay]");
        const sample = () => underlay.locator("canvas").evaluate((canvas: HTMLCanvasElement & { previousPixels?: Uint8ClampedArray }) => {
            const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
            let changed = 0, nonblank = 0;
            for (let index = 3; index < pixels.length; index += 4) {
                if (pixels[index] > 0) nonblank++;
                if (canvas.previousPixels && Math.abs(pixels[index] - canvas.previousPixels[index]) > 40) changed++;
            }
            canvas.previousPixels = pixels;
            return { changed, nonblank };
        });
        const moves = async (name: string) => {
            await sample(); await page.waitForTimeout(170); const result = await sample();
            check(result.nonblank > 100 && result.changed > 50, `${label}: ${name}`);
        };
        try {
            await page.goto(`${origin}/canvas/${project.id}`);
            await page.locator('[data-connection-id="edge-above"]').waitFor({ state: "attached" });
            await page.waitForTimeout(700);
            await moves("actual canvas pixels visibly move");
            await page.screenshot({ path: join(output, `${label}.png`) });
            check(await page.locator(".canvas-connection-flow").count() === 0, `${label}: main canvas has a single visual renderer`);
            await page.emulateMedia({ reducedMotion: "reduce" }); await page.waitForTimeout(180);
            await sample(); await page.waitForTimeout(200);
            check((await sample()).changed === 0 && await underlay.getAttribute("data-connection-flow") === "paused", `${label}: reduced motion preserves static connections`);
            await page.emulateMedia({ reducedMotion: "no-preference" }); await page.waitForTimeout(150);
            await moves("motion resumes after preference changes");
            await page.evaluate(() => document.documentElement.classList.add("no-motion")); await page.waitForTimeout(150);
            await sample(); await page.waitForTimeout(160);
            check((await sample()).changed === 0 && await underlay.getAttribute("data-connection-flow") === "paused", `${label}: app no-motion pauses animation`);
            await page.evaluate(() => document.documentElement.classList.remove("no-motion")); await page.waitForTimeout(150);
            await moves("motion resumes after app setting changes");
            if (!mobile) {
                for (let index = 0; index < 3; index++) await page.getByRole("button", { name: "缩小画布", exact: true }).click();
                await page.waitForTimeout(350); await moves("flow remains visible at overview zoom");
                const midpoint = await page.locator('[data-connection-id="edge-above"]').evaluate((path: SVGPathElement) => {
                    const point = path.getPointAtLength(path.getTotalLength() / 2).matrixTransform(path.getScreenCTM()!);
                    return { x: point.x, y: point.y };
                });
                await page.mouse.click(midpoint.x, midpoint.y); await page.keyboard.press("Delete"); await page.waitForTimeout(350);
                check(await page.locator('[data-connection-id="edge-above"]').count() === 0, `${label}: connection remains selectable and deletable`);
                await page.keyboard.press("Control+z"); await page.locator('[data-connection-id="edge-above"]').waitFor({ state: "attached" });
                check(await page.locator('[data-connection-id="edge-above"]').count() === 1, `${label}: undo restores connection`);
            }
        } catch (error) { await page.screenshot({ path: join(output, `${label}-failure.png`) }); throw error; }
        finally { await context.close(); }
    }
    check(report.errors.length === 0 && report.blocked.length === 0, "no browser errors or unexpected API calls");
} catch (error) { report.errors.push(String(error)); process.exitCode = 1; }
finally { await browser.close(); server.stop(true); writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }
