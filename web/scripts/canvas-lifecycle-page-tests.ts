/** Trusted browser actions against the isolated production app, never the real backend. */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const origin = process.env.CANVAS_TEST_ORIGIN || "http://127.0.0.1:4011";
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error("Only the isolated loopback fixture is allowed");
const session = await (await fetch(`${origin}/api/auth/session`)).json();
if (session.data?.user?.id !== "canvas-benchmark") throw new Error("Refusing to edit a non-fixture canvas");
const output = resolve(process.env.CANVAS_TEST_REPORT_DIR || "../.local/canvas-benchmark/lifecycle-page-tests");
mkdirSync(output, { recursive: true });
const report: { passed: string[]; errors: string[]; failure?: string } = { passed: [], errors: [] };
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on("pageerror", (error: Error) => report.errors.push(error.message));
const projectPath = "/api/canvas-projects/benchmark-100-spread";
const getProject = async () => (await (await fetch(origin + projectPath)).json()).data.project;
const initial = await getProject();
const resetCamera = async () => {
    const project = await getProject();
    const response = await fetch(origin + projectPath, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project: { ...project, viewport: { x: 60, y: 80, k: 0.6 } } }) });
    if (!response.ok) throw new Error("Fixture camera reset failed");
};
const visit = async () => {
    await page.goto(`${origin}/canvas/benchmark-100-spread?canvasDiagnostics=1`);
    await page.waitForSelector('[data-node-id="bench-13"]');
};
const panPoint = async (targetPage = page) => {
    const point = await targetPage.evaluate(() => {
        const root = document.querySelector<HTMLElement>("[data-canvas-viewport]")!;
        const rect = root.getBoundingClientRect();
        for (let y = rect.top + 100; y < Math.min(innerHeight - 100, rect.bottom); y += 24) {
            for (let x = rect.left + 100; x < Math.min(innerWidth - 100, rect.right); x += 24) {
                const target = document.elementFromPoint(x, y);
                const node = target?.closest("[data-node-id]");
                if (target?.closest("[data-canvas-viewport]") !== root || target.closest("button,input,textarea,[contenteditable],svg,[data-canvas-no-zoom],[data-canvas-wheel-scroll]")) continue;
                if (node && !node.querySelector(".canvas-frame-shell")) continue;
                return { x, y };
            }
        }
        throw new Error("No unobstructed canvas wheel target");
    });
    await targetPage.mouse.move(point.x, point.y);
};
try {
    await resetCamera(); await visit();
    const text = page.locator('[data-node-id="bench-13"]');
    await text.getByRole("button", { name: /^编辑节点名称：/ }).click();
    const input = text.getByRole("textbox", { name: "节点名称" });
    await input.fill("生产页面中文草稿");
    await panPoint();
    await page.keyboard.down("Control"); await page.mouse.wheel(0, 1400); await page.keyboard.up("Control");
    await page.waitForFunction(() => Number(document.querySelector<HTMLElement>("[data-canvas-viewport]")?.style.getPropertyValue("--canvas-live-scale")) < 0.23);
    if (await input.inputValue() !== "生产页面中文草稿" || !(await input.evaluate((el: HTMLInputElement) => document.activeElement === el))) throw new Error("Overview lost the focused draft");
    report.passed.push("Real page: trusted wheel zoom enters overview without losing focused draft");
    await panPoint(); await page.mouse.wheel(5000, 5000); await page.waitForTimeout(400);
    if (!(await input.evaluate((el: HTMLInputElement) => document.activeElement === el && el.value === "生产页面中文草稿"))) throw new Error("Offscreen editor lost focus or draft");
    report.passed.push("Real page: offscreen pan retains editor DOM and draft");
    await input.press("Enter");
    await page.waitForFunction(() => !document.querySelector('[data-node-id="bench-13"] input'));
    const deadline = Date.now() + 15000;
    while ((await getProject()).nodes.find((node: any) => node.id === "bench-13")?.title !== "生产页面中文草稿") {
        if (Date.now() > deadline) throw new Error("Committed title did not reach fixture persistence");
        await page.waitForTimeout(250);
    }
    report.passed.push("Real page: committed title reaches normal save API");
    // New context avoids restoring the previous tab's local viewport during this independent media case.
    await page.close();
    const mediaPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    mediaPage.on("pageerror", (error: Error) => report.errors.push(error.message));
    await resetCamera();
    await mediaPage.goto(`${origin}/canvas/benchmark-100-spread?canvasDiagnostics=1`);
    await mediaPage.getByRole("button", { name: "编辑节点名称：生产页面中文草稿", exact: true }).waitFor();
    report.passed.push("Real page: saved title survives a fresh browser context");
    const play = async (id: number) => {
        await mediaPage.getByRole("button", { name: `播放 Fixture video ${id}`, exact: true }).click();
        await mediaPage.waitForFunction((id: number) => {
            const video = document.querySelector<HTMLVideoElement>(`[data-node-id="bench-${id}"] video`);
            return video && video.videoWidth > 0 && video.currentTime > 0 && !video.paused;
        }, id);
    };
    await play(12);
    await mediaPage.evaluate(() => { (window as any).__retired = document.querySelector('[data-node-id="bench-12"] video'); });
    await play(10);
    await mediaPage.waitForFunction(() => (window as any).__retired?.paused && !(window as any).__retired?.isConnected && document.querySelectorAll("video").length === 1);
    report.passed.push("Real page: local video decodes and plays; switching leaves one active player");
    await mediaPage.screenshot({ path: join(output, "video-switch.png") });
    await mediaPage.evaluate(() => { (window as any).__retired = document.querySelector('[data-node-id="bench-10"] video'); });
    await panPoint(mediaPage); await mediaPage.mouse.wheel(5000, 0);
    await mediaPage.waitForFunction(() => {
        const video = (window as any).__retired as HTMLVideoElement;
        return video && !video.isConnected && video.paused && video.readyState === 0 && video.networkState === 0 && !video.querySelector("source[src]") && !document.querySelector("video");
    });
    report.passed.push("Real page: trusted wheel pan offscreen releases the player and decoder");
    await mediaPage.goto(`${origin}/canvas/benchmark-500-spread?canvasDiagnostics=1`);
    await mediaPage.waitForSelector('[data-node-id="bench-13"]');
    if (await mediaPage.locator("video").count()) throw new Error("Navigation restored autoplay intent");
    report.passed.push("Real page: navigating to another fixture does not carry autoplay intent");
    await mediaPage.screenshot({ path: join(output, "canvas-500.png") });
    if (report.errors.length) throw new Error(report.errors.join("\n"));
    report.passed.forEach((entry) => console.log(`PASS ${entry}`));
} catch (error) {
    report.failure = String(error); process.exitCode = 1; console.error(error);
    if (!page.isClosed()) await page.screenshot({ path: join(output, "failure.png") }).catch(() => {});
} finally {
    await browser.close();
    const latest = await getProject();
    await fetch(origin + projectPath, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project: { ...initial, revision: latest.revision } }) });
    writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
}
