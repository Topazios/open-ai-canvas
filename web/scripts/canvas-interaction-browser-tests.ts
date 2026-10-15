/** Browser behavior tests of production hooks, distinct from real-page performance acceptance. */
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createServer } from "vite";
import { ensureCanvasTestVideo } from "./canvas-test-video";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const executablePath = process.env.CHROME_BIN || ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
const output = resolve(process.env.CANVAS_TEST_REPORT_DIR || "../.local/canvas-benchmark/interaction-tests");
mkdirSync(output, { recursive: true });
const videoPath = resolve("../.local/canvas-benchmark/media-v2/motion.webm");
ensureCanvasTestVideo(videoPath);
const server = await createServer({ server: { host: "127.0.0.1", port: 0, open: false }, plugins: [{
    name: "canvas-component-behavior-tests",
    configureServer(server) {
        server.middlewares.use("/__canvas-test-video.webm", (_req, res) => {
            res.setHeader("Content-Type", "video/webm");
            res.end(readFileSync(videoPath));
        });
        server.middlewares.use("/__canvas-component-tests", async (_req, res, next) => {
            try {
                res.setHeader("Content-Type", "text/html");
                res.end(await server.transformIndexHtml("/__canvas-component-tests", '<!doctype html><html><head></head><body><script type="module">import {runCanvasInteractionChecks} from "/test/fixtures/canvas-interaction-behavior.tsx"; import {runFloatingDockChecks} from "/test/fixtures/floating-dock-behavior.tsx"; window.runChecks = runCanvasInteractionChecks; window.runDockChecks = runFloatingDockChecks;</script></body></html>'));
            } catch (error) { next(error); }
        });
    },
}] });
let browser: any;
const report: { passed: string[]; errors: string[]; failure?: string } = { passed: [], errors: [] };
try {
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === "string") throw new Error("No test server port");
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage();
    page.on("pageerror", (error: Error) => report.errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}/__canvas-component-tests`);
    await page.waitForFunction(() => typeof (window as any).runChecks === "function", null, { timeout: 60_000 });
    report.passed = await page.evaluate(() => (window as any).runChecks());
    for (const mode of [
        { label: "desktop", motionEnabled: true },
        { label: "labeled", motionEnabled: false, showLabels: true },
        { label: "narrow", motionEnabled: false, width: 600 },
        { label: "touch", motionEnabled: false, hasTouch: true },
        { label: "reduced-motion", motionEnabled: false, reducedMotion: "reduce" },
    ]) {
        const dockPage = await browser.newPage({ viewport: { width: mode.width || 1280, height: 900 }, hasTouch: mode.hasTouch, reducedMotion: mode.reducedMotion || "no-preference" });
        try {
            dockPage.on("pageerror", (error: Error) => report.errors.push(error.message));
            await dockPage.goto(`http://127.0.0.1:${address.port}/__canvas-component-tests`);
            await dockPage.waitForFunction(() => typeof (window as any).runDockChecks === "function", null, { timeout: 60_000 });
            report.passed.push(...await dockPage.evaluate((options: unknown) => (window as any).runDockChecks(options), mode));
        } finally { await dockPage.close(); }
    }
    if (report.errors.length) throw new Error(report.errors.join("\n"));
    report.passed.forEach((name) => console.log(`PASS ${name}`));
} catch (error) {
    report.failure = String(error); process.exitCode = 1; console.error(error);
} finally {
    writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
    await browser?.close();
    await server.close();
}
