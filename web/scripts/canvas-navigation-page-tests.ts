/** Real menu creation and browser history navigation on an isolated production app. */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { CanvasNodeType } from "../src/types/canvas";

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const origin = process.env.CANVAS_TEST_ORIGIN || "http://127.0.0.1:4014";
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error("Only isolated loopback fixtures are allowed");
if ((await (await fetch(`${origin}/api/auth/session`)).json()).data?.user?.id !== "canvas-benchmark") throw new Error("Refusing a non-fixture session");
const id = "benchmark-100-spread";
const projectPath = `/api/canvas-projects/${id}`;
const read = async () => (await (await fetch(origin + projectPath)).json()).data.project;
const initial = await read();
const save = async (project: any) => {
    const response = await fetch(origin + projectPath, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project }) });
    if (!response.ok) throw new Error(`Fixture save failed: ${response.status}`);
};
const baseline = process.argv.includes("--baseline");
const output = resolve(process.env.CANVAS_TEST_REPORT_DIR || `../.local/canvas-benchmark/navigation-${baseline ? "baseline" : "current"}`);
mkdirSync(output, { recursive: true });
const report: any = { baseline, buildIndexSha256: createHash("sha256").update(await (await fetch(origin)).text()).digest("hex"), passed: [], observations: [], errors: [] };
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on("pageerror", (error: Error) => report.errors.push(error.message));
const created = new Map<string, any>();
const writes: any[] = [];
let heldProjectId = "";
let releaseLoad: (() => void) | undefined;
let heldLoad: Promise<void> | undefined;
let loadStarted = false;
await page.route("**/api/canvas-projects/**", async (route: any) => {
    const request = route.request();
    const match = /^\/api\/canvas-projects\/([^/]+)$/.exec(new URL(request.url()).pathname);
    if (match && request.method() === "GET" && match[1] === heldProjectId && heldLoad) { loadStarted = true; await heldLoad; }
    if (!match || match[1] === id) {
        if (match && request.method() === "PUT") writes.push(request.postDataJSON().project);
        return route.continue();
    }
    const reply = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ code: status === 200 ? 0 : status, data, msg: "Synthetic navigation fixture" }) });
    if (request.method() === "PUT") {
        const project = request.postDataJSON().project;
        const previous = created.get(match[1]);
        if (project.id !== match[1] || project.revision !== (previous?.revision ?? 0)) return reply(null, 409);
        const saved = { ...project, revision: project.revision + 1,
            ...(!previous ? { nodes: [{ id: "switch-shared", type: CanvasNodeType.Text, title: "Canvas B title", position: { x: 100, y: 50 }, width: 400, height: 240, metadata: { content: "Synthetic B body" } }], viewport: { x: 340, y: 300, k: 0.8 } } : {}) };
        created.set(saved.id, saved);
        return reply({ project: saved });
    }
    if (request.method() === "GET") return created.has(match[1]) ? reply({ project: created.get(match[1]) }) : reply(null, 404);
    return reply(null, 405);
});
const node = () => page.locator('[data-node-id="switch-shared"]');
const title = () => node().getByRole("button", { name: /^编辑节点名称：/ });
const edit = async (value: string) => {
    await title().click();
    const input = node().getByRole("textbox", { name: "节点名称", exact: true });
    await input.fill(value);
    await input.press("Enter");
};
const localProjects = () => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("infinite-canvas");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    try {
        return await new Promise<any[]>((resolve, reject) => {
            const scope = localStorage.getItem("infinite-canvas:active-user-scope");
            const request = db.transaction("app_state").objectStore("app_state").get(`infinite-canvas:canvas_store:user:${scope}`);
            request.onsuccess = () => resolve(JSON.parse(request.result).state.projects);
            request.onerror = () => reject(request.error);
        });
    } finally { db.close(); }
});
const check = (condition: boolean, message: string) => {
    report.observations.push({ message, passed: condition });
    if (!condition && !baseline) throw new Error(message);
    if (condition) report.passed.push(message);
};
try {
    await save({ ...initial, title: "Navigation fixture A", nodes: [{ id: "switch-shared", type: CanvasNodeType.Text, title: "Canvas A title", position: { x: 0, y: 0 }, width: 400, height: 240, metadata: { content: "Synthetic A body" } }], connections: [], viewport: { x: 200, y: 220, k: 1 } });
    await page.goto(`${origin}/canvas/${id}`);
    await title().waitFor();
    await page.waitForTimeout(1200);
    const documentOrigin = await page.evaluate(() => performance.timeOrigin);
    await page.getByRole("button", { name: "打开画布菜单", exact: true }).click();
    await page.getByRole("menuitem", { name: "新建画布", exact: true }).click();
    await page.waitForURL((url: URL) => url.pathname.startsWith("/canvas/") && !url.pathname.endsWith(id));
    await page.waitForSelector("[data-canvas-viewport]");
    await page.waitForTimeout(1200);
    const newId = new URL(page.url()).pathname.split("/").at(-1)!;
    check(created.has(newId), "Menu creation persisted a separate synthetic project");
    check(await page.evaluate(() => performance.timeOrigin) === documentOrigin, "Menu creation used SPA navigation without reloading the document");
    check(await title().getAttribute("aria-label") === "编辑节点名称：Canvas B title", "The new project displays B content for a node ID shared with A");
    const bViewport = (await localProjects()).find((project) => project.id === newId).viewport;
    await edit("Canvas B committed");
    const writesBeforeBack = writes.length;
    await page.goBack();
    await page.waitForURL(`**/canvas/${id}`);
    await page.waitForTimeout(2500);
    const restored = await read();
    check(await page.evaluate(() => performance.timeOrigin) === documentOrigin, "Browser back reused the document and exercised SPA navigation");
    report.observations.push({ phase: "back-to-A", nodeIds: restored.nodes.map((n: any) => n.id), writes: writes.slice(writesBeforeBack).map((project) => ({ nodeIds: project.nodes.map((n: any) => n.id), viewport: project.viewport })), domNodeIds: await page.locator("[data-node-id]").evaluateAll((elements: HTMLElement[]) => elements.map((el) => el.dataset.nodeId)) });
    check(restored.nodes.length === 1 && restored.nodes[0].id === "switch-shared" && restored.nodes[0].title === "Canvas A title", "Returning to A preserves its persisted content");
    const displayedTitle = await title().getAttribute("aria-label");
    report.observations.push({ displayedTitle, saveStatus: await page.getByRole("button", { name: /^画布保存状态：/ }).getAttribute("aria-label") });
    check(displayedTitle === "编辑节点名称：Canvas A title", "Returning to A displays its original node title");
    const locals = await localProjects();
    const localA = locals.find((project) => project.id === id);
    const localB = locals.find((project) => project.id === newId);
    check(localA.nodes[0]?.title === "Canvas A title" && localB.nodes[0]?.title === "Canvas B committed", "Immediate back after commit retains separate local node contents");
    check(created.get(newId).nodes[0]?.title === "Canvas B committed", "The departed canvas finishes saving its own last committed edit");
    check(JSON.stringify(localB.viewport) === JSON.stringify(bViewport), "Leaving B does not save A's viewport into B");
    await page.mouse.click(1100, 750);
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(400);
    check(await title().getAttribute("aria-label") === "编辑节点名称：Canvas A title", "Undo on A does not replay B's edit history");

    heldProjectId = newId;
    heldLoad = new Promise<void>((resolve) => { releaseLoad = resolve; });
    await page.goForward();
    await page.waitForURL(`**/canvas/${newId}`);
    const deadline = Date.now() + 10000;
    while (!loadStarted && Date.now() < deadline) await page.waitForTimeout(50);
    check(loadStarted, "Forward navigation started the deliberately delayed B load");
    await page.goBack();
    await page.waitForURL(`**/canvas/${id}`);
    await page.waitForTimeout(400);
    releaseLoad!(); heldLoad = undefined; heldProjectId = "";
    await page.waitForTimeout(1800);
    check(await title().getAttribute("aria-label") === "编辑节点名称：Canvas A title", "A late B response cannot replace the current A editor");
    const afterLate = await localProjects();
    check(afterLate.find((project) => project.id === id).nodes[0]?.title === "Canvas A title" && afterLate.find((project) => project.id === newId).nodes[0]?.title === "Canvas B committed", "Rapid back/forward and late responses keep both durable canvases intact");
    await page.screenshot({ path: join(output, "back-to-A.png") });
    if (report.errors.length) throw new Error(report.errors.join("\n"));
    console.log(JSON.stringify(report, null, 2));
} catch (error) {
    report.failure = String(error); process.exitCode = 1; console.error(error);
    await page.screenshot({ path: join(output, "failure.png") }).catch(() => {});
} finally {
    releaseLoad?.();
    await browser.close();
    await save({ ...initial, revision: (await read()).revision });
    writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
}
