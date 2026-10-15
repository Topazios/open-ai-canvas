/** Exercise the real production editor's draft recovery page with isolated data. */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import type { TimelineProject } from "../src/types/timeline";

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const origin = process.env.CANVAS_TEST_ORIGIN || "http://127.0.0.1:4014";
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin) || (await (await fetch(`${origin}/api/auth/session`)).json()).data?.user?.id !== "canvas-benchmark") throw new Error("Only isolated benchmark sessions are allowed");
const output = resolve(process.env.CANVAS_TEST_REPORT_DIR || "../.local/canvas-benchmark/timeline-drafts-current");
mkdirSync(output, { recursive: true });
const report = { buildIndexSha256: createHash("sha256").update(await (await fetch(origin)).text()).digest("hex"), passed: [] as string[], errors: [] as string[], blocked: [] as string[] };
const check = (condition: boolean, name: string) => { if (!condition) throw new Error(name); report.passed.push(name); };
const projectId = "draft-fixture";
const stamp = "2026-10-13T00:00:00.000Z";
const units = [{ id: "episode-1", projectId, kind: "episode", title: "Episode 1", sourceText: "Fixture", wordCount: 3, status: "ready", position: 1, createdAt: stamp, updatedAt: stamp }];
const fixtures: Record<string, unknown> = {
    [`/api/projects/${projectId}/core`]: { project: { id: projectId, userId: "canvas-benchmark", name: "Timeline draft fixture", type: "short_drama", aspectRatio: "16:9", sourceType: "original", description: "Local fixture", stylePresetId: "", status: "active", revision: 1, createdAt: stamp, updatedAt: stamp } },
    [`/api/projects/${projectId}/units`]: { units, canvasCounts: {} },
    [`/api/projects/${projectId}/assets`]: { assets: [], total: 0, hasMore: false },
    [`/api/projects/${projectId}/units/episode-1/workspace`]: { unit: units[0], shots: [], shotArtifacts: [], shotRevisions: [], shotReferences: [], assetCandidates: [], assets: [], workflows: [], tasks: [] },
};
const source: TimelineProject = { version: 2, durationMs: 2000, tracks: [{ id: "t", kind: "text", label: "Text", order: 0 }], clips: [{ id: "clip", nodeId: "node", trackId: "t", kind: "text", startMs: 0, durationMs: 2000, title: "Server version", text: "Server content" }] };
const draft: TimelineProject = { ...source, clips: [{ ...source.clips[0], title: "Local draft", text: "Local content" }] };
const storageKey = `editor-timeline:${projectId}:unit:episode-1:user:canvas-benchmark`;
const draftsKey = `editor-timeline:${projectId}:unit:episode-1:drafts:user:canvas-benchmark`;
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
const read = (key: string) => page.evaluate(async (key: string) => new Promise<any>((resolve, reject) => {
    const request = indexedDB.open("infinite-canvas");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
        const db = request.result;
        const item = db.transaction("app_state").objectStore("app_state").get(key);
        item.onsuccess = () => { db.close(); resolve(item.result ? JSON.parse(item.result) : null); };
        item.onerror = () => { db.close(); reject(item.error); };
    };
}), key);
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, serviceWorkers: "block" });
const page = await context.newPage();
page.setDefaultTimeout(15000);
page.on("pageerror", (error: Error) => report.errors.push(error.message));
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
try {
    console.log("draft-test: open editor");
    await page.goto(`${origin}/projects/${projectId}/editor/episode-1`, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.locator('.editor-workbench button[aria-label="导出"]').waitFor();
    console.log("draft-test: seed storage");
    await put({ [storageKey]: source, [draftsKey]: [{ version: 1, id: "tab-a", revision: "r1", projectId, unitId: "episode-1", savedAt: stamp, reason: "save-failed", snapshot: draft }] });
    await page.reload({ waitUntil: "domcontentloaded", timeout: 20000 });
    console.log("draft-test: wait preview");
    const preview = page.getByRole("region", { name: "本机剪辑草稿恢复", exact: true });
    await preview.waitFor();
    const modelGuideClose = page.getByRole("button", { name: "关闭模型配置引导" });
    if (await modelGuideClose.isVisible()) await modelGuideClose.click();
    await page.screenshot({ path: join(output, "draft-preview.png"), fullPage: true });
    check((await preview.innerText()).includes("Local draft"), "Real editor shows the saved local draft");
    check((await preview.innerText()).includes("Server version"), "Real editor shows the current canonical version");
    await page.setViewportSize({ width: 720, height: 900 });
    await page.screenshot({ path: join(output, "draft-preview-narrow.png"), fullPage: true });
    const bounds = await preview.boundingBox();
    check(Boolean(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 720), "Recovery preview fits a narrow viewport");
    await page.setViewportSize({ width: 1280, height: 860 });
    await preview.getByRole("button", { name: "继续当前剪辑", exact: true }).click();
    await page.locator(".editor-workbench").waitFor();
    check((await read(storageKey)).clips[0].text === "Server content" && (await read(draftsKey)).length === 1, "Continue keeps current content and preserves the recovery draft");
    await page.reload();
    await preview.waitFor();
    const changed = { ...source, durationMs: 3000 };
    await put({ [storageKey]: changed });
    await preview.getByRole("button", { name: "恢复草稿并保留当前版本", exact: true }).click();
    await preview.getByRole("alert").filter({ hasText: "当前剪辑已变化" }).waitFor();
    check((await read(storageKey)).durationMs === 3000, "Stale recovery preview refuses to replace a later save");
    await preview.getByRole("button", { name: "刷新草稿预览", exact: true }).click();
    await preview.getByRole("region", { name: "当前已保存剪辑", exact: true }).getByText("00:03.0", { exact: false }).waitFor();
    await preview.getByRole("button", { name: "恢复草稿并保留当前版本", exact: true }).click();
    await page.locator(".editor-workbench").waitFor();
    const restored = await read(storageKey);
    const remaining = await read(draftsKey);
    check(restored.clips[0].text === "Local content", "Explicit recovery writes the selected draft to the real editor storage");
    check(remaining.length === 1 && remaining[0].reason === "before-recovery" && remaining[0].snapshot.clips[0].text === "Server content", "Recovery keeps the displaced canonical version as a backup");
    await page.reload();
    await page.locator(".editor-workbench").waitFor();
    check((await read(storageKey)).clips[0].text === "Local content", "Recovered content survives a full reload");
    await page.getByRole("button", { name: "查看本机剪辑草稿", exact: true }).click();
    await preview.waitFor();
    check((await preview.innerText()).includes("Server content"), "Recovery backup remains accessible from the editor");
    await preview.getByRole("button", { name: "继续当前剪辑", exact: true }).click();
    await page.locator(".editor-workbench").waitFor();
    await put({ [storageKey]: changed });
    await page.getByRole("button", { name: "静音轨道", exact: true }).first().click();
    await page.locator('.editor-workbench [title*="修改已保留为本机草稿"]').first().waitFor();
    check((await read(storageKey)).clips[0].text === "Server content", "Actual editor command conflict preserves the newer canonical record");
    const failedDrafts = await read(draftsKey);
    check(failedDrafts.some((item: any) => item.reason === "save-failed" && item.snapshot.tracks.some((track: any) => track.muted)), "Actual failed editor save persists committed track edits as a draft");
    await page.reload();
    await preview.waitFor();
    check((await preview.innerText()).includes("Local content"), "Refresh after actual save conflict opens recoverable local changes");
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
