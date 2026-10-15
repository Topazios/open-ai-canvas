/** Real project editor routing and legacy assignment using an isolated production build. */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import type { TimelineProject } from "../src/types/timeline";

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const origin = process.env.CANVAS_TEST_ORIGIN || "http://127.0.0.1:4014";
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin) || (await (await fetch(`${origin}/api/auth/session`)).json()).data?.user?.id !== "canvas-benchmark") throw new Error("Only isolated benchmark sessions are allowed");
const output = resolve(process.env.CANVAS_TEST_REPORT_DIR || "../.local/canvas-benchmark/timeline-assignment-current");
mkdirSync(output, { recursive: true });
const report = { buildIndexSha256: createHash("sha256").update(await (await fetch(origin)).text()).digest("hex"), passed: [] as string[], errors: [] as string[], blocked: [] as string[] };
const check = (condition: boolean, name: string) => { if (!condition) throw new Error(name); report.passed.push(name); };
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 945 }, serviceWorkers: "block" });
const page = await context.newPage();
page.setDefaultTimeout(15000);
page.on("pageerror", (error: Error) => report.errors.push(error.message));
const projectId = "assignment-fixture";
const stamp = "2026-10-13T00:00:00.000Z";
const units = [1, 2, 3].map((index) => ({ id: `episode-${index}`, projectId, kind: "episode", title: `Episode ${index}`, sourceText: "Fixture", wordCount: 7, status: "ready", position: index, createdAt: stamp, updatedAt: stamp }));
const fixtures: Record<string, unknown> = {
    [`/api/projects/${projectId}/core`]: { project: { id: projectId, userId: "canvas-benchmark", name: "Legacy assignment fixture", type: "short_drama", aspectRatio: "16:9", sourceType: "original", description: "Local fixture", stylePresetId: "", status: "active", revision: 1, createdAt: stamp, updatedAt: stamp } },
    [`/api/projects/${projectId}/units`]: { units, canvasCounts: {} },
    [`/api/projects/${projectId}/assets`]: { assets: [], total: 0, hasMore: false },
    ...Object.fromEntries(units.map((unit) => [`/api/projects/${projectId}/units/${unit.id}/workspace`, { unit, shots: [], shotArtifacts: [], shotRevisions: [], shotReferences: [], assetCandidates: [], assets: [], workflows: [], tasks: [] }])),
};
await context.route("**/*", async (route: any) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin || request.method() !== "GET") {
        report.blocked.push(`${request.method()} ${url.pathname}`);
        return route.abort();
    }
    if (fixtures[url.pathname]) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ code: 0, data: fixtures[url.pathname], msg: "" }) });
    return route.continue();
});
const key = (suffix = "") => `editor-timeline:${projectId}${suffix}:user:canvas-benchmark`;
const put = (items: Record<string, unknown>) => page.evaluate(async (items: Record<string, unknown>) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("infinite-canvas");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction("app_state", "readwrite");
        for (const [key, value] of Object.entries(items)) transaction.objectStore("app_state").put(JSON.stringify(value), key);
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onerror = () => { db.close(); reject(transaction.error); };
    };
}), items);
const read = (suffix = "") => page.evaluate(async (key: string) => new Promise<any>((resolve, reject) => {
    const request = indexedDB.open("infinite-canvas");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
        const db = request.result;
        const item = db.transaction("app_state").objectStore("app_state").get(key);
        item.onsuccess = () => { db.close(); resolve(item.result ? JSON.parse(item.result) : null); };
        item.onerror = () => { db.close(); reject(item.error); };
    };
}), key(suffix));
const source: TimelineProject = { version: 2, durationMs: 2000, tracks: [{ id: "t", kind: "text", label: "Text", order: 0 }], clips: [{ id: "original-clip", trackId: "t", nodeId: "original-node", kind: "text", startMs: 500, durationMs: 1500, title: "Original title", text: "Original content" }] };
const preview = page.getByRole("region", { name: "旧项目剪辑归属预览", exact: true });
const exportButton = page.locator('.editor-workbench button[aria-label="导出"]');
const visit = async (unit: number) => { await page.goto(`${origin}/projects/${projectId}/editor/episode-${unit}`); };
const dismissModelGuide = async () => { const close = page.getByRole("button", { name: "关闭模型配置引导" }); if (await close.isVisible()) await close.click(); };
try {
    await visit(1);
    await exportButton.waitFor();
    await put({ [key()]: source });
    await page.reload();
    await preview.waitFor();
    await dismissModelGuide();
    check((await preview.innerText()).includes("Original title"), "Preview displays actual legacy clips");
    check(await read(":assignment") === null && await read(":unit:episode-1") === null, "Opening preview writes neither assignment nor episode data");
    await page.screenshot({ path: join(output, "preview-desktop.png"), fullPage: true });
    await page.getByRole("button", { name: "从空白开始", exact: true }).click();
    await exportButton.waitFor();
    check(await read(":assignment") === null, "Starting empty does not assign the source");
    await page.reload();
    await preview.waitFor();
    await page.getByRole("combobox", { name: "旧剪辑目标集数" }).selectOption("episode-2");
    await page.waitForURL(`**/editor/episode-2`);
    await preview.waitFor();
    check(await page.getByRole("combobox", { name: "旧剪辑目标集数" }).inputValue() === "episode-2", "Episode selection navigates existing editor route");
    const otherPage = await context.newPage();
    await otherPage.goto(`${origin}/projects/${projectId}/editor/episode-3`);
    await otherPage.getByRole("region", { name: "旧项目剪辑归属预览", exact: true }).waitFor();
    await page.getByRole("button", { name: "确认归属到当前集", exact: true }).click();
    await exportButton.waitFor();
    const assigned = await read(":assignment");
    check(assigned.unitId === "episode-2" && JSON.stringify(assigned.snapshot) === JSON.stringify(source), "Confirmation atomically persists intended episode and exact snapshot");
    check(JSON.stringify(await read()) === JSON.stringify(source), "Legacy project record is unchanged");
    await otherPage.getByRole("button", { name: "确认归属到当前集", exact: true }).click();
    await otherPage.getByRole("alert").filter({ hasText: "已归属其他集" }).waitFor();
    check(await read(":unit:episode-3") === null, "Concurrent stale preview cannot assign another episode");
    await otherPage.close();
    await page.reload();
    await exportButton.waitFor();
    check(await preview.count() === 0 && (await page.locator(".editor-workbench footer").innerText()).includes("片段 1"), "Assigned snapshot restores into actual editor after reload");
    await visit(3);
    await preview.waitFor();
    check(await page.getByRole("button", { name: "确认归属到当前集", exact: true }).isDisabled() && (await preview.innerText()).includes("Episode 2"), "Other episodes show assignment owner and disable duplicate assignment");
    await page.setViewportSize({ width: 720, height: 900 });
    await dismissModelGuide();
    await page.screenshot({ path: join(output, "assigned-other-episode-narrow.png"), fullPage: true });
    const existing = { ...source, clips: [{ ...source.clips[0], title: "Existing episode edit" }] };
    await put({ [key(":unit:episode-1")]: existing });
    await visit(1);
    await exportButton.waitFor();
    check(await preview.count() === 0 && JSON.stringify(await read(":unit:episode-1")) === JSON.stringify(existing), "Existing unit timeline bypasses assignment without modifications");
    check(report.errors.length === 0, "No uncaught page errors");
    check(report.blocked.length === 0, "No external or write API requests attempted");
} catch (error) {
    report.errors.push(String(error));
    await page.screenshot({ path: join(output, "failure.png"), fullPage: true });
    process.exitCode = 1;
} finally {
    await browser.close();
    writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: report.passed.length, errors: report.errors, output }, null, 2));
}
