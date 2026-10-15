/** Production-page benchmark. Isolated loopback API; never proxies to a real backend. Run with Bun. */
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, sep, join } from "node:path";
import { cpus, totalmem, platform, release } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createCanvasPerformanceProject, createCanvasPerformanceAssets, CANVAS_BENCHMARK_SIZES, CANVAS_BENCHMARK_FIXTURE_VERSION, type CanvasBenchmarkSize } from "../test/fixtures/canvas-performance-project";
import { summarizeCanvasSamples } from "../src/lib/canvas/canvas-performance-diagnostics";
import { ensureCanvasTestVideo } from "./canvas-test-video";
import { canvasBenchmarkInputIssues } from "./canvas-benchmark-integrity";

const args = new Map(process.argv.slice(2).map((arg) => { const [key, ...value] = arg.replace(/^--/, "").split("="); return [key, value.join("=") || "true"]; }));
const dist = resolve(args.get("dist") || "dist");
const output = resolve(args.get("output") || `../.local/canvas-benchmark/${new Date().toISOString().replace(/[:.]/g, "-")}`);
const mediaDir = resolve("../.local/canvas-benchmark/media-v2");
const diagnosticCss = args.has("diagnostic-css") ? readFileSync(resolve(args.get("diagnostic-css")!), "utf8") : undefined;
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const executablePath = process.env.CHROME_BIN || ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(existsSync);
if (!existsSync(join(dist, "index.html"))) throw new Error("Production build missing; run bun run build first.");
if (!executablePath) throw new Error("Set CHROME_BIN to the Chrome executable.");
mkdirSync(output, { recursive: true });
mkdirSync(mediaDir, { recursive: true });
ensureCanvasTestVideo(join(mediaDir, "motion.webm"));
const projects = new Map(CANVAS_BENCHMARK_SIZES.flatMap((size) => (["spread", "overview"] as const).map((view) => {
    const project = createCanvasPerformanceProject(size, view);
    return [project.id, project] as const;
})));
const unexpected = new Set<string>();
const assets = new Map([...projects.values()].flatMap((project) => createCanvasPerformanceAssets(project).map((asset) => [asset.id, asset] as const)));
const counts = new Map<string, number>();
const envelope = (data: unknown, status = 200) => Response.json({ code: status === 200 ? 0 : status, data, msg: status === 200 ? "" : "Blocked by isolated benchmark" }, { status });
const features = { welcomeEnabled: false, shortDramaEnabled: true, taskCenterEnabled: true, creditsEnabled: false, customChannelsEnabled: false, frontendModelsEnabled: false, pluginCenterEnabled: false, systemPluginsVisibleToUsers: false };
const fixtures: Record<string, unknown> = {
    "/auth/session": { user: { id: "canvas-benchmark", username: "benchmark", displayName: "Benchmark", role: "user", status: "active" }, features },
    "/features": { features },
    "/model-catalog": { models: [], channels: [] },
    "/channels/system": { channels: [] },
    "/plugins": { plugins: [], states: {} },
    "/plugins/status": { statuses: {}, states: {} },
    "/skills/added": { skills: [] },
    "/skills/presets": { presets: [] },
    "/public/appearance": { appearance: {} },
    "/agent/profile": { revision: "1", hash: "benchmark", layers: [] },
    "/skills": { skills: [], total: 0 },
    "/tasks": [],
    "/announcements": { announcements: [], unreadCount: 0 },
    "/banner-announcements": { banners: [] },
    "/assets": { assets: [], total: 0, hasMore: false, kindCounts: {}, categoryCounts: {}, folderCounts: {}, page: 1, pageSize: 50 },
    "/projects": { projects: [], total: 0 },
    "/settings/prompt-templates": { preferences: [] },
};
const server = Bun.serve({ hostname: "127.0.0.1", port: Number(args.get("port") || 0), async fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/__benchmark/preflight") return new Response("<!doctype html><title>Media decoder preflight</title>", { headers: { "Content-Type": "text/html" } });
    if (pathname.startsWith("/api/")) {
        const path = pathname.slice(4);
        const key = `${request.method} ${path}`;
        counts.set(key, (counts.get(key) || 0) + 1);
        if (request.method === "GET" && Object.hasOwn(fixtures, path)) return envelope(fixtures[path]);
        if (path === "/assets/batch" && request.method === "POST") {
            const input = await request.json();
            return envelope({ assets: input.ids.map((id: string) => assets.get(id)).filter(Boolean) });
        }
        const match = /^\/canvas-projects\/(benchmark-(?:100|500|2000)-(?:spread|overview))$/.exec(path);
        if (match && request.method === "GET") return envelope({ project: projects.get(match[1]) });
        if (match && request.method === "PUT") {
            const input = await request.json();
            const previous = projects.get(match[1])!;
            if (input.project?.id !== previous.id) return envelope(null, 400);
            if (input.project.revision !== previous.revision) return envelope(null, 409);
            const saved = { ...previous, ...input.project, revision: previous.revision! + 1 };
            projects.set(previous.id, saved);
            return envelope({ project: saved });
        }
        if (request.method === "GET" && /^\/canvas-projects\/benchmark-\d+-(spread|overview)\/history$/.test(path)) return envelope({ snapshots: [], currentRevision: 1 });
        unexpected.add(key);
        return envelope(null, 501);
    }
    if (pathname.startsWith("/__benchmark/media/")) {
        const name = pathname.slice("/__benchmark/media/".length);
        if (!/^(image-[0-7]\.png|motion\.webm)$/.test(name)) return new Response(null, { status: 404 });
        return new Response(Bun.file(join(mediaDir, name)), { headers: { "Cache-Control": "public,max-age=3600" } });
    }
    const file = resolve(dist, `.${decodeURIComponent(pathname)}`);
    if (!file.startsWith(dist + sep) && file !== dist) return new Response(null, { status: 403 });
    const asset = Bun.file(file);
    const body = file !== dist && await asset.exists() ? asset : Bun.file(join(dist, "index.html"));
    return new Response(body, { headers: { "Content-Security-Policy": "connect-src 'self' blob:; img-src 'self' data: blob:; media-src 'self' data: blob:", "Cache-Control": pathname.startsWith("/assets/") ? "public,max-age=3600" : "no-cache" } });
} });
const origin = `http://127.0.0.1:${server.port}`;
let browser: any;
const report: any = {
    schema: 1, startedAt: new Date().toISOString(), fixtureVersion: CANVAS_BENCHMARK_FIXTURE_VERSION, mediaVersion: 2, interactionProtocol: 6,
    code: { head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), trackedDiffSha256: createHash("sha256").update(execFileSync("git", ["diff", "--binary"], { stdio: ["ignore", "pipe", "ignore"] })).digest("hex"), indexSha256: createHash("sha256").update(readFileSync(join(dist, "index.html"))).digest("hex"), fixtureSha256: createHash("sha256").update(readFileSync(resolve("test/fixtures/canvas-performance-project.ts"))).digest("hex"), runnerSha256: createHash("sha256").update(readFileSync(import.meta.filename)).digest("hex") },
    environment: { platform: platform(), release: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem(), viewport: { width: 1440, height: 1000 }, headless: args.get("headed") !== "true" },
    measurements: [],
    diagnosticCss,
    retainedMemoryProbe: args.has("retained-memory"),
    cpuProfileProbe: args.has("profile"),
    traceProbe: args.has("trace"),
    integritySha256: createHash("sha256").update(readFileSync(resolve("scripts/canvas-benchmark-integrity.ts"))).digest("hex"),
    limitations: ["Synthetic local media with eight shared PNG resources and one WebM; not a substitute for real-project media diversity.", "Input timing is a double-rAF paint-opportunity proxy, not operation completion.", "GPU and foreground eligibility must be checked before applying performance gates."],
};
const save = () => writeFileSync(join(output, "report.json"), JSON.stringify({ ...report, unexpectedRequests: [...unexpected], requests: Object.fromEntries(counts) }, null, 2));

