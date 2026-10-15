/** Real production UI, isolated API and simulated model tasks only. */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createShortDramaPipeline } from "../src/lib/canvas/canvas-short-drama";
import { prepareStoryEpisodeBatch, saveStoryDevelopmentNode } from "../src/lib/canvas/canvas-story-development";
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const origin = "http://127.0.0.1:4014";
if ((await (await fetch(`${origin}/api/auth/session`)).json()).data?.user?.id !== "canvas-benchmark") throw new Error("Isolated fixture required");
const canvasId = "benchmark-100-spread";
const original = (await (await fetch(`${origin}/api/canvas-projects/${canvasId}`)).json()).data.project;
const output = resolve("../.local/canvas-benchmark/story-episode-batch-current");
mkdirSync(output, { recursive: true });
const report = { passed: [] as string[], errors: [] as string[], blocked: [] as string[] };
const check = (value: boolean, label: string) => { if (!value) throw new Error(label); report.passed.push(label); };
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
try {
    for (const theme of ["dark", "light"]) {
        const pipeline = createShortDramaPipeline({ x: 0, y: 0 });
        const topic = pipeline.nodes.find((node) => node.metadata?.storyDevelopment?.stage === "topic")!;
        topic.metadata!.storyDevelopment!.brief!.episodeCount = 6;
        for (const stage of ["topic", "plan", "episodes", "body"]) {
            const node = pipeline.nodes.find((entry) => entry.metadata?.storyDevelopment?.stage === stage)!;
            pipeline.nodes = saveStoryDevelopmentNode(pipeline.nodes, node, node.title!, stage === "body" ? "第一集原正文" : `${stage} 完整上游文稿`, node.metadata!.storyDevelopment!);
        }
        const body = pipeline.nodes.find((node) => node.metadata?.storyDevelopment?.stage === "body")!;
        const prepared = prepareStoryEpisodeBatch(body.id, pipeline.nodes, pipeline.connections, 2, 1);
        let cloud = { ...original, nodes: prepared.nodes, connections: prepared.connections, projectId: "", appearance: { mode: theme }, viewport: { x: 500, y: 200, k: 0.6 } };
        const owner = prepared.targets[0].id;
        const context = await browser.newContext({ viewport: { width: 1440, height: 945 }, serviceWorkers: "block" });
        await context.addInitScript((theme: string) => localStorage.setItem("infinite-canvas:canvas-theme", JSON.stringify({ state: { theme }, version: 0 })), theme);
        const page = await context.newPage(); page.setDefaultTimeout(20000);
        page.on("pageerror", (error: Error) => report.errors.push(error.message));
        const requests: any[] = [];
        const tasks = new Map<string, any>();
        let releaseReceipt: (() => void) | undefined;
        let releaseCancel: (() => void) | undefined;
        let delayCancel = false;
        let delayFirst = theme === "dark";
        let successImmediately = false;
        let cancellations = 0;
        let failSave = false;
        await context.route("**/*", async (route: any) => {
            const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
            const envelope = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ code: status === 200 ? 0 : status, data, msg: status === 200 ? "" : "receipt lost" }) });
            if (url.origin !== origin) { report.blocked.push(path); return route.abort(); }
            if (path === "/api/model-catalog") return envelope({ source: "system", channels: [{ id: "fixture", displayName: "Fixture", models: [{ id: "story-text", modelKey: "story-text", displayName: "Fixture text", capability: "text", protocol: "openai", available: true, priceTiers: [] }] }] });
            if (path === `/api/canvas-projects/${canvasId}` && request.method() === "GET") return envelope({ project: cloud });
            if (path === `/api/canvas-projects/${canvasId}` && request.method() === "PUT") { if (failSave) return envelope(null, 503); const input = request.postDataJSON(); if (input.project.revision !== cloud.revision) return envelope(null, 409); cloud = { ...input.project, revision: cloud.revision + 1 }; return envelope({ project: cloud }); }
            if (path === "/api/tasks" && request.method() === "POST") {
                const input = request.postDataJSON(); requests.push(input);
                const episode = input.input.metadata.episodeNumber;
                const task = { id: `batch-task-${requests.length}`, projectId: canvasId, episode, type: "canvas_text", status: successImmediately ? "succeeded" : "running", prompt: input.prompt, attempts: 1, createdAt: "", updatedAt: "", resultJson: JSON.stringify({ text: `第 ${episode} 集批量正文\n场次 1：人物冲突、动作与对白。` }), clientContext: { storyNodeId: input.input.metadata.storyNodeId, clientOperationId: input.input.metadata.clientOperationId } };
                tasks.set(task.id, task);
                if (delayFirst) { delayFirst = false; await new Promise<void>((resolve) => { releaseReceipt = resolve; }); }
                return episode === 4 && !successImmediately ? envelope(null, 503) : envelope(task);
            }
            if (path === "/api/tasks" && request.method() === "GET") return envelope([...tasks.values()].map(({ resultJson, ...task }) => task));
            if (/^\/api\/tasks\/batch-task-\d+\/cancel$/.test(path)) {
                const task = tasks.get(path.split("/")[3]);
                if (delayCancel) { delayCancel = false; await new Promise<void>((resolve) => { releaseCancel = resolve; }); }
                task.status = "cancelled"; cancellations++; return envelope(task);
            }
            if (/^\/api\/tasks\/batch-task-\d+$/.test(path)) return envelope(tasks.get(path.split("/")[3]));
            if (request.method() !== "GET" && path !== "/api/assets/batch") { report.blocked.push(`${request.method()} ${path}`); return route.abort(); }
            return route.continue();
        });
        const wait = async (predicate: () => boolean, label: string) => { for (let i = 0; i < 200 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 100)); check(predicate(), `${theme}: ${label}`); };
        const openBody = async () => {
            const toggle = page.getByRole("button", { name: "短剧流程", exact: true }); await toggle.waitFor();
            if (await toggle.getAttribute("aria-pressed") === "false") await toggle.click();
            const guide = page.getByRole("region", { name: "短剧完整制作流程", exact: true });
            await guide.locator(".canvas-drama-stage").filter({ hasText: "剧情与章节" }).click();
            await guide.locator('[data-task-key="story.body"] button').click();
            await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('[aria-label="创作正文"]')?.disabled === false);
        };
        const progress = () => page.locator('.story-development-batch-progress');
        const row = (episode: number) => progress().locator('.story-development-batch-row').filter({ hasText: `第 ${episode} 集` });
        try {
            await page.goto(`${origin}/canvas/${canvasId}`); await openBody();
            check(await page.getByRole("spinbutton", { name: "起始集数", exact: true }).inputValue() === "2", `${theme}: defaults to current episode`);
            await page.getByRole("spinbutton", { name: "本次生成集数", exact: true }).fill("3");
            failSave = true;
            await page.getByRole("button", { name: "批量生成正文", exact: true }).click();
            await page.getByRole("alert").filter({ hasText: "正文节点尚未保存到云端" }).waitFor();
            check(requests.length === 0, `${theme}: failed canvas save prevents all model submissions`);
            failSave = false;
            await page.getByRole("button", { name: "批量生成正文", exact: true }).click();
            if (theme === "dark") {
                await wait(() => requests.length === 1 && Boolean(releaseReceipt), "first submission durably started");
                await page.getByRole("button", { name: "关闭创作编辑器", exact: true }).click();
                releaseReceipt!();
                await page.reload(); await openBody();
                await page.getByRole("button", { name: "继续提交未提交的集", exact: true }).click();
            }
            await wait(() => requests.length === 3, "one batch submits three episode tasks");
            check(new Set(requests.map((input) => input.input.metadata.clientOperationId)).size === 3, `${theme}: no duplicate operation submissions`);
            check(requests.map((input) => input.input.metadata.episodeNumber).join(",") === "2,3,4", `${theme}: requested episode range matches task metadata`);
            check(requests.every((input) => input.prompt.includes(`本次只生成第 ${input.input.metadata.episodeNumber} 集`) && input.prompt.includes("episodes 完整上游文稿")), `${theme}: each task uses outlines and its own episode number`);
            await page.getByRole("button", { name: "后台运行", exact: true }).click();
            await page.reload(); await openBody();
            await wait(() => requests.length === 3, "reopening resumes without more POSTs");
            failSave = true;
            for (const task of tasks.values()) { task.status = task.episode === 3 ? "failed" : "succeeded"; if (task.episode === 3) task.error = "fixture upstream failure"; }
            await progress().getByRole("status").filter({ hasText: "云端保存失败" }).first().waitFor();
            check(!cloud.nodes.some((node: any) => node.metadata?.storyDevelopment?.episodeNumber === 2 && node.metadata.content.includes("批量正文")), `${theme}: failed result save is not reported as cloud persistence`);
            failSave = false;
            await wait(() => [2, 4].every((episode) => cloud.nodes.some((node: any) => node.metadata?.storyDevelopment?.episodeNumber === episode && node.metadata.content.includes(`第 ${episode} 集批量正文`))), "successful episodes write to separate canvas nodes");
            await row(3).getByText("第 3 集 · 生成失败", { exact: true }).waitFor();
            check(cloud.nodes.find((node: any) => node.id === body.id).metadata.content === "第一集原正文", `${theme}: existing first episode is preserved`);
            check(cloud.nodes.find((node: any) => node.metadata?.storyDevelopment?.episodeNumber === 3).metadata.content === "", `${theme}: a failed episode does not become completed`);
            await wait(() => tasks.get("batch-task-3").status === "succeeded", "lost receipt still has its original server task");
            check(requests.length === 3, `${theme}: lost receipt recovery never repeats a POST`);
            await page.waitForTimeout(400); await page.screenshot({ path: join(output, `${theme}-batch-results.png`) });
            await page.setViewportSize({ width: 390, height: 844 });
            await page.getByRole("spinbutton", { name: "本次生成集数", exact: true }).scrollIntoViewIfNeeded();
            check(await page.locator('.story-development-layout').evaluate((el: HTMLElement) => el.scrollWidth <= el.clientWidth + 1), `${theme}: batch controls fit narrow screen`);
            await page.screenshot({ path: join(output, `${theme}-batch-narrow.png`) });
            await page.setViewportSize({ width: 1440, height: 945 });
            successImmediately = true;
            await page.getByRole("button", { name: "批量生成正文", exact: true }).click();
            await wait(() => requests.length === 4, "explicit retry submits only the failed episode");
            check(requests[3].input.metadata.episodeNumber === 3, `${theme}: retry skips completed episodes`);
            await wait(() => cloud.nodes.some((node: any) => node.metadata?.storyDevelopment?.episodeNumber === 3 && node.metadata.content.includes("第 3 集批量正文")), "retry result writes back automatically");
            await row(3).getByRole("button", { name: "打开第 3 集", exact: true }).click();
            await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('[aria-label="创作正文"]')?.value.includes("第 3 集批量正文"));
            await page.getByRole("button", { name: "撤销 AI 更新", exact: true }).click();
            check(await page.getByRole("textbox", { name: "创作正文", exact: true }).inputValue() === "", `${theme}: each episode retains its previous version`);
            await page.getByRole("button", { name: "重做 AI 更新", exact: true }).click();
            await page.getByRole("button", { name: "返回批次", exact: true }).click();
            await page.waitForFunction(() => document.querySelector<HTMLInputElement>('[aria-label="创作节点标题"]')?.value === "第 2 集 · 正文");
            successImmediately = false;
            await page.getByRole("spinbutton", { name: "起始集数", exact: true }).fill("5");
            await page.getByRole("spinbutton", { name: "本次生成集数", exact: true }).fill("2");
            await page.getByRole("button", { name: "批量生成正文", exact: true }).click();
            await wait(() => requests.length === 6, "later range submits independently");
            await page.getByRole("button", { name: "停止批次", exact: true }).click();
            await wait(() => cancellations === 2, "stop cancels both running episode tasks");
            check(tasks.get("batch-task-5").status === "cancelled" && tasks.get("batch-task-6").status === "cancelled", `${theme}: all submitted tasks acknowledge cancellation`);
            check(cloud.nodes.filter((node: any) => node.metadata?.storyDevelopment?.stage === "body").length === 6, `${theme}: exactly one node per episode`);
            await row(6).getByRole("button", { name: "打开第 6 集", exact: true }).click();
            await page.waitForFunction(() => document.querySelector<HTMLInputElement>('[aria-label="创作节点标题"]')?.value === "第 6 集 · 正文");
            await page.getByRole("textbox", { name: "创作正文", exact: true }).fill("第六集未保存的手工草稿");
            await page.getByRole("button", { name: "返回批次", exact: true }).click();
            await page.waitForFunction(() => document.querySelector<HTMLInputElement>('[aria-label="创作节点标题"]')?.value === "第 2 集 · 正文");
            successImmediately = true;
            await page.getByRole("button", { name: "批量生成正文", exact: true }).click();
            await wait(() => requests.length === 7, "batch resumes cancelled blank episodes but skips local drafts");
            check(requests[6].input.metadata.episodeNumber === 5, `${theme}: sixth episode local draft is not overwritten or regenerated`);
            await wait(() => cloud.nodes.some((node: any) => node.metadata?.storyDevelopment?.episodeNumber === 5 && node.metadata.content.includes("第 5 集批量正文")), "resumed blank episode completes");
            check(cloud.nodes.find((node: any) => node.metadata?.storyDevelopment?.episodeNumber === 6).metadata.content === "", `${theme}: local draft is not silently saved by another episode's batch`);
            check(owner === prepared.targets[0].id, `${theme}: batch owner identity is stable`);
            await page.getByRole("button", { name: "关闭创作编辑器", exact: true }).click();
            await page.reload(); await openBody();
            await page.waitForFunction(() => document.querySelector<HTMLInputElement>('[aria-label="创作节点标题"]')?.value === "第 6 集 · 正文");
            await page.getByRole("textbox", { name: "创作正文", exact: true }).fill("");
            successImmediately = false;
            await page.getByRole("button", { name: "批量生成正文", exact: true }).click();
            await wait(() => requests.length === 8, "child episode can start its own batch");
            delayCancel = true;
            await page.getByRole("button", { name: "停止批次", exact: true }).click();
            await wait(() => Boolean(releaseCancel), "cancellation waits for server receipt");
            await page.getByRole("textbox", { name: "创作正文", exact: true }).fill("停止期间输入的新草稿");
            releaseCancel!();
            await wait(() => cancellations === 3, "child cancellation completes");
            await page.waitForFunction(() => !document.querySelector('.story-development-batch .ant-btn-loading'));
            check(await page.getByRole("textbox", { name: "创作正文", exact: true }).inputValue() === "停止期间输入的新草稿", `${theme}: cancellation receipt preserves edits made while waiting`);
            await page.getByRole("button", { name: "关闭创作编辑器", exact: true }).click();
            await page.reload(); await openBody();
            await page.waitForFunction(() => document.querySelector<HTMLInputElement>('[aria-label="创作节点标题"]')?.value === "第 6 集 · 正文");
            check(await page.getByRole("textbox", { name: "创作正文", exact: true }).inputValue() === "停止期间输入的新草稿", `${theme}: concurrent cancellation draft survives reload`);
        } catch (error) { releaseReceipt?.(); releaseCancel?.(); await page.screenshot({ path: join(output, `${theme}-failure.png`), fullPage: true }); throw error; }
        finally { await context.close(); }
    }
    check(report.errors.length === 0, "No uncaught page errors"); check(report.blocked.length === 0, "No external calls or unmocked writes");
} catch (error) { report.errors.push(String(error)); process.exitCode = 1; }
finally { await browser.close(); writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ passed: report.passed.length, errors: report.errors, output }, null, 2)); }
