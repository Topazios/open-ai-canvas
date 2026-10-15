/** Actual production-page persistence checks, restricted to the synthetic API. */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { CanvasNodeType } from "../src/types/canvas";

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const origin = process.env.CANVAS_TEST_ORIGIN || "http://127.0.0.1:4013";
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error("Only isolated loopback fixtures are allowed");
const session = await (await fetch(`${origin}/api/auth/session`)).json();
if (session.data?.user?.id !== "canvas-benchmark") throw new Error("Refusing a non-fixture session");
const path = "/api/canvas-projects/benchmark-100-spread";
const read = async () => (await (await fetch(origin + path)).json()).data.project;
const initial = await read();
const save = async (project: any) => {
    const response = await fetch(origin + path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project }) });
    if (!response.ok) throw new Error(`Fixture write failed: ${response.status}`);
};
const baseline = process.argv.includes("--baseline");
const output = resolve(process.env.CANVAS_TEST_REPORT_DIR || `../.local/canvas-benchmark/save-${baseline ? "baseline" : "current"}`);
mkdirSync(output, { recursive: true });
const report: any = { baseline, buildIndexSha256: createHash("sha256").update(await (await fetch(origin)).text()).digest("hex"), passed: [], errors: [], measurements: [] };
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
context.on("page", (page: any) => page.on("pageerror", (error: Error) => report.errors.push(error.message)));
const a = await context.newPage();
const b = await context.newPage();
const title = (page: any) => page.locator('[data-node-id="save-text"]').getByRole("button", { name: /^编辑节点名称：/ });
const edit = async (page: any, value: string) => {
    await title(page).click();
    const input = page.locator('[data-node-id="save-text"]').getByRole("textbox", { name: "节点名称" });
    await input.fill(value);
    await input.press("Enter");
    await page.waitForTimeout(1200);
};
const waitUntil = async (predicate: () => Promise<boolean>, message: string) => {
    const deadline = Date.now() + 15000;
    while (!await predicate()) {
        if (Date.now() > deadline) throw new Error(message);
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
};
const expectTitle = async (page: any, expected: string) => {
    await waitUntil(async () => await title(page).getAttribute("aria-label") === `编辑节点名称：${expected}`, `Expected editor title ${expected}`);
};
const expectSaved = (expected: string) => waitUntil(async () => (await read()).nodes.find((node: any) => node.id === "save-text")?.title === expected, "Latest title did not reach the API");
const storageSnapshot = (page: any) => page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("infinite-canvas");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    try {
        const records = await new Promise<Record<string, any>>((resolve, reject) => {
            const transaction = database.transaction("app_state");
            const cursor = transaction.objectStore("app_state").openCursor();
            const result: Record<string, any> = {};
            cursor.onsuccess = () => {
                if (!cursor.result) return;
                const key = String(cursor.result.key);
                if (key.includes("canvas_store") || key.includes("sync-draft")) result[key] = typeof cursor.result.value === "string" ? JSON.parse(cursor.result.value) : cursor.result.value;
                cursor.result.continue();
            };
            transaction.oncomplete = () => resolve(result);
            transaction.onerror = () => reject(transaction.error);
        });
        const project = Object.entries(records).find(([key]) => key.includes("canvas_store"))?.[1]?.state?.projects?.find((p: any) => p.id === "benchmark-100-spread");
        const drafts = Object.entries(records).filter(([key]) => key.includes("sync-drafts:")).flatMap(([, value]) => value);
        return { title: project?.nodes.find((n: any) => n.id === "save-text")?.title, draftTitles: drafts.map((d: any) => d.project.nodes.find((n: any) => n.id === "save-text")?.title) };
    } finally { database.close(); }
});
try {
    await save({ ...initial, nodes: [{ id: "save-text", type: CanvasNodeType.Text, title: "Original", position: { x: 0, y: 0 }, width: 400, height: 260, metadata: { content: "Synthetic save fixture" } }], connections: [], viewport: { x: 200, y: 220, k: 1 } });
    for (const page of [a, b]) {
        await page.goto(`${origin}/canvas/benchmark-100-spread`);
        await title(page).waitFor();
        await page.waitForTimeout(1200);
    }
    await context.route("**/api/canvas-projects/**", (route: any) => route.request().method() === "PUT" ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: 503, msg: "Synthetic offline save", reason: "unavailable" }) }) : route.continue());
    await edit(a, "First tab");
    await edit(b, "Second tab");
    const beforeReload = await storageSnapshot(b);
    report.measurements.push({ phase: "before-reload", ...beforeReload });
    if (!baseline && beforeReload.title !== "Second tab" && !beforeReload.draftTitles.includes("Second tab")) throw new Error("Second tab edit was discarded without a durable draft");
    if (!baseline) {
        await b.getByRole("button", { name: "画布保存状态：需要处理冲突", exact: true }).waitFor();
        await edit(b, "Second continued");
        const continued = await storageSnapshot(b);
        if (continued.title !== "First tab" || !continued.draftTitles.includes("Second continued")) throw new Error("Continued conflict editing lost a branch");
        report.passed.push("Conflict status is explicit; continued editing preserves both branches");
    }
    await b.reload();
    await title(b).waitFor();
    report.measurements.push({ phase: "after-reload", displayedTitle: await title(b).getAttribute("aria-label"), ...await storageSnapshot(b) });
    if (!baseline) report.passed.push("Concurrent offline same-field edit survives in durable state or conflict draft");
    await b.screenshot({ path: join(output, "after-reload.png") });
    if (!baseline) {
        await a.close();
        const status = b.getByRole("button", { name: "画布保存状态：云端保存失败", exact: true });
        await status.waitFor();
        await status.click();
        await b.getByRole("button", { name: "加载云端版", exact: true }).click();
        await b.getByRole("button", { name: "保留草稿并加载", exact: true }).click();
        await expectTitle(b, "Original");
        await b.getByRole("button", { name: "画布保存状态：已保存到云端", exact: true }).waitFor();
        const resolved = await storageSnapshot(b);
        if (resolved.title !== "Original" || !resolved.draftTitles.includes("First tab") || !resolved.draftTitles.includes("Second continued")) throw new Error("Load latest did not preserve both branches or replace the durable projection");
        await context.unroute("**/api/canvas-projects/**");
        await edit(b, "Resolved after conflict");
        await expectSaved("Resolved after conflict");
        report.passed.push("Explicit load latest retains both drafts, replaces durable state and permits new saves");
    }
    await context.close();
    if (!baseline) {
        const retryContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
        const page = await retryContext.newPage();
        page.on("pageerror", (error: Error) => report.errors.push(error.message));
        let offline = true;
        let putCount = 0;
        let gate: Promise<void> | undefined;
        let release: (() => void) | undefined;
        let held = false;
        await retryContext.route("**/api/canvas-projects/**", async (route: any) => {
            if (route.request().method() !== "PUT") return route.continue();
            putCount++;
            if (offline) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: 503, msg: "Synthetic offline save" }) });
            if (gate) { held = true; await gate; }
            return route.continue();
        });
        try {
            await page.goto(`${origin}/canvas/benchmark-100-spread`);
            await title(page).waitFor();
            await edit(page, "Offline draft");
            await page.getByRole("button", { name: "画布保存状态：云端保存失败", exact: true }).waitFor();
            if ((await storageSnapshot(page)).title !== "Offline draft") throw new Error("Offline content was not durable");
            await page.reload();
            await expectTitle(page, "Offline draft");
            await page.getByRole("button", { name: "画布保存状态：云端保存失败", exact: true }).waitFor();
            report.passed.push("503 save failure is visible and the local edit survives reload");
            offline = false;
            await page.getByRole("button", { name: "画布保存状态：云端保存失败", exact: true }).click();
            await page.getByRole("button", { name: "立即重试", exact: true }).click();
            await expectSaved("Offline draft");
            await page.getByRole("button", { name: "画布保存状态：已保存到云端", exact: true }).waitFor();
            await page.reload();
            await expectTitle(page, "Offline draft");
            report.passed.push("Explicit retry after recovery reaches cloud and survives reload");

            gate = new Promise<void>((resolve) => { release = resolve; });
            await edit(page, "In flight first");
            await waitUntil(async () => held, "Save request did not enter the controlled gate");
            await edit(page, "In flight latest");
            release!(); gate = undefined;
            await expectSaved("In flight latest");
            await page.reload();
            await expectTitle(page, "In flight latest");
            report.passed.push("Edits during an in-flight save retain the newest title after refresh");

            await page.waitForTimeout(1800);
            const beforePan = putCount;
            await page.mouse.move(1200, 780);
            await page.keyboard.down("Space");
            await page.mouse.down();
            await page.mouse.move(1100, 740, { steps: 8 });
            await page.mouse.up();
            await page.keyboard.up("Space");
            await page.waitForTimeout(1500);
            if (putCount !== beforePan) throw new Error("Viewport-only pan submitted a content PUT");
            report.passed.push("Viewport pan does not submit a content save");
            await page.screenshot({ path: join(output, "recovered.png") });
        } finally { release?.(); await retryContext.close(); }
    }
    if (report.errors.length) throw new Error(report.errors.join("\n"));
    console.log(JSON.stringify(report, null, 2));
} catch (error) {
    report.failure = String(error); process.exitCode = 1; console.error(error);
} finally {
    await browser.close();
    await save({ ...initial, revision: (await read()).revision });
    writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
}
