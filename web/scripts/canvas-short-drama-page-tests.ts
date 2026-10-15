/** Exercise the real production canvas against the isolated benchmark API. */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { createShortDramaPipeline, deriveShortDramaProgress } from "../src/lib/canvas/canvas-short-drama";

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const origin = process.env.CANVAS_TEST_ORIGIN || "http://127.0.0.1:4014";
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error("Only isolated loopback fixtures are allowed");
if ((await (await fetch(`${origin}/api/auth/session`)).json()).data?.user?.id !== "canvas-benchmark") throw new Error("Refusing a non-fixture session");
const projectPath = `${origin}/api/canvas-projects/benchmark-100-spread`;
const read = async () => (await (await fetch(projectPath)).json()).data.project;
const initial = await read();
const save = async (project: unknown) => {
    const response = await fetch(projectPath, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project }) });
    const result = await response.json();
    if (!response.ok || result.code !== 0) throw new Error(`Fixture save failed: ${response.status}`);
};
const pipeline = createShortDramaPipeline({ x: 0, y: 0 });
const progress = deriveShortDramaProgress(pipeline.nodes, pipeline.connections);
const output = resolve(process.env.CANVAS_TEST_REPORT_DIR || "../.local/canvas-benchmark/short-drama-current");
mkdirSync(output, { recursive: true });
const report = { buildIndexSha256: createHash("sha256").update(await (await fetch(origin)).text()).digest("hex"), passed: [] as string[], errors: [] as string[], blockedRequests: [] as string[] };
const check = (condition: boolean, label: string) => {
    if (!condition) throw new Error(label);
    report.passed.push(label);
};
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
try {
    for (const theme of ["dark", "light"]) {
        await save({ ...initial, revision: (await read()).revision, title: "Short drama visibility fixture", appearance: { mode: theme }, nodes: pipeline.nodes, connections: pipeline.connections, viewport: { x: 720, y: 300, k: 0.5 } });
        const context = await browser.newContext({ viewport: { width: 1440, height: 945 }, serviceWorkers: "block" });
        await context.addInitScript((theme: string) => {
            localStorage.setItem("infinite-canvas:canvas-theme", JSON.stringify({ state: { theme }, version: 0 }));
            localStorage.setItem("canvas-short-drama-guide-v1:user:canvas-benchmark", "dismissed");
        }, theme);
        await context.route("**/*", async (route: any) => {
            const request = route.request();
            const url = new URL(request.url());
            if (url.origin !== origin || (request.method() !== "GET" && /\/api\/(tasks|ai|agent)(\/|$)/.test(url.pathname))) {
                report.blockedRequests.push(`${request.method()} ${url.pathname}`);
                return route.abort();
            }
            return route.continue();
        });
        const page = await context.newPage();
        page.on("pageerror", (error: Error) => report.errors.push(error.message));
        page.setDefaultTimeout(15000);
        try {
            await page.goto(`${origin}/canvas/benchmark-100-spread`);
            const guide = page.getByRole("region", { name: "短剧完整制作流程", exact: true });
            const overview = page.getByRole("region", { name: "短剧制作阶段与子任务总览", exact: true });
            await guide.waitFor();
            await page.locator(`.ant-app.infinite-canvas-classic-${theme}`).waitFor();
            check(true, `${theme}: requested canvas theme active`);
            const modelGuideClose = page.getByRole("button", { name: "关闭模型配置引导", exact: true });
            if (await modelGuideClose.isVisible()) await modelGuideClose.click();
            check((await guide.innerText()).includes("8 个阶段 · 33 个子任务"), `${theme}: eight stages and 33 tasks, despite old guide dismissal`);
            check((await page.getByRole("button", { name: "短剧流程", exact: true }).innerText()).includes("/8"), `${theme}: top bar uses /8`);
            check(await overview.count() === 0 && await page.getByRole("region", { name: "剧情与章节子任务", exact: true }).isVisible(), `${theme}: default shows only current stage`);
            await page.getByRole("button", { name: "全部阶段与子任务", exact: true }).click();
            for (const viewport of [{ width: 1440, height: 945 }, { width: 900, height: 700 }, { width: 390, height: 844 }, { width: 900, height: 420 }]) {
                await page.setViewportSize(viewport);
                await guide.evaluate((element: HTMLElement) => { element.scrollTop = 0; });
                const toggleBounds = await page.getByRole("button", { name: "短剧流程", exact: true }).boundingBox();
                check(Boolean(toggleBounds && toggleBounds.x >= 0 && toggleBounds.x + toggleBounds.width <= viewport.width), `${theme} ${viewport.width}x${viewport.height}: flow toggle remains in viewport`);
                check(await overview.locator("[data-task-key]").count() === 33, `${theme} ${viewport.width}x${viewport.height}: all tasks present`);
                const bounds = await guide.boundingBox();
                check(Boolean(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height), `${theme} ${viewport.width}x${viewport.height}: panel fits window`);
                const navigation = await guide.locator(".canvas-drama-stages").evaluate((element: HTMLElement) => ({ width: element.clientWidth, scrollWidth: element.scrollWidth, buttons: element.querySelectorAll("button").length }));
                check(navigation.buttons === 8 && navigation.scrollWidth <= navigation.width + 1, `${theme} ${viewport.width}x${viewport.height}: eight stages without horizontal overflow`);
                const clipped = await overview.locator(".canvas-drama-overview-task span").evaluateAll((elements: HTMLElement[]) => elements.filter((element) => element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1).map((element) => element.textContent));
                check(clipped.length === 0, `${theme} ${viewport.width}x${viewport.height}: no truncated task labels`);
                await page.screenshot({ path: join(output, `${theme}-${viewport.width}x${viewport.height}-top.png`) });
                const lastTask = overview.locator('[data-task-key="delivery.promotion"] button');
                await lastTask.scrollIntoViewIfNeeded();
                await page.screenshot({ path: join(output, `${theme}-${viewport.width}x${viewport.height}-delivery.png`) });
                await lastTask.click();
                const delivery = page.getByRole("region", { name: "导出交付子任务", exact: true });
                await delivery.waitFor();
                check((await delivery.innerText()).includes("宣传物料作为独立可选任务待接入"), `${theme} ${viewport.width}x${viewport.height}: last task reachable with unavailable reason`);
                check(await delivery.getByRole("button", { name: "打开导出" }).isDisabled(), `${theme} ${viewport.width}x${viewport.height}: missing media cannot trigger export`);
                await page.getByRole("button", { name: "返回全部阶段", exact: true }).click();
            }
            await page.setViewportSize({ width: 1440, height: 945 });
            for (const step of progress.steps) {
                await guide.locator(".canvas-drama-stage").filter({ hasText: step.label }).click();
                const detail = page.getByRole("region", { name: `${step.label}子任务`, exact: true });
                check(await detail.locator("[data-task-key]").count() === step.tasks.length, `${theme}: ${step.id} detail task count`);
                await page.getByRole("button", { name: "全部阶段与子任务", exact: true }).click();
            }
            await overview.locator('[data-task-key="story.topic"] button').click();
            await page.getByRole("textbox", { name: "创作节点标题", exact: true }).waitFor();
            check(await page.getByRole("textbox", { name: "创作节点标题", exact: true }).inputValue() === "选题抽取", `${theme}: overview task opens actual story editor`);
            check(await guide.count() === 0, `${theme}: guide collapses when entering editor`);
            await page.getByRole("button", { name: "关闭创作编辑器", exact: true }).click();
            await page.getByRole("button", { name: "短剧流程", exact: true }).click();
            await page.getByRole("region", { name: "剧情与章节子任务", exact: true }).waitFor();
            await page.getByRole("button", { name: "折叠短剧流程", exact: true }).click();
            check(await guide.count() === 0, `${theme}: collapse hides guide`);
            await page.getByRole("button", { name: "短剧流程", exact: true }).click();
            await page.getByRole("region", { name: "剧情与章节子任务", exact: true }).waitFor();
            await page.getByRole("button", { name: "隐藏短剧导引", exact: true }).click();
            await page.reload();
            await page.getByRole("button", { name: "短剧流程", exact: true }).waitFor();
            check(await guide.count() === 0, `${theme}: hide survives reload`);
            await page.getByRole("button", { name: "短剧流程", exact: true }).click();
            await page.getByRole("button", { name: "全部阶段与子任务", exact: true }).click();
            await overview.waitFor();
            check(await overview.locator("[data-task-key]").count() === 33, `${theme}: hidden guide restores all tasks`);
        } catch (error) {
            await page.screenshot({ path: join(output, `${theme}-failure.png`) });
            throw error;
        } finally {
            await context.close();
        }
    }
    check(report.errors.length === 0, "No uncaught page errors");
    check(report.blockedRequests.length === 0, "No external or generation requests attempted");
} catch (error) {
    report.errors.push(String(error));
    process.exitCode = 1;
} finally {
    await browser.close();
    await save({ ...initial, revision: (await read()).revision });
    writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: report.passed.length, errors: report.errors, output }, null, 2));
}
