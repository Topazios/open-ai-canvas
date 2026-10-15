/** Native IndexedDB blobs and real canvas players; only the isolated fixture API is allowed. */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CanvasNodeType } from "../src/types/canvas";

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const origin = process.env.CANVAS_TEST_ORIGIN || "http://127.0.0.1:4016";
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error("Only isolated loopback fixtures are allowed");
if ((await (await fetch(`${origin}/api/auth/session`)).json()).data?.user?.id !== "canvas-benchmark") throw new Error("Refusing a non-fixture session");
const output = resolve(process.env.CANVAS_TEST_REPORT_DIR || "../.local/canvas-benchmark/local-media-page");
mkdirSync(output, { recursive: true });
const id = "benchmark-100-spread";
const path = `/api/canvas-projects/${id}`;
const getProject = async () => (await (await fetch(origin + path)).json()).data.project;
const initial = await getProject();
const save = async (project: any) => {
    const response = await fetch(origin + path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project }) });
    if (!response.ok) throw new Error(`Fixture save failed: ${response.status}`);
};
const report: any = { buildIndexSha256: createHash("sha256").update(await (await fetch(origin)).text()).digest("hex"), passed: [], cycles: [], errors: [], limitations: ["Synthetic shared local blobs, not remote resource cache ownership or process-memory acceptance.", "Browser URL instrumentation observes allocation/revocation, not native heap reclamation."] };
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on("pageerror", (error: Error) => report.errors.push(error.message));
let signedOut = false;
await page.route("**/api/auth/logout", async (route: any) => {
    signedOut = true;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ code: 0, data: null, msg: "" }) });
});
await page.route("**/api/auth/session", async (route: any) => {
    if (!signedOut) return route.continue();
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ code: 0, data: { user: null }, msg: "" }) });
});
await page.addInitScript(() => {
    const created: Array<{ url: string; size: number; type: string }> = [];
    const revoked: string[] = [];
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob: Blob | MediaSource) => {
        const url = create(blob);
        if (blob instanceof Blob) created.push({ url, size: blob.size, type: blob.type });
        return url;
    };
    URL.revokeObjectURL = (url: string) => { revoked.push(url); revoke(url); };
    (window as any).__localMediaUrls = { created, revoked };
});
const imageKey = "image:canvas-benchmark:local-page-image";
const videoKey = "video:canvas-benchmark:local-page-video";
try {
    await page.goto(`${origin}/__benchmark/preflight`);
    report.media = await page.evaluate(async ({ imageKey, videoKey }: { imageKey: string; videoKey: string }) => {
        const image = await (await fetch("/__benchmark/media/image-0.png")).blob();
        const video = await (await fetch("/__benchmark/media/motion.webm")).blob();
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open("infinite-canvas", 1);
            request.onupgradeneeded = () => { request.result.createObjectStore("image_files"); request.result.createObjectStore("media_files"); };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        try {
            await new Promise<void>((resolve, reject) => {
                const transaction = db.transaction(["image_files", "media_files"], "readwrite");
                transaction.objectStore("image_files").put(image, imageKey);
                transaction.objectStore("media_files").put(video, videoKey);
                transaction.oncomplete = () => resolve();
                transaction.onerror = () => reject(transaction.error);
            });
        } finally { db.close(); }
        return { imageSize: image.size, videoSize: video.size };
    }, { imageKey, videoKey });
    await save({ ...initial, title: "Local media fixture", connections: [], viewport: { x: 60, y: 100, k: 1 }, nodes: [0, 1, 2, 3].map((index) => ({
        id: `local-${index}`, type: index < 2 ? CanvasNodeType.Image : CanvasNodeType.Video,
        title: `Local ${index < 2 ? "image" : "video"} ${index}`, position: { x: 50 + (index % 2) * 500, y: index < 2 ? 50 : 400 }, width: 420, height: 236.25,
        metadata: { manualSize: true, status: "idle", storageKey: index < 2 ? imageKey : videoKey, content: `blob:${origin}/expired-local-preview`, naturalWidth: 640, naturalHeight: 360, ...(index < 2 ? {} : { videoPreview: { storageKey: imageKey, content: "" }, hasAudio: false, mimeType: "video/webm", durationMs: 2000 }) },
    })) });
    await page.goto(`${origin}/canvas/${id}`);
    const documentOrigin = await page.evaluate(() => performance.timeOrigin);
    const waitImages = () => page.waitForFunction(() => [0, 1].every((i) => {
        const img = document.querySelector<HTMLImageElement>(`[data-node-id="local-${i}"] img`);
        return img?.complete && img.naturalWidth > 0 && img.currentSrc.startsWith("blob:");
    }));
    await waitImages();
    const imageSources = await page.locator('[data-node-id="local-0"] img, [data-node-id="local-1"] img').evaluateAll((imgs: HTMLImageElement[]) => imgs.map((img) => img.currentSrc));
    if (new Set(imageSources).size !== 1) throw new Error("Local image consumers did not share their resolved URL");
    report.passed.push("Two actual image nodes decode the same native IndexedDB blob URL");
    const play = async (index: number) => {
        await page.getByRole("button", { name: `播放 Local video ${index}`, exact: true }).click();
        await page.waitForFunction((index: number) => {
            const video = document.querySelector<HTMLVideoElement>(`[data-node-id="local-${index}"] video`);
            return video && video.videoWidth > 0 && video.currentTime > 0 && !video.paused && video.currentSrc.startsWith("blob:");
        }, index);
    };
    for (let cycle = 0; cycle < 10; cycle++) {
        await play(2);
        await page.evaluate(() => { (window as any).__retiredLocalVideo = document.querySelector('[data-node-id="local-2"] video'); });
        await play(3);
        await page.waitForFunction(() => {
            const retired = (window as any).__retiredLocalVideo as HTMLVideoElement;
            return retired && retired.paused && !retired.isConnected && document.querySelectorAll("video").length === 1;
        });
        await page.evaluate(() => { (window as any).__retiredLocalVideo = document.querySelector('[data-node-id="local-3"] video'); });
        await page.mouse.move(1280, 850);
        await page.mouse.wheel(5000, 0);
        await page.waitForFunction(() => {
            const retired = (window as any).__retiredLocalVideo as HTMLVideoElement;
            return retired && !retired.isConnected && retired.paused && retired.readyState === 0 && retired.networkState === 0 && !document.querySelector("video");
        });
        const urls = await page.evaluate(() => {
            const { created, revoked } = (window as any).__localMediaUrls;
            return { created: created.length, revoked: revoked.length, live: created.filter(({ url }: { url: string }) => !revoked.includes(url)).length, players: document.querySelectorAll("video").length };
        });
        report.cycles.push({ cycle: cycle + 1, ...urls });
        await page.mouse.wheel(-5000, 0);
        await waitImages();
    }
    if (report.cycles.some((cycle: any) => cycle.live !== 2 || cycle.created !== 2 || cycle.players !== 0)) throw new Error("Repeated local browsing leaked URLs or players");
    report.passed.push("Ten play/switch/offscreen/return cycles keep exactly two shared native URLs and release every offscreen player");
    await page.screenshot({ path: join(output, "local-media.png") });
    await page.getByRole("link", { name: "主页", exact: true }).click();
    await page.getByRole("button", { name: /^(打开)?账户菜单$/ }).first().click();
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await page.waitForURL("**/login");
    const remaining = await page.evaluate(() => {
        const { created, revoked } = (window as any).__localMediaUrls;
        return created.filter(({ url }: { url: string }) => !revoked.includes(url));
    });
    if (remaining.length) throw new Error("Logout retained local media URLs");
    if (await page.evaluate(() => performance.timeOrigin) !== documentOrigin) throw new Error("Logout reloaded the document; release evidence invalid");
    report.passed.push("Actual SPA logout revokes all shared image/video URLs without document reload");
    if (report.errors.length) throw new Error(report.errors.join("\n"));
    report.passed.forEach((message: string) => console.log(`PASS ${message}`));
} catch (error) {
    report.failure = String(error);
    process.exitCode = 1;
    console.error(error);
    await page.screenshot({ path: join(output, "failure.png") }).catch(() => {});
} finally {
    await browser.close();
    const latest = await getProject();
    await save({ ...initial, revision: latest.revision });
    writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
}