try {
    browser = await chromium.launch({ executablePath, headless: args.get("headed") !== "true", args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding"] });
    report.environment.chrome = browser.version();
    const browserSession = await browser.newBrowserCDPSession();
    report.environment.gpu = (await browserSession.send("SystemInfo.getInfo")).gpu;
    // Generate actual locally decoded PNG/WebM assets, once, without downloading user media.
    if (!Array.from({ length: 8 }, (_, i) => join(mediaDir, `image-${i}.png`)).every(existsSync)) {
        const page = await browser.newPage();
        const images = await page.evaluate(() => {
            const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 360;
            const ctx = canvas.getContext("2d")!;
            return Array.from({ length: 8 }, (_, i) => {
                ctx.fillStyle = ["#264653", "#b84444", "#37866d", "#734b91", "#867325", "#285b9b", "#9b456f", "#454950"][i]; ctx.fillRect(0, 0, 640, 360);
                for (let n = 0; n < 24; n++) { ctx.fillStyle = `hsl(${(n * 41 + i * 17) % 360} 55% 65%)`; ctx.fillRect(n * 31 % 600, n * 71 % 300, 30 + n, 24 + n); }
                ctx.fillStyle = "white"; ctx.font = "32px sans-serif"; ctx.fillText(`Local media ${i + 1}`, 30, 330);
                return canvas.toDataURL("image/png").split(",")[1];
            });
        });
        images.forEach((data: string, i: number) => writeFileSync(join(mediaDir, `image-${i}.png`), Buffer.from(data, "base64")));
        await page.close();
    }
    const preflight = await browser.newPage({ viewport: report.environment.viewport });
    await preflight.goto(`${origin}/__benchmark/preflight`);
    report.media = await preflight.evaluate(async (url: string) => {
        const video = document.createElement("video"); video.muted = true;
        try {
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error("Synthetic video failed to decode within 10 seconds")), 10000);
                video.onloadeddata = () => { clearTimeout(timer); resolve(); };
                video.onerror = () => { clearTimeout(timer); reject(new Error(video.error?.message || "Invalid synthetic video")); };
                video.src = url;
            });
            await video.play();
            if (!video.videoWidth || !video.videoHeight) throw new Error("Synthetic video has no decoded dimensions");
            return { width: video.videoWidth, height: video.videoHeight, duration: video.duration, decoded: true };
        } finally { video.pause(); video.removeAttribute("src"); video.load(); }
    }, `${origin}/__benchmark/media/motion.webm`);
    report.code.mediaSha256 = createHash("sha256").update(readFileSync(join(mediaDir, "motion.webm"))).digest("hex");
    if (!args.has("serve")) {
        await preflight.bringToFront();
        const cadence = await preflight.evaluate(() => new Promise<{ samples: number[]; visible: boolean; focused: boolean }>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("Empty-page cadence timed out; check browser foreground state")), 15000);
            const samples: number[] = [];
            let previous = 0;
            const tick = (now: number) => {
                if (previous) samples.push(now - previous);
                previous = now;
                if (samples.length < 120) requestAnimationFrame(tick);
                else { clearTimeout(timeout); resolve({ samples, visible: document.visibilityState === "visible", focused: document.hasFocus() }); }
            };
            requestAnimationFrame(tick);
        }));
        report.environment.emptyPageCadence = { ...summarizeCanvasSamples(cadence.samples), visible: cadence.visible, focused: cadence.focused };
    }
    await preflight.close();
    if (args.has("serve")) {
        console.log(`Isolated production fixture: ${origin}/canvas/benchmark-500-spread?canvasDiagnostics=1`);
        await browser.close(); browser = null;
        await new Promise(() => {});
    }
    const sizes = args.has("size") ? [Number(args.get("size")) as CanvasBenchmarkSize] : [...CANVAS_BENCHMARK_SIZES];
    if (sizes.some((size) => !CANVAS_BENCHMARK_SIZES.includes(size))) throw new Error("Size must be 100, 500 or 2000.");
    const views = args.has("view") ? [args.get("view")!] : ["spread", "overview"];
    const repeats = Number(args.get("repeats") || 3);
    for (const size of sizes) for (const view of views) for (let repeat = 1; repeat <= repeats; repeat++) {
        const context = await browser.newContext({ viewport: report.environment.viewport, deviceScaleFactor: 1, serviceWorkers: "block" });
        const fixture = createCanvasPerformanceProject(size, view as "spread" | "overview");
        projects.set(fixture.id, fixture);
        for (const cache of ["cold", "warm"]) {
            const page = await context.newPage();
            const errors: string[] = [];
            page.on("pageerror", (error: Error) => errors.push(error.message));
            const cdp = await context.newCDPSession(page);
            await cdp.send("Performance.enable");
            let timedOut = false;
            let partial: Record<string, unknown> = {};
            let completedInputs = 0;
            const timeout = setTimeout(() => { timedOut = true; void page.close().catch(() => {}); }, 90_000);
            console.log(`START ${size} ${view} ${repeat} ${cache}`);
            try {
            if (cache === "warm") {
                // Retain the HTTP/media cache but remove persisted camera/editor state for identical geometry.
                await cdp.send("Storage.clearDataForOrigin", { origin, storageTypes: "indexeddb,local_storage" });
                projects.set(fixture.id, fixture);
            }
            const before = performance.now();
            await page.goto(`${origin}/canvas/${fixture.id}?canvasDiagnostics=1`, { waitUntil: "domcontentloaded" });
            await page.waitForFunction(() => Boolean(window.__canvasDiagnostics), null, { timeout: 90_000 });
            await page.waitForFunction(() => document.querySelectorAll("[data-node-id]").length > 0);
            if (diagnosticCss) await page.addStyleTag({ content: diagnosticCss });
            const readyMs = performance.now() - before;
            await page.waitForTimeout(3000);
            await page.evaluate(() => document.fonts.ready);
            await page.bringToFront();
            const beforeWarmup = await page.evaluate(() => window.__canvasDiagnostics!.snapshot());
            const camera = () => page.evaluate(() => {
                const root = document.querySelector<HTMLElement>("[data-canvas-viewport]")!;
                const world = root.querySelector<HTMLElement>("[data-canvas-world-layer]")!;
                const transform = new DOMMatrixReadOnly(getComputedStyle(world).transform);
                return { x: transform.m41, y: transform.m42, k: Number(root.style.getPropertyValue("--canvas-live-scale")), width: root.clientWidth, height: root.clientHeight };
            });
            const initialCamera = await camera();
            partial = { readyMs, beforeWarmup, initialCamera, stage: "media-warmup" };
            report.activeScenario = { size, view, repeat, cache, ...partial };
            save();
            const expectedMediaIds = fixture.nodes.filter((node) => (node.type === "image" || node.type === "video") && node.position.x * initialCamera.k + initialCamera.x < initialCamera.width && (node.position.x + node.width) * initialCamera.k + initialCamera.x > 0 && node.position.y * initialCamera.k + initialCamera.y < initialCamera.height && (node.position.y + node.height) * initialCamera.k + initialCamera.y > 0).map((node) => node.id);
            await page.waitForFunction((ids: string[]) => {
                const mounted = new Map([...document.querySelectorAll<HTMLElement>("[data-node-id]")].map((element) => [element.dataset.nodeId, element]));
                return ids.every((id) => {
                    const element = mounted.get(id);
                    return element && [...element.querySelectorAll<HTMLImageElement>("img")].some((image) => image.complete && image.naturalWidth > 0 && getComputedStyle(image).visibility !== "hidden");
                });
            }, expectedMediaIds, { polling: 200, timeout: 90_000 });
            const mediaReadyMs = performance.now() - before;
            await page.waitForTimeout(300);
            const initial = await page.evaluate(() => window.__canvasDiagnostics!.snapshot());
            partial = { ...partial, stage: "interaction", initial, mediaReadyMs, expectedMedia: expectedMediaIds.length };
            report.activeScenario = { size, view, repeat, cache, ...partial };
            save();
            await page.evaluate(() => window.__canvasDiagnostics!.reset());
            await page.evaluate(() => {
                const root = document.querySelector<HTMLElement>("[data-canvas-viewport]")!;
                const world = root.querySelector<HTMLElement>("[data-canvas-world-layer]")!;
                const samples: number[] = [];
                const foreground = { startVisible: document.visibilityState === "visible", startFocused: document.hasFocus(), interruptions: 0 };
                const probe = { samples, pending: 0, failed: 0, received: [] as Array<Record<string, unknown>>, totalReceived: 0, foreground };
                window.addEventListener("blur", () => { foreground.interruptions++; });
                document.addEventListener("visibilitychange", () => { if (document.visibilityState !== "visible") foreground.interruptions++; });
                (window as any).__canvasBenchmarkPan = probe;
                const initial = new DOMMatrixReadOnly(getComputedStyle(world).transform);
                let expectedX = initial.m41;
                let expectedY = initial.m42;
                const pending: number[] = [];
                let observing = false;
                const observe = () => {
                    const after = new DOMMatrixReadOnly(getComputedStyle(world).transform);
                    if (Math.abs(after.m41 - expectedX) < 0.1 && Math.abs(after.m42 - expectedY) < 0.1) {
                        const completed = pending.splice(0);
                        requestAnimationFrame(() => { completed.forEach((started) => samples.push(performance.now() - started)); probe.pending -= completed.length; });
                    } else if (performance.now() - pending[0] > 5000) {
                        probe.failed += pending.length; probe.pending -= pending.length; pending.length = 0;
                    }
                    observing = pending.length > 0;
                    if (observing) requestAnimationFrame(observe);
                };
                root.addEventListener("wheel", (event) => {
                    if (!event.isTrusted) return;
                    probe.totalReceived++;
                    const target = event.target instanceof Element ? event.target : null;
                    if (probe.received.length < 128) probe.received.push({ deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, altKey: event.altKey, clientX: event.clientX, clientY: event.clientY, timeStamp: event.timeStamp,
                        target: target?.closest("[data-canvas-no-zoom],[data-canvas-wheel-scroll],.ant-popover,.ant-dropdown") ? "overlay" : target?.closest(".canvas-frame-shell,.canvas-folder-shell") ? "frame" : target?.closest("[data-node-id]") ? "node" : "canvas" });
                    expectedX -= event.deltaX * 1.2;
                    expectedY -= event.deltaY * 1.2;
                    pending.push(event.timeStamp);
                    probe.pending++;
                    // High-rate events can coalesce into one painted camera state.
                    if (!observing) { observing = true; requestAnimationFrame(observe); }
                }, { capture: true, passive: true });
            });
            const traceEvents: unknown[] = [];
            if (args.has("profile")) {
                await cdp.send("Profiler.enable");
                await cdp.send("Profiler.setSamplingInterval", { interval: 1000 });
                await cdp.send("Profiler.start");
            }
            if (args.has("trace")) {
                report.animations = await page.evaluate(() => document.getAnimations().map((animation) => {
                    const effect = animation.effect as KeyframeEffect | null;
                    const target = effect?.target as Element | null;
                    return { type: animation.constructor.name, state: animation.playState, target: target?.tagName, className: target?.getAttribute("class"), frames: effect?.getKeyframes() };
                }));
                cdp.on("Tracing.dataCollected", ({ value }: { value: unknown[] }) => traceEvents.push(...value));
                await cdp.send("Tracing.start", { categories: "devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.invalidationTracking,blink,cc", transferMode: "ReportEvents" });
            }
            // Trusted mouse wheel input traverses the actual viewport controller and Leafer layers.
            const sentInputs: Array<{ deltaX: number; deltaY: number; clientX: number; clientY: number; target: "canvas" | "frame" }> = [];
            for (let step = 0; step < 12; step++) {
                const point = await page.evaluate(() => {
                    const root = document.querySelector<HTMLElement>("[data-canvas-viewport]")!;
                    const ignore = "[data-canvas-no-zoom],[data-canvas-wheel-scroll],.ant-modal,.ant-popover,.ant-dropdown,.ant-select-dropdown,.ant-picker-dropdown";
                    // A node can mount editing controls on hover, so use actual gaps, not merely the pre-hover hit target.
                    const nodeRects = [...root.querySelectorAll<HTMLElement>(".node-element")].map((node) => node.getBoundingClientRect());
                    for (let y = 100; y < 930; y += 16) for (let x = 110; x < 1320; x += 32) {
                        if (nodeRects.some((rect) => x >= rect.left - 3 && x <= rect.right + 3 && y >= rect.top - 3 && y <= rect.bottom + 3)) continue;
                        const target = document.elementFromPoint(x, y);
                        if (target && root.contains(target) && !target.closest(ignore)) {
                            const frame = Boolean(target.closest(".canvas-frame-shell,.canvas-folder-shell"));
                            if (target.closest("[data-node-id]") && !frame) continue;
                            return { x, y, target: frame ? "frame" as const : "canvas" as const };
                        }
                    }
                    throw new Error("No unblocked canvas wheel input target");
                });
                await page.mouse.move(point.x, point.y);
                const dx = view === "overview" ? 8 : 64;
                const direction = step < 6 ? 1 : -1;
                sentInputs.push({ deltaX: direction * dx, deltaY: direction * dx / 2, clientX: point.x, clientY: point.y, target: point.target });
                await page.mouse.wheel(direction * dx, direction * dx / 2);
                completedInputs++;
                await page.waitForTimeout(80);
            }
            const interaction = await page.evaluate(() => window.__canvasDiagnostics!.snapshot());
            await page.waitForFunction(() => (window as any).__canvasBenchmarkPan.pending === 0, null, { timeout: 6000 });
            const panProbe = await page.evaluate(() => (window as any).__canvasBenchmarkPan);
            const panFeedback = { ...summarizeCanvasSamples(panProbe.samples), failed: panProbe.failed };
            if (args.has("profile")) {
                const { profile } = await cdp.send("Profiler.stop");
                writeFileSync(join(output, `${size}-${view}-${repeat}-${cache}.cpuprofile`), JSON.stringify(profile));
            }
            if (args.has("trace")) {
                const finished = new Promise<void>((resolve) => cdp.once("Tracing.tracingComplete", resolve));
                await cdp.send("Tracing.end");
                await finished;
                writeFileSync(join(output, `${size}-${view}-${repeat}-${cache}.trace.json`), JSON.stringify({ traceEvents }));
            }
            const finalCamera = await camera();
            const inputAudit = { sent: sentInputs, received: panProbe.received, totalReceived: panProbe.totalReceived, foreground: { ...panProbe.foreground, ...await page.evaluate(() => ({ endVisible: document.visibilityState === "visible", endFocused: document.hasFocus() })) }, initialCamera, finalCamera };
            const inputIssues = canvasBenchmarkInputIssues(inputAudit);
            const geometry = await page.evaluate((nodes: typeof fixture.nodes) => {
                const viewport = document.querySelector<HTMLElement>("[data-canvas-viewport]")!;
                const origin = viewport.getBoundingClientRect();
                const transform = new DOMMatrixReadOnly(getComputedStyle(viewport.querySelector<HTMLElement>("[data-canvas-world-layer]")!).transform);
                const k = Number(viewport.style.getPropertyValue("--canvas-live-scale"));
                const expected = new Map(nodes.map((node) => [node.id, node]));
                let maximumError = 0;
                let checked = 0;
                for (const element of viewport.querySelectorAll<HTMLElement>("[data-node-id]")) {
                    const node = expected.get(element.dataset.nodeId!);
                    if (!node) continue;
                    const rect = element.getBoundingClientRect();
                    maximumError = Math.max(maximumError, Math.abs(rect.left - origin.left - transform.m41 - node.position.x * k), Math.abs(rect.top - origin.top - transform.m42 - node.position.y * k), Math.abs(rect.width - node.width * k), Math.abs(rect.height - node.height * k));
                    checked++;
                }
                return { checked, maximumError };
            }, fixture.nodes);
            const visible = await page.evaluate(() => document.visibilityState);
            const metrics = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((entry: any) => [entry.name, entry.value]));
            let retainedMemory;
            if (args.has("retained-memory")) {
                // Diagnostic only: sample identical checkpoints after explicit reclamation,
                // without overwriting the normal, unforced metrics above.
                await cdp.send("HeapProfiler.collectGarbage");
                const retainedMetrics = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((entry: any) => [entry.name, entry.value]));
                retainedMemory = { jsHeapUsedSize: retainedMetrics.JSHeapUsedSize, ...await cdp.send("Memory.getDOMCounters") };
            }
            const nodeIds = await page.locator("[data-node-id]").evaluateAll((els: Element[]) => els.map((el) => el.getAttribute("data-node-id")));
            const decoded = await page.locator("[data-node-id] img").evaluateAll((els: Element[]) => ({ total: els.length, loaded: els.filter((el) => (el as HTMLImageElement).naturalWidth > 0).length }));
            const mountedIds = new Set(nodeIds);
            const expectedVisible = fixture.nodes.filter((node) => node.position.x * finalCamera.k + finalCamera.x < finalCamera.width && (node.position.x + node.width) * finalCamera.k + finalCamera.x > 0 && node.position.y * finalCamera.k + finalCamera.y < finalCamera.height && (node.position.y + node.height) * finalCamera.k + finalCamera.y > 0);
            const missingVisible = expectedVisible.filter((node) => !mountedIds.has(node.id)).length;
            const result = { size, view, repeat, cache, readyMs, mediaReadyMs, expectedMedia: expectedMediaIds.length, beforeWarmup, initial, interaction, panFeedback, inputAudit, inputIssues, initialCamera, finalCamera, geometry, expectedVisible: expectedVisible.length, missingVisible, visible, metrics, retainedMemory, decoded, mountedUnique: mountedIds.size, errors: [...errors] };
            await page.screenshot({ path: join(output, `${size}-${view}-${repeat}-${cache}.png`) });
            report.measurements.push(result);
            save();
            console.log(JSON.stringify({ size, view, repeat, cache, readyMs: Math.round(readyMs), frameP95: (interaction as any).frameMs.p95, mounted: nodeIds.length, errors: errors.length, unexpected: [...unexpected] }));
            if (errors.length || unexpected.size) throw new Error("Baseline has page errors or unmodelled API requests; inspect report before measuring.");
            if (view === "overview" && (initial as any).mountedNodes !== size) throw new Error("Overview did not mount every fixture node; do not accept a silently culled result.");
            if (missingVisible) throw new Error("Nodes expected in the viewport are missing; performance gates are invalid.");
            if (geometry.maximumError > 0.75) throw new Error("Node geometry does not match the committed viewport.");
            if (inputIssues.length) throw new Error(`Input audit failed: ${inputIssues.join(", ")}`);
            if (panFeedback.count !== 12 || panFeedback.failed) throw new Error("A wheel operation did not reach its requested camera state.");
            } catch (error) {
                if (!timedOut) throw error;
                report.measurements.push({ size, view, repeat, cache, ...partial, completedInputs, timedOut: true, deadlineMs: 90_000, errors: [...errors] });
                process.exitCode = 1;
                save();
                console.log(`TIMEOUT ${size} ${view} ${repeat} ${cache}`);
            } finally {
                clearTimeout(timeout);
                await page.close().catch(() => {});
                delete report.activeScenario;
                save();
            }
        }
        await context.close();
    }
} catch (error) {
    report.failure = String(error);
    process.exitCode = 1;
    console.error(error);
} finally {
    save();
    await browser?.close();
    server.stop(true);
}
