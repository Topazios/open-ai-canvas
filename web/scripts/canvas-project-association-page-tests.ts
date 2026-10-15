/** Exercise association on the real production canvas with isolated project and canvas APIs. */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const origin = process.env.CANVAS_TEST_ORIGIN || "http://127.0.0.1:4014";
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin) || (await (await fetch(`${origin}/api/auth/session`)).json()).data?.user?.id !== "canvas-benchmark") throw new Error("Only isolated benchmark sessions are allowed");
const output = resolve(process.env.CANVAS_TEST_REPORT_DIR || "../.local/canvas-benchmark/canvas-association-current");
mkdirSync(output, { recursive: true });
const report = { buildIndexSha256: createHash("sha256").update(await (await fetch(origin)).text()).digest("hex"), passed: [] as string[], errors: [] as string[], blocked: [] as string[] };
const check = (condition: boolean, label: string) => { if (!condition) throw new Error(label); report.passed.push(label); };
const canvasId = "benchmark-100-spread";
const sourceUrl = `${origin}/api/canvas-projects/${canvasId}`;
const source = (await (await fetch(sourceUrl)).json()).data.project;
const projectId = "association-project";
const unitId = "episode-1";
const stamp = "2026-10-13T00:00:00.000Z";
const project = { id: projectId, userId: "canvas-benchmark", name: "Project fixture", type: "short_drama", status: "active", revision: 1, createdAt: stamp, updatedAt: stamp };
const unit = { id: unitId, projectId, kind: "episode", title: "Episode 1", sourceText: "Chapter content", wordCount: 15, status: "ready", position: 0, createdAt: stamp, updatedAt: stamp };
let cloud = { ...source, revision: source.revision, projectId: undefined };
let link: { projectId: string; unitId: string; canvasId: string } | null = null;
let simulateConflict = false;
let simulateFailure = false;
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 945 }, serviceWorkers: "block" });
const page = await context.newPage();
page.setDefaultTimeout(15000);
page.on("pageerror", (error: Error) => report.errors.push(error.message));
await context.route("**/*", async (route: any) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) { report.blocked.push(`${request.method()} ${url.href}`); return route.abort(); }
    const path = url.pathname;
    const envelope = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ code: status === 200 ? 0 : status, data, msg: status === 200 ? "" : "fixture conflict", reason: status === 409 ? "conflict" : undefined }) });
    if (path === "/api/projects" && request.method() === "GET") return envelope({ projects: [{ project, unitCount: 1, canvasCount: link ? 1 : 0, assetCount: 0 }] });
    if (path === `/api/projects/${projectId}/units` && request.method() === "GET") return envelope({ units: [unit], canvasCounts: {} });
    if (path === `/api/projects/${projectId}` && request.method() === "GET") return envelope({ project, units: [unit], assets: [], assetFolders: [], canvasUnitLinks: link ? [{ ...link, id: "link-1", role: "storyboard", createdAt: stamp }] : [], shots: [], shotArtifacts: [], workflows: [] });
    if (path === `/api/projects/${projectId}/canvases/${canvasId}/node-shot-links` && request.method() === "GET") return envelope({ links: [] });
    if (path === `/api/projects/${projectId}/canvas-links` && request.method() === "POST") {
        const input = request.postDataJSON();
        if (simulateFailure) return envelope(null, 501);
        if (simulateConflict || input.expectedCanvasRevision !== cloud.revision) return envelope(null, 409);
        if (input.canvasId !== canvasId || input.unitId !== unitId) return envelope(null, 400);
        cloud = { ...cloud, revision: cloud.revision + 1, projectId };
        link = { projectId, unitId, canvasId };
        return envelope({ link: { id: "link-1", ...link, role: "storyboard", createdAt: stamp } });
    }
    if (path === "/api/assets/batch" && request.method() === "POST") return envelope({ assets: [] });
    if (path === `/api/canvas-projects/${canvasId}` && request.method() === "GET") return envelope({ project: cloud });
    if (path === `/api/canvas-projects/${canvasId}` && request.method() === "PUT") {
        const input = request.postDataJSON();
        if (input.project.revision !== cloud.revision) return envelope(null, 409);
        cloud = { ...input.project, revision: cloud.revision + 1 };
        return envelope({ project: cloud });
    }
    if (request.method() !== "GET") { report.blocked.push(`${request.method()} ${path}`); return route.abort(); }
    return route.continue();
});
const modal = page.getByRole("dialog", { name: "画布关联与制作流程" });
const open = async () => { await page.getByRole("button", { name: "打开画布菜单" }).click(); await page.getByText("关联项目与章节", { exact: true }).last().click(); await modal.waitFor(); };
try {
    await page.goto(`${origin}/canvas/${canvasId}`);
    await page.getByRole("button", { name: "打开画布菜单" }).waitFor();
    const modelGuideClose = page.getByRole("button", { name: "关闭模型配置引导" });
    if (await modelGuideClose.isVisible()) await modelGuideClose.click();
    await open();
    check(await modal.getByRole("button", { name: "确认关联" }).isDisabled(), "Association requires a preview");
    await modal.getByRole("combobox", { name: "关联目标项目" }).selectOption(projectId);
    await modal.getByRole("combobox", { name: "关联目标章节" }).selectOption(unitId);
    await modal.getByRole("button", { name: "保存画布并预览关联" }).click();
    await modal.getByRole("region", { name: "画布关联预览" }).waitFor();
    check((await modal.innerText()).includes("原样保留") && (await modal.innerText()).includes("不自动建立对应关系"), "Preview states what remains unchanged");
    check((await modal.locator("[aria-label='保留的画布节点'] li").count()) === source.nodes.length, "Preview lists all actual canvas nodes");
    const originalNodes = JSON.stringify(cloud.nodes);
    await page.screenshot({ path: join(output, "association-preview.png") });
    simulateConflict = true;
    await modal.getByRole("button", { name: "确认关联" }).click();
    await modal.getByRole("alert").filter({ hasText: "fixture conflict" }).waitFor();
    check(!link && JSON.stringify(cloud.nodes) === originalNodes, "Conflict leaves relationship and nodes untouched");
    simulateConflict = false;
    await modal.getByRole("button", { name: "刷新关联预览" }).click();
    await modal.getByRole("region", { name: "画布关联预览" }).waitFor();
    simulateFailure = true;
    await modal.getByRole("button", { name: "确认关联" }).click();
    await modal.getByRole("alert").waitFor();
    check(!link && !cloud.projectId, "Failed link leaves project ownership empty");
    simulateFailure = false;
    await modal.getByRole("button", { name: "确认关联" }).click();
    await modal.getByRole("navigation", { name: "已关联章节制作流程" }).waitFor();
    check(link?.unitId === unitId && cloud.projectId === projectId, "Explicit confirmation links the intended project and episode");
    check(JSON.stringify(cloud.nodes) === originalNodes && JSON.stringify(cloud.connections) === JSON.stringify(source.connections), "Association preserves nodes and connections exactly");
    check((await modal.getByRole("navigation", { name: "已关联章节制作流程" }).getByRole("link").count()) === 8, "Result exposes all eight project-stage entries");
    await page.screenshot({ path: join(output, "association-result.png") });
    await modal.locator(".ant-modal-close").click();
    await page.setViewportSize({ width: 390, height: 844 });
    const focusBar = page.getByRole("toolbar", { name: "专注模式工具栏" });
    await focusBar.getByRole("button", { name: "关联项目与章节" }).click();
    await modal.waitFor();
    check(await modal.getByRole("combobox", { name: "关联目标项目" }).inputValue() === projectId, "Linked project remains selected after reopening on a narrow canvas");
    await modal.getByRole("combobox", { name: "关联目标章节" }).selectOption(unitId);
    check((await modal.getByRole("navigation", { name: "现有章节关联" }).innerText()).includes("Episode 1"), "Existing chapter link is visible after reopening");
    const bounds = await modal.boundingBox();
    check(Boolean(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390), "Association dialog fits mobile-width viewport");
    await page.screenshot({ path: join(output, "association-linked-narrow.png") });
    check(report.errors.length === 0, "No uncaught page errors");
    check(report.blocked.length === 0, "No external, generation or unexpected write requests");
} catch (error) {
    report.errors.push(String(error));
    await page.screenshot({ path: join(output, "failure.png"), fullPage: true });
    process.exitCode = 1;
} finally {
    await browser.close();
    writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: report.passed.length, errors: report.errors, output }, null, 2));
}
