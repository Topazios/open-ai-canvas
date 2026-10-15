/** Production review route with isolated API, IndexedDB and locally decoded media. */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { buildLocalDeliveryRecord } from "../src/services/short-drama-delivery-store";
import type { TimelineProject } from "../src/types/timeline";

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const origin = process.env.CANVAS_TEST_ORIGIN || "http://127.0.0.1:4014";
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin) || (await (await fetch(`${origin}/api/auth/session`)).json()).data?.user?.id !== "canvas-benchmark") throw new Error("Only isolated benchmark sessions are allowed");
const output = resolve(process.env.CANVAS_TEST_REPORT_DIR || "../.local/canvas-benchmark/review-positions-current");
mkdirSync(output, { recursive: true });
const report = { buildIndexSha256: createHash("sha256").update(await (await fetch(origin)).text()).digest("hex"), passed: [] as string[], errors: [] as string[], blocked: [] as string[] };
const check = (condition: boolean, name: string) => { if (!condition) throw new Error(name); report.passed.push(name); };
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
const page = await context.newPage();
page.setDefaultTimeout(15000);
page.on("pageerror", (error: Error) => report.errors.push(error.message));
const projectId = "review-fixture";
const unitId = "episode-1";
const stamp = "2026-10-13T00:00:00.000Z";
const unit = { id: unitId, projectId, kind: "episode", title: "Episode 1", sourceText: "Synthetic review fixture", wordCount: 24, status: "ready", position: 0, createdAt: stamp, updatedAt: stamp };
const fixtures: Record<string, unknown> = {
    [`/api/projects/${projectId}/core`]: { project: { id: projectId, userId: "canvas-benchmark", name: "Review position fixture", type: "short_drama", aspectRatio: "16:9", sourceType: "original", description: "Local fixture", stylePresetId: "", status: "active", revision: 1, createdAt: stamp, updatedAt: stamp } },
    [`/api/projects/${projectId}/units`]: { units: [unit], canvasCounts: {} },
    [`/api/projects/${projectId}/units/${unitId}/workspace`]: { unit, shots: [{ id: "source-shot", projectId, unitId, title: "Shot 1", description: "Synthetic shot", position: 0, durationMs: 1500, status: "draft", createdAt: stamp, updatedAt: stamp }], shotArtifacts: [], shotRevisions: [], shotReferences: [], assetCandidates: [], assets: [], workflows: [], tasks: [] },
};
await context.route("**/*", async (route: any) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin || request.method() !== "GET") {
        report.blocked.push(`${request.method()} ${url.pathname}`);
        return route.abort();
    }
    if (url.pathname.startsWith("/api/resources/review-render-") && url.pathname.endsWith("/file")) {
        const body = Buffer.from(await Bun.file(resolve("../.local/canvas-benchmark/media-v2/motion.webm")).arrayBuffer());
        const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers().range || "");
        if (range) {
            const start = Number(range[1]);
            const end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
            return route.fulfill({ status: 206, contentType: "video/webm", headers: { "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${body.length}` }, body: body.subarray(start, end + 1) });
        }
        return route.fulfill({ status: 200, contentType: "video/webm", headers: { "Accept-Ranges": "bytes" }, body });
    }
    if (fixtures[url.pathname]) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ code: 0, data: fixtures[url.pathname], msg: "" }) });
    return route.continue();
});
const timelineKey = `editor-timeline:${projectId}:unit:${unitId}:user:canvas-benchmark`;
const recordKey = `short-drama-delivery:${projectId}:unit:${unitId}:user:canvas-benchmark`;
const put = (items: Record<string, unknown>) => page.evaluate(async (items: Record<string, unknown>) => {
    await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("infinite-canvas");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const db = request.result;
            const transaction = db.transaction("app_state", "readwrite");
            for (const [key, value] of Object.entries(items)) transaction.objectStore("app_state").put(JSON.stringify(value), key);
            transaction.oncomplete = () => { db.close(); resolve(); };
            transaction.onerror = () => { db.close(); reject(transaction.error); };
        };
    });
}, items);
const read = () => page.evaluate(async (key: string) => new Promise<any>((resolve, reject) => {
    const request = indexedDB.open("infinite-canvas");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
        const db = request.result;
        const item = db.transaction("app_state").objectStore("app_state").get(key);
        item.onsuccess = () => { db.close(); resolve(JSON.parse(item.result)); };
        item.onerror = () => { db.close(); reject(item.error); };
    };
}), recordKey);
const timeline: TimelineProject = { version: 2, tracks: [{ id: "v", kind: "video", label: "Video", order: 0 }], clips: [{ id: "review-clip", nodeId: "review-node", trackId: "v", kind: "video", startMs: 0, durationMs: 1500, sourceStartMs: 0, title: "Local shot", directMedia: { id: "local-media", kind: "video", title: "Local shot", storageKey: "resource:local-video" } }], durationMs: 2000 };
timeline.clips[0].shotSource = { projectId, unitId, shotId: "source-shot", revisionId: "source-revision", artifactId: "source-artifact", resourceId: "local-video" };
const rendered = (snapshot: TimelineProject, resourceId: string, previous?: any) => buildLocalDeliveryRecord({ projectId, unitId, timeline: snapshot, result: { resourceId, durationMs: 2000 }, previous });
const waitMedia = async () => {
    await page.getByLabel("审片播放器", { exact: true }).waitFor();
    await page.getByLabel("审片播放器", { exact: true }).evaluate((video: HTMLVideoElement) => { video.preload = "auto"; video.load(); });
    await page.waitForFunction(() => { const video = document.querySelector<HTMLVideoElement>('video[aria-label="审片播放器"]'); return video && video.readyState >= 2 && video.videoWidth > 0; });
    const closeModels = page.getByRole("button", { name: "关闭模型配置引导" });
    if (await closeModels.isVisible()) await closeModels.click();
};
const seek = async (time: number) => {
    await page.getByLabel("审片播放器", { exact: true }).evaluate((video: HTMLVideoElement, time: number) => { video.currentTime = time; }, time);
    await page.waitForFunction((time: number) => {
        const video = document.querySelector<HTMLVideoElement>('video[aria-label="审片播放器"]');
        return video && !video.seeking && Math.abs(video.currentTime - time) < 0.02;
    }, time);
};
try {
    await page.goto(`${origin}/projects/${projectId}/workflow/${unitId}/review`);
    await page.getByRole("heading", { name: "审片问题", exact: true }).waitFor();
    await put({ [timelineKey]: timeline, [recordKey]: rendered(timeline, "review-render-a") });
    await page.reload();
    await waitMedia();
    const closeModels = page.getByRole("button", { name: "关闭模型配置引导" });
    if (await closeModels.isVisible()) await closeModels.click();
    check(await page.getByLabel("审片播放器", { exact: true }).evaluate((video: HTMLVideoElement) => video.videoWidth === 160 && video.videoHeight === 90 && video.duration > 1.8), "Actual local WebM decodes in review player");
    await seek(0.5);
    await page.getByRole("button", { name: "标记当前时间", exact: true }).click();
    check(await page.getByRole("combobox", { name: "问题关联片段" }).inputValue() === "review-clip", "Unique active clip selected at capture");
    await page.getByRole("textbox", { name: "审片问题内容" }).fill("Synthetic frame annotation");
    await page.getByRole("button", { name: "添加审片问题" }).click();
    const issue = page.locator("[data-review-issue]").first();
    await issue.waitFor();
    let stored = await read();
    check(stored.issues[0].position.resourceId === "review-render-a" && stored.issues[0].position.timeMs === 500 && stored.issues[0].position.sourceTimeMs === 500, "Annotation persisted with render and source time");
    await seek(0);
    await issue.getByRole("button", { name: "定位问题 00:00.500" }).click();
    check(await page.getByLabel("审片播放器", { exact: true }).evaluate((video: HTMLVideoElement) => Math.abs(video.currentTime - 0.5) < 0.02 && video.paused), "Click seeks exact timestamp without autoplay");
    await page.reload();
    await waitMedia();
    check(await page.locator("[data-review-issue]").count() === 1, "Annotation restored after real reload");
    const moved = { ...timeline, clips: timeline.clips.map((clip) => ({ ...clip, startMs: 500 })) };
    await put({ [timelineKey]: moved, [recordKey]: rendered(moved, "review-render-b", stored) });
    await page.reload();
    await waitMedia();
    check((await issue.innerText()).includes("已映射片段位置"), "New rendered timeline displays mapped position explicitly");
    await issue.getByRole("button", { name: "定位问题 00:00.500" }).click();
    check(await page.getByLabel("审片播放器", { exact: true }).evaluate((video: HTMLVideoElement) => Math.abs(video.currentTime - 1) < 0.02), "Moved clip seeks source-equivalent time in new render");
    await page.screenshot({ path: join(output, "review-remapped.png"), fullPage: true });
    stored = await read();
    const replaced = { ...moved, clips: moved.clips.map((clip) => ({ ...clip, directMedia: { ...clip.directMedia!, storageKey: "resource:replacement-video" } })) };
    await put({ [timelineKey]: replaced, [recordKey]: rendered(replaced, "review-render-c", stored) });
    await page.reload();
    await waitMedia();
    check(await issue.getByRole("button", { name: "定位问题 00:00.500" }).isDisabled() && (await issue.innerText()).includes("需重新定位"), "Replaced source disables misleading old position");
    await seek(0.75);
    await page.getByRole("button", { name: "标记当前时间", exact: true }).click();
    await page.getByRole("textbox", { name: "审片问题内容" }).fill("Retained old-render draft");
    stored = await read();
    await put({ [recordKey]: rendered(replaced, "review-render-d", stored) });
    await page.getByText("审片文件已更新，请重新标记时间；问题草稿已保留。", { exact: true }).waitFor();
    await page.getByRole("button", { name: "添加审片问题" }).click();
    await page.getByRole("alert").filter({ hasText: "时间点属于旧审片文件" }).waitFor();
    check(await page.getByRole("textbox", { name: "审片问题内容" }).inputValue() === "Retained old-render draft" && (await read()).issues.length === 1, "Stale capture rejected while draft and existing issues survive");
    check(await issue.getByRole("link", { name: "来源镜头：Shot 1" }).getAttribute("href") === `/projects/${projectId}/workflow/${unitId}/video`, "Annotation links to the existing source shot workbench");
    await page.setViewportSize({ width: 720, height: 900 });
    await page.getByRole("textbox", { name: "审片问题内容" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(output, "review-stale-draft-narrow.png"), fullPage: true });
    check(report.errors.length === 0, "No uncaught page errors");
    check(report.blocked.length === 0, "No write or external requests attempted");
} catch (error) {
    report.errors.push(String(error));
    await page.screenshot({ path: join(output, "failure.png"), fullPage: true });
    process.exitCode = 1;
} finally {
    await browser.close();
    writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: report.passed.length, errors: report.errors, output }, null, 2));
}
