/** Real production route, isolated APIs, no model requests or user data writes. */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import { workflowImageFixture } from "../test/fixtures/workflow-image-project";
import { createCanvasPerformanceProject } from "../test/fixtures/canvas-performance-project";
import { createWorkflowImages, workflowImageSubjects } from "../src/lib/canvas/canvas-workflow-images";
import { adjustWorkflowImagePrompt } from "../src/lib/canvas/canvas-image-prompt-adjustment";
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const dist = resolve("dist");
const output = resolve("../.local/canvas-benchmark/workflow-images"); mkdirSync(output, { recursive: true });
const features = { welcomeEnabled: false, shortDramaEnabled: true, taskCenterEnabled: true, creditsEnabled: false, customChannelsEnabled: false, frontendModelsEnabled: false, pluginCenterEnabled: false };
const fixtures: Record<string, unknown> = {
    "/auth/session": { user: { id: "canvas-benchmark", username: "fixture", role: "user", status: "active" }, features },
    "/features": { features }, "/channels/system": { channels: [] }, "/plugins": { plugins: [], states: {} },
    "/plugins/status": { statuses: {}, states: {} }, "/skills/added": { skills: [] }, "/skills/presets": { presets: [] },
    "/public/appearance": { appearance: {} }, "/agent/profile": { revision: "1", hash: "fixture", layers: [] },
    "/skills": { skills: [], total: 0 }, "/announcements": { announcements: [], unreadCount: 0 }, "/banner-announcements": { banners: [] },
    "/assets": { assets: [], total: 0, hasMore: false, kindCounts: {}, categoryCounts: {}, folderCounts: {}, page: 1, pageSize: 50 },
    "/projects": { projects: [], total: 0 }, "/settings/prompt-templates": { preferences: [] },
    "/model-catalog": { source: "system", channels: [{ id: "fixture", displayName: "Fixture", models: [
        { id: "text", modelKey: "text", displayName: "Fixture text", capability: "text", protocol: "chat-completion", available: true, priceTiers: [] },
        { id: "image", modelKey: "image", displayName: "Fixture image", capability: "image", protocol: "openai-images", available: true, priceTiers: [] },
    ] }] },
};
let project: any;
const tasks = new Map<string, any>(); const requests: any[] = [];
const retryRequests: any[] = [];
const gate = () => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release, entered: false };
};
let saveGate: ReturnType<typeof gate> | undefined;
let taskGate: ReturnType<typeof gate> | undefined;
let failSaves = false;
let pendingProject: any;
const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 12000;
    while (!condition()) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for background submission");
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
};
const report = { passed: [] as string[], pageErrors: [] as string[], blocked: [] as string[] };
const check = (ok: unknown, label: string) => { if (!ok) throw new Error(label); report.passed.push(label); };
const reply = (data: unknown, status = 200) => Response.json({ code: status === 200 ? 0 : status, data, msg: status === 200 ? "" : "isolated fixture blocked" }, { status });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/")) {
        const api = path.slice(4);
        if (request.method === "GET" && api in fixtures) return reply(fixtures[api]);
        if (api === `/canvas-projects/${project?.id}`) {
            if (request.method === "GET") return reply({ project });
            if (request.method === "PUT") {
                const input = await request.json(); pendingProject = input.project;
                if (saveGate) { const current = saveGate; current.entered = true; await current.promise; }
                if (failSaves) return reply(null, 503);
                project = { ...input.project, revision: project.revision + 1 }; return reply({ project });
            }
        }
        if (api.endsWith("/history")) return reply({ snapshots: [], currentRevision: project.revision });
        if (api.endsWith("/tasks/reconcile")) {
            const body = await request.json();
            for (const [id, task] of tasks) if (body.deletedNodeIds?.includes(task.clientContext.nodeId)) tasks.delete(id);
            return reply({ accepted: true });
        }
        if (api === "/user-data/snapshot") return reply({ projects: [project], assets: [] });
        if (api === "/assets/batch") return reply({ assets: [] });
        if (api.startsWith("/assets/") && request.method === "PUT") return reply({ asset: (await request.json()).asset });
        if (api === "/tasks" && request.method === "POST") {
            const input = await request.json(); requests.push(input);
            if (taskGate) { const current = taskGate; current.entered = true; await current.promise; }
            const task = { id: `image-task-${requests.length}`, projectId: project.id, type: input.type, operation: input.operation, status: "running", prompt: input.prompt, model: input.model, attempts: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), clientOperationId: input.clientOperationId || input.input.metadata.clientOperationId, clientContext: { nodeId: input.input.metadata.nodeId } };
            tasks.set(task.id, task); return reply(task);
        }
        if (api === "/tasks") return reply([...tasks.values()]);
        if (api.startsWith("/tasks/image-task-") && api.endsWith("/retry") && request.method === "POST") {
            const input = await request.json().catch(() => ({})); retryRequests.push(input);
            if (input.acknowledgedBillingOrderId !== "pending-image-order") return Response.json({ code: 409, reason: "task_billing_review_required", msg: "上次图片请求未返回结果，费用仍待核对。重新生成会发起新的调用，原调用仍可能产生费用。", details: { billingOrderId: "pending-image-order" } }, { status: 409 });
            const task = tasks.get(api.split("/")[2]);
            Object.assign(task, { status: "queued", stage: "等待队列调度", error: "", updatedAt: new Date().toISOString() });
            return reply(task);
        }
        if (api.startsWith("/tasks/image-task-")) return reply(tasks.get(api.split("/")[2]));
        report.blocked.push(`${request.method} ${api}`); return reply(null, 501);
    }
    const pathOnDisk = resolve(dist, `.${decodeURIComponent(path)}`);
    if (pathOnDisk !== dist && !pathOnDisk.startsWith(dist + sep)) return new Response(null, { status: 403 });
    const file = Bun.file(pathOnDisk);
    return new Response(pathOnDisk !== dist && await file.exists() ? file : Bun.file(join(dist, "index.html")), { headers: { "Cache-Control": "no-store", "Content-Security-Policy": "connect-src 'self' blob:; img-src 'self' data: blob:; media-src 'self' data: blob:" } });
} });
const origin = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
try {
    for (const theme of process.env.WORKFLOW_GRID_ONLY || process.env.WORKFLOW_RETRY_ONLY ? [] : ["dark", "light"]) {
        const f = workflowImageFixture({ failedAssetSummaries: true });
        project = { ...createCanvasPerformanceProject(100, "spread"), nodes: f.nodes.map((node) => ({ ...node, metadata: { ...node.metadata, shortDrama: node.metadata?.shortDrama ? { ...node.metadata.shortDrama, productionAgent: undefined, submission: "submitted" } : undefined } })), connections: f.connections, projectId: "", appearance: { mode: theme }, viewport: { x: 200, y: 200, k: 0.4 } };
        tasks.clear(); requests.length = 0;
        const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, serviceWorkers: "block" });
        await context.addInitScript((theme: string) => { if (location.protocol === "http:") localStorage.setItem("infinite-canvas:canvas-theme", JSON.stringify({ state: { theme }, version: 0 })); }, theme);
        await context.route("**/*", (route: any) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        const page = await context.newPage(); page.setDefaultTimeout(12000);
        page.on("pageerror", (error: Error) => report.pageErrors.push(error.message));
        await page.goto(`${origin}/canvas/${project.id}`);
        const showGuide = async () => { const toggle = page.getByRole("button", { name: "短剧流程", exact: true }); await toggle.waitFor(); if (await toggle.getAttribute("aria-pressed") === "false") await toggle.click(); };
        const guide = page.getByRole("region", { name: "短剧完整制作流程", exact: true });
        const panel = page.locator(".canvas-workflow-generator");
        const open = async (stage: string, task: string) => { await showGuide(); await guide.getByRole("combobox", { name: "短剧制作阶段" }).selectOption(stage); await guide.locator(`[data-task-key="${task}"] button`).click(); await panel.waitFor(); };
        const select = async (name: string, option: string) => { await panel.getByRole("combobox", { name, exact: true }).click(); await page.locator(".ant-select-dropdown:visible").getByText(option, { exact: true }).click(); };
        await showGuide(); await guide.getByRole("combobox", { name: "短剧制作阶段" }).selectOption("assets");
        check(await guide.locator("[data-task-key]").count() === 3, `${theme}: assets have three grouped entries`);
        check((await guide.innerText()).includes("任务失败，提取未完成"), `${theme}: stage explains saved partial assets instead of implying a stale progress counter`);
        await open("storyboard", "guide.direction.breakdown");
        check(await panel.getByRole("combobox", { name: "场次目标、走位与空间关系来源", exact: true }).count() === 0, `${theme}: integrated scene breakdown has no unavailable legacy source field`);
        await page.getByRole("button", { name: "关闭生成设置" }).click();
        await open("assets", "guide.assets.fixed"); await select("制作项目", "特殊资产（按需）");
        await panel.locator("header strong").filter({ hasText: "特殊资产" }).waitFor();
        check((await panel.innerText()).includes("文本模型"), `${theme}: optional special assets remain reachable`);
        await page.getByRole("button", { name: "关闭生成设置" }).click();
        await open("assets", "guide.assets.references");
        await panel.locator("header strong").filter({ hasText: "参考图生成" }).waitFor();
        const imageDialogText = await panel.innerText();
        check(imageDialogText.includes("生图模型") && !imageDialogText.includes("文本模型"), `${theme}: image dialog has no text model`);
        check(imageDialogText.includes("统一设定板"), `${theme}: asset dialog exposes the shared sheet format`);
        check(await panel.getByText("透明背景", { exact: true }).count() === 0, `${theme}: asset sheet cannot inherit a transparent background`);
        await panel.getByRole("button", { name: "选择模型", exact: true }).click();
        const menu = page.locator(".canvas-model-picker-menu:visible");
        check(!(await menu.innerText()).includes("Fixture text"), `${theme}: image picker excludes text models`);
        if (await menu.locator(".canvas-model-picker-brands").count()) await menu.locator(".canvas-model-picker-brand").first().click();
        await menu.getByRole("option").first().click();
        await menu.waitFor({ state: "hidden" });
        const allAssets = panel.getByRole("checkbox", { name: "全选当前组", exact: true });
        check(await allAssets.evaluate((el: HTMLInputElement) => el.indeterminate), `${theme}: initial partial selection is visible`);
        await allAssets.check();
        check((await panel.getByRole("status", { name: "资产选择数量" }).innerText()).includes("已选 2 / 2 项"), `${theme}: select whole group selects all available assets`);
        await allAssets.uncheck();
        check(await panel.getByRole("button", { name: "生成 0 张图片", exact: true }).isDisabled(), `${theme}: clearing group prevents empty submission`);
        await select("图片生成对象", "assets.characters A");
        await page.keyboard.press("Escape");
        check(await allAssets.evaluate((el: HTMLInputElement) => el.indeterminate), `${theme}: manual selection restores partial group state`);
        await allAssets.check();
        await select("制作项目", "场景参考图生成");
        check((await panel.getByRole("status", { name: "资产选择数量" }).innerText()).includes("已选 1 / 2 项"), `${theme}: switching category resets selection`);
        await allAssets.check();
        check((await panel.getByRole("combobox", { name: "图片生成对象" }).locator("..").locator("..").innerText()).includes("assets.environments"), `${theme}: group selection stays in current category`);
        await select("制作项目", "人物参考图生成");
        await allAssets.check();
        await panel.evaluate((el: HTMLElement) => { el.scrollTop = 0; });
        await page.screenshot({ path: join(output, `${theme}-image-dialog.png`), animations: "disabled" });
        check(await panel.locator(".canvas-workflow-asset-selection .ant-checkbox-checked").evaluate((el: HTMLElement) => getComputedStyle(el, "::after").borderBottomColor !== getComputedStyle(el).backgroundColor), `${theme}: selected group checkmark is visible`);
        await page.setViewportSize({ width: 390, height: 640 });
        await page.waitForTimeout(350);
        await page.screenshot({ path: join(output, `${theme}-assets-narrow.png`), animations: "disabled" });
        check(await panel.evaluate((el: HTMLElement) => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1 && el.scrollWidth <= el.clientWidth + 1; }), `${theme}: group selection fits narrow viewport`);
        await page.setViewportSize({ width: 1440, height: 960 });
        check(await panel.getByRole("button", { name: "生成 2 张图片", exact: true }).isEnabled(), `${theme}: failed extraction summary does not block saved assets`);
        saveGate = gate(); taskGate = gate();
        await panel.getByRole("button", { name: "生成 2 张图片", exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
        await panel.waitFor({ state: "hidden", timeout: 1500 });
        await until(() => Boolean(saveGate?.entered));
        check(requests.length === 0, `${theme}: image dialog closes while save is held, before any tasks submit`);
        saveGate.release(); saveGate = undefined;
        await until(() => Boolean(taskGate?.entered));
        check(await panel.count() === 0 && requests.length === 1, `${theme}: dialog stays closed while first task receipt is held`);
        await open("assets", "guide.assets.references");
        check(await panel.locator("fieldset").getAttribute("disabled") !== null && await panel.locator("fieldset > button").last().isDisabled(), `${theme}: reopening during submission prevents duplicate generation`);
        await page.getByRole("button", { name: "关闭生成设置" }).click();
        taskGate.release(); taskGate = undefined;
        await until(() => requests.length === 2);
        check(requests.length === 2 && requests.every((request) => request.type === "canvas_image" && request.input.mode === "image"), `${theme}: real UI submits one image task per selected asset`);
        check(new Set(requests.map((request) => request.input.metadata.nodeId)).size === 2, `${theme}: selected assets get distinct task bindings`);
        check(requests.every((request) => request.prompt.includes("统一设定板模板 v1") && request.prompt.includes("左侧占18%") && request.prompt.includes("正面全身、左侧全身、右侧全身、背面全身")), `${theme}: real image task receives the multi-view sheet prompt`);
        const sheets = project.nodes.filter((node: any) => node.metadata?.shortDrama?.assetSheet);
        check(sheets.length === 2 && sheets.every((node: any) => node.metadata.transparentBackground === "false" && node.metadata.shortDrama.assetSheet.kind === "character" && node.metadata.size === sheets[0].metadata.size), `${theme}: saved sheet contract shares opaque landscape settings`);
        check(sheets.every((node: any) => JSON.stringify(node.metadata.shortDrama.assetSheet.styleSignatures) === JSON.stringify(sheets[0].metadata.shortDrama.assetSheet.styleSignatures)), `${theme}: all submitted subjects use the same project style revision`);
        check(project.nodes.some((node: any) => node.metadata?.shortDrama?.mediaKind === "image" && node.metadata.shortDrama.mediaSubjectId), `${theme}: persisted image node retains asset identity`);
        const mediaGroup = project.nodes.find((node: any) => node.metadata?.shortDrama?.mediaGroup);
        check(mediaGroup && mediaGroup.metadata.shortDrama.sourceNodeIds.length === 2 && project.nodes.filter((node: any) => node.parentId === mediaGroup.id).length === 2, `${theme}: saved images belong to a typed container`);
        check(project.connections.filter((edge: any) => edge.toNodeId === mediaGroup.id).length === 1, `${theme}: image group has one source connection`);
        await page.screenshot({ path: join(output, `${theme}-image-group.png`), animations: "disabled" });
        await page.locator(`[data-node-id="${mediaGroup.id}"]`).first().click({ button: "right", position: { x: 16, y: 16 } });
        await page.getByText("追加生成图片", { exact: true }).waitFor();
        check(await page.getByText("汇总分集文稿", { exact: true }).count() === 0, `${theme}: image group omits text summary action`);
        await page.getByText("追加生成图片", { exact: true }).click();
        await panel.waitFor();
        check((await panel.innerText()).includes("Fixture image"), `${theme}: selected image model survives reopening`);
        await panel.getByRole("button", { name: "生成 1 张图片", exact: true }).click();
        await panel.waitFor({ state: "hidden" });
        await until(() => requests.length === 3);
        check(requests.length === 3 && project.nodes.filter((node: any) => node.metadata?.shortDrama?.mediaGroup).length === 1 && project.nodes.find((node: any) => node.id === mediaGroup.id).metadata.shortDrama.sourceNodeIds.length === 3, `${theme}: later generation appends to the same group`);
        const appendedId = requests[2].input.metadata.nodeId;
        await page.locator(`[data-node-id="${appendedId}"]`).first().click();
        await page.keyboard.press("Delete");
        const deletionDeadline = Date.now() + 10000;
        while (project.nodes.some((node: any) => node.id === appendedId) && Date.now() < deletionDeadline) await page.waitForTimeout(100);
        check(!project.nodes.some((node: any) => node.id === appendedId) && project.nodes.find((node: any) => node.id === mediaGroup.id).metadata.shortDrama.sourceNodeIds.length === 2, `${theme}: node deletion saves and removes group membership`);
        await showGuide(); await guide.getByRole("combobox", { name: "短剧制作阶段" }).selectOption("storyboard");
        check(await guide.locator("[data-task-key]").count() === 4, `${theme}: storyboard has four entries`);
        await open("storyboard", "guide.direction.frames"); await select("制作项目", "镜头尾帧生成（按需）");
        await panel.locator("header strong").filter({ hasText: "镜头尾帧生成" }).waitFor();
        check(await panel.getByRole("textbox", { name: "镜头编号与画面提示词" }).count() === 1, `${theme}: frames are directly selectable`);
        check((await panel.getByRole("textbox", { name: "镜头编号与画面提示词" }).inputValue()).includes("SHOT_1_END"), `${theme}: frame prompt comes from selected shot`);
        await select("生成镜头", "SH02 · Shot 2");
        check((await panel.getByRole("textbox", { name: "镜头编号与画面提示词" }).inputValue()).includes("SHOT_2_END"), `${theme}: changing shot changes its prompt`);
        await panel.getByRole("textbox", { name: "镜头编号与画面提示词" }).fill("EP01-SH02: protagonist opens the door, close-up");
        await page.setViewportSize({ width: 390, height: 640 });
        await page.waitForTimeout(350);
        await panel.evaluate((el: HTMLElement) => { el.scrollTop = 0; });
        await page.screenshot({ path: join(output, `${theme}-frames-narrow.png`), animations: "disabled" });
        check(await panel.evaluate((el: HTMLElement) => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1 && el.scrollWidth <= el.clientWidth + 1; }), `${theme}: dialog fits narrow viewport`);
        check(await panel.locator(".reasoning-effort-select").count() === 0, `${theme}: image settings omit text reasoning`);
        await page.getByRole("button", { name: "关闭生成设置" }).click();
        await page.setViewportSize({ width: 1440, height: 960 });
        await open("story", "story.plan");
        await panel.getByRole("button", { name: "选择模型", exact: true }).click();
        if (await menu.locator(".canvas-model-picker-brands").count()) await menu.locator(".canvas-model-picker-brand").first().click();
        await menu.locator(".canvas-model-picker-options").getByRole("option").first().click();
        await menu.waitFor({ state: "hidden" });
        saveGate = gate(); taskGate = gate();
        await panel.getByRole("button", { name: "生成制作方案", exact: true }).click();
        await panel.waitFor({ state: "hidden", timeout: 1500 });
        await until(() => Boolean(saveGate?.entered));
        check(requests.length === 3, `${theme}: text dialog closes before slow save completes`);
        saveGate.release(); saveGate = undefined;
        await until(() => Boolean(taskGate?.entered));
        check(await panel.count() === 0 && requests[3].type === "canvas_text", `${theme}: text submission continues after dialog unmounts`);
        taskGate.release(); taskGate = undefined;
        await open("story", "story.plan");
        saveGate = gate(); failSaves = true;
        await panel.getByRole("button", { name: "生成制作方案", exact: true }).click();
        await panel.waitFor({ state: "hidden", timeout: 1500 });
        await until(() => Boolean(saveGate?.entered));
        const unsaved = pendingProject.nodes.find((node: any) => node.metadata?.shortDrama?.step === "story.plan" && node.metadata.shortDrama.submission === "planned" && !project.nodes.some((saved: any) => saved.id === node.id));
        check(Boolean(unsaved), `${theme}: failed-save scenario has a locally prepared text node`);
        saveGate.release(); saveGate = undefined;
        await page.getByText("结果节点已保留，云端保存失败，尚未发起生成；恢复后可右键继续提交", { exact: true }).waitFor();
        check(requests.length === 4 && await panel.count() === 0, `${theme}: background save failure is visible without starting a task or reopening dialog`);
        await page.locator(`[data-node-id="${unsaved.id}"]`).first().getByRole("button", { name: "查看详情并继续", exact: true }).click();
        const details = page.getByRole("dialog").filter({ has: page.getByLabel("制作执行进度", { exact: true }) });
        await details.waitFor();
        check((await details.innerText()).includes("尚未提交生成") && (await details.innerText()).includes("云端保存失败"), `${theme}: node details retain the save failure and distinguish it from running a model`);
        check(await details.getByRole("button", { name: "继续提交", exact: true }).isEnabled(), `${theme}: failed save has a resumable action in details`);
        await page.setViewportSize({ width: 390, height: 640 });
        await page.waitForTimeout(3500);
        await page.screenshot({ path: join(output, `${theme}-save-failure-details.png`), animations: "disabled" });
        check(await details.evaluate((el: HTMLElement) => el.scrollWidth <= el.clientWidth + 1), `${theme}: workflow details fit narrow viewport`);
        await page.setViewportSize({ width: 1440, height: 960 });
        failSaves = false;
        await details.getByRole("button", { name: "继续提交", exact: true }).click();
        await until(() => requests.length === 5);
        check(requests[4].input.metadata.nodeId === unsaved.id && project.nodes.filter((node: any) => node.id === unsaved.id).length === 1, `${theme}: retry submits the retained node without duplicating it`);
        await details.getByRole("button", { name: "Close", exact: true }).click();
        await open("storyboard", "guide.direction.breakdown");
        saveGate = gate(); failSaves = true;
        await panel.getByRole("button", { name: "生成场次与镜头拆解", exact: true }).click();
        await panel.waitFor({ state: "hidden", timeout: 1500 });
        await until(() => Boolean(saveGate?.entered));
        const shotGroup = pendingProject.nodes.find((node: any) => node.metadata?.shortDrama?.step === "direction.shots" && node.metadata.shortDrama.role === "collection" && !project.nodes.some((saved: any) => saved.id === node.id));
        check(Boolean(shotGroup), `${theme}: storyboard fanout creates an episode container before submission`);
        saveGate.release(); saveGate = undefined;
        const groupNode = page.locator(`[data-node-id="${shotGroup.id}"]`).first();
        await groupNode.getByRole("button", { name: "查看分组任务详情", exact: true }).click();
        await details.waitFor();
        await details.getByText("尚未提交生成", { exact: true }).first().waitFor();
        check(await details.getByText("尚未提交生成", { exact: true }).count() === 2 && requests.length === 5, `${theme}: container shows both unsaved episodes and no model calls`);
        check(await details.locator("section[aria-label]").count() === 2, `${theme}: container details contain only their own two episode tasks`);
        await page.waitForTimeout(350);
        await page.screenshot({ path: join(output, `${theme}-episode-task-details.png`), animations: "disabled" });
        failSaves = false;
        await details.getByRole("button", { name: "继续提交（2）", exact: true }).click();
        await until(() => requests.length === 7);
        check(new Set(requests.slice(-2).map((request) => request.input.metadata.nodeId)).size === 2, `${theme}: group resume submits each existing episode once`);
        await details.getByRole("button", { name: "Close", exact: true }).click();
        await context.close();
    }
    for (const theme of process.env.WORKFLOW_GRID_ONLY || process.env.WORKFLOW_RETRY_ONLY ? [] : ["dark", "light"]) {
        const f = workflowImageFixture();
        const request = { ...f.request, imageSubjectIds: workflowImageSubjects(f.request, f.nodes).map((node) => node.id) };
        const first = createWorkflowImages(request, f.nodes, f.connections, { x: 0, y: 0 });
        const second = createWorkflowImages(request, first.nodes, first.connections, { x: 0, y: 0 });
        const group = second.nodes.find((node) => node.id === first.created[0].parentId)!;
        delete group.metadata!.shortDrama!.mediaGroup!.layout;
        const images = second.nodes.filter((node) => node.parentId === group.id);
        const paths = ["/welcome/charge/character-final.webp", "/short-drama-styles/urban-live-action.jpg", "/welcome/charge/factory-final.webp", "/welcome/charge/robot.webp"];
        images.forEach((node, index) => {
            node.width = 180 + index * 120; node.height = 700 - index * 130;
            node.position = { x: group.position.x + index * 180, y: group.position.y + 80 };
            Object.assign(node.metadata!, { content: paths[index], status: "success", manualSize: false });
            node.metadata!.shortDrama!.submission = "submitted";
        });
        project = { ...createCanvasPerformanceProject(100, "spread"), nodes: second.nodes, connections: second.connections, projectId: "", appearance: { mode: theme }, viewport: { x: 210 - group.position.x * 0.85, y: 130 - group.position.y * 0.85, k: 0.85 } };
        tasks.clear(); requests.length = 0;
        const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, serviceWorkers: "block" });
        await context.route("**/*", (route: any) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        const page = await context.newPage(); page.setDefaultTimeout(12000);
        page.on("pageerror", (error: Error) => report.pageErrors.push(error.message));
        await page.goto(`${origin}/canvas/${project.id}`);
        const toggle = page.getByRole("button", { name: "短剧流程", exact: true });
        await toggle.waitFor(); if (await toggle.getAttribute("aria-pressed") === "true") await toggle.click();
        for (const image of images) await page.waitForFunction((id: string) => {
            const node = document.querySelector(`[data-node-id="${id}"]`) as HTMLElement | null;
            const img = node?.querySelector("img");
            return node?.style.width === "280px" && node.style.height === "280px" && img?.complete && img.naturalWidth > 0;
        }, image.id);
        const rects = await Promise.all(images.map((image) => page.locator(`[data-node-id="${image.id}"]`).first().boundingBox()));
        check(rects.every((rect: any) => Math.abs(rect.width - rect.height) < 1) && Math.abs(rects[0].y - rects[2].y) < 1 && rects[3].y > rects[0].y + rects[0].height && rects[1].x > rects[0].x + rects[0].width, `${theme}: legacy mixed-ratio images become equal cells with row and column gaps`);
        const imageNode = page.locator(`[data-node-id="${images[0].id}"]`).first();
        const preview = imageNode.getByRole("button", { name: `预览图片：${images[0].title}`, exact: true });
        await imageNode.hover();
        check(await preview.evaluate((el: HTMLElement) => getComputedStyle(el).opacity === "1"), `${theme}: hover reveals preview icon`);
        check(await imageNode.locator("img").first().evaluate((el: HTMLImageElement) => getComputedStyle(el).objectFit === "contain"), `${theme}: image cells preserve the whole image`);
        await page.screenshot({ path: join(output, `${theme}-image-grid.png`), animations: "disabled" });
        const position = await imageNode.getAttribute("style");
        await preview.click();
        const lightbox = page.locator(".canvas-image-lightbox[role=dialog]");
        await lightbox.waitFor();
        const fullImage = lightbox.locator(".ant-image-preview-img");
        await fullImage.evaluate((image: HTMLImageElement) => image.decode());
        await lightbox.getByRole("button", { name: "放大图片", exact: true }).click();
        await page.waitForFunction(() => document.querySelector('.canvas-image-lightbox output')?.textContent !== "100%");
        check((await lightbox.getByLabel("图片缩放比例", { exact: true }).innerText()) !== "100%", `${theme}: preview zoom button updates scale`);
        const imageRect = await fullImage.boundingBox();
        const transformBefore = await fullImage.getAttribute("style");
        const dragX = Math.min(900, imageRect.x + imageRect.width / 2), dragY = Math.min(600, imageRect.y + imageRect.height / 2);
        await page.mouse.move(dragX, dragY); await page.mouse.down(); await page.mouse.move(dragX + 60, dragY + 45, { steps: 6 });
        check(await fullImage.getAttribute("style") !== transformBefore, `${theme}: preview pans horizontally and vertically`);
        await page.mouse.up();
        await lightbox.getByRole("button", { name: "缩小图片", exact: true }).click();
        await lightbox.getByRole("button", { name: "复位图片", exact: true }).click();
        await page.waitForFunction(() => document.querySelector('.canvas-image-lightbox output')?.textContent === "100%");
        check((await lightbox.getByLabel("图片缩放比例", { exact: true }).innerText()) === "100%", `${theme}: preview resets to fit`);
        await lightbox.getByRole("button", { name: "向右旋转图片", exact: true }).click();
        await page.waitForFunction(() => (document.querySelector('.canvas-image-lightbox .ant-image-preview-img') as HTMLElement)?.style.transform.includes("rotate(90deg)"));
        check((await fullImage.getAttribute("style")).includes("rotate(90deg)"), `${theme}: preview rotation works`);
        await lightbox.getByRole("button", { name: "复位图片", exact: true }).click();
        await page.waitForFunction(() => (document.querySelector('.canvas-image-lightbox .ant-image-preview-img') as HTMLElement)?.style.transform.includes("rotate(0deg)"));
        await page.screenshot({ path: join(output, `${theme}-image-preview.png`), animations: "disabled" });
        await page.keyboard.press("Delete");
        check(await imageNode.count() === 1, `${theme}: preview keyboard does not delete canvas node`);
        await page.keyboard.press("Escape"); await lightbox.waitFor({ state: "hidden" });
        check(await imageNode.getAttribute("style") === position, `${theme}: preview interaction leaves canvas geometry unchanged`);
        await preview.focus(); await page.keyboard.press("Enter"); await lightbox.waitFor();
        check((await lightbox.getByLabel("图片缩放比例", { exact: true }).innerText()) === "100%", `${theme}: keyboard opens a fresh preview`);
        await page.setViewportSize({ width: 390, height: 640 });
        await page.waitForTimeout(250);
        check(await lightbox.locator(".canvas-image-preview-tools").evaluate((el: HTMLElement) => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }), `${theme}: preview controls fit narrow viewport`);
        check(await lightbox.locator(".canvas-image-preview-tools").evaluate((el: HTMLElement) => {
            const luminance = (color: string) => (color.match(/[\d.]+/g) || []).slice(0, 3).map(Number).map((v) => v / 255).map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
            const a = luminance(getComputedStyle(el).backgroundColor), b = luminance(getComputedStyle(el.querySelector("button")!).color);
            return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5;
        }), `${theme}: preview icons have readable contrast`);
        await page.screenshot({ path: join(output, `${theme}-image-preview-narrow.png`), animations: "disabled" });
        await page.keyboard.press("Escape"); await lightbox.waitFor({ state: "hidden" });
        await page.setViewportSize({ width: 1440, height: 960 });
        await page.locator(`[data-node-id="${group.id}"]`).first().click({ button: "right", position: { x: 16, y: 16 } });
        await page.getByText("整理图片排列", { exact: true }).click();
        check(await imageNode.getAttribute("style") === position, `${theme}: container menu can restore the grid without changing image identity`);
        check(requests.length === 0, `${theme}: arranging and previewing creates no generation tasks`);
        await context.close();
    }
    for (const theme of process.env.WORKFLOW_RETRY_ONLY ? [] : ["dark", "light"]) {
        const f = workflowImageFixture();
        const ids = workflowImageSubjects(f.request, f.nodes).map((node) => node.id);
        let prepared = { nodes: f.nodes, connections: f.connections, created: [] as typeof f.nodes };
        for (let i = 0; i < 6; i++) prepared = createWorkflowImages({ ...f.request, imageSubjectIds: i === 5 ? ids.slice(0, 1) : ids }, prepared.nodes, prepared.connections, { x: 0, y: 0 });
        const groupId = prepared.created[0].parentId!;
        const group = prepared.nodes.find((node) => node.id === groupId)!;
        const members = prepared.nodes.filter((node) => node.parentId === groupId);
        tasks.clear(); requests.length = 0;
        members.forEach((node, index) => {
            const id = `image-task-pending-${index}`;
            Object.assign(node.metadata!, { status: "loading", taskId: id, taskStage: "排队中" });
            node.metadata!.shortDrama!.submission = "submitted";
            tasks.set(id, { id, type: "canvas_image", status: "queued", createdAt: new Date().toISOString(), clientContext: { nodeId: node.id } });
        });
        project = { ...createCanvasPerformanceProject(100, "spread"), nodes: prepared.nodes, connections: prepared.connections, projectId: "", appearance: { mode: theme }, viewport: { x: 180 - group.position.x * 0.6, y: 80 - group.position.y * 0.6, k: 0.6 } };
        const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, serviceWorkers: "block" });
        await context.route("**/*", (route: any) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        const page = await context.newPage(); page.setDefaultTimeout(12000);
        page.on("pageerror", (error: Error) => report.pageErrors.push(error.message));
        await page.goto(`${origin}/canvas/${project.id}`);
        const toggle = page.getByRole("button", { name: "短剧流程", exact: true });
        await toggle.waitFor(); if (await toggle.getAttribute("aria-pressed") === "true") await toggle.click();
        const frame = page.locator(`[data-node-id="${groupId}"]`).first();
        await frame.waitFor();
        const checkGrid = async (label: string) => {
            const boxes = [];
            for (const member of members) {
                const locator = page.locator(`[data-node-id="${member.id}"]`).first();
                await locator.waitFor(); boxes.push(await locator.boundingBox());
            }
            const expected = boxes[0];
            const unit = expected.width / 280;
            if (label === "on open") {
                await page.screenshot({ path: join(output, `${theme}-pending-image-grid-open.png`), animations: "disabled" });
                writeFileSync(join(output, `${theme}-pending-grid-geometry.json`), JSON.stringify({ boxes, styles: await page.locator('[data-node-id]').evaluateAll((elements: HTMLElement[]) => elements.map((el) => ({ id: el.dataset.nodeId, style: el.getAttribute("style"), top: getComputedStyle(el).top, left: getComputedStyle(el).left, translate: getComputedStyle(el).translate }))) }, null, 2));
            }
            check(boxes.every((box: any, index) => Math.abs(box.x - expected.x - (index % 3) * 304 * unit) < 1 && Math.abs(box.y - expected.y - Math.floor(index / 3) * 328 * unit) < 1 && Math.abs(box.width - expected.width) < 1 && Math.abs(box.height - expected.height) < 1), `${theme}: eleven pending images aligned ${label}`);
        };
        await checkGrid("on open");
        const rect = await frame.boundingBox();
        await page.mouse.move(rect.x + 100, rect.y + 18); await page.mouse.down();
        await page.mouse.move(rect.x + 175, rect.y + 75, { steps: 8 });
        await checkGrid("during container drag");
        await page.mouse.up(); await page.waitForTimeout(250);
        await checkGrid("after container drag");
        const moved = await frame.boundingBox();
        await page.mouse.move(moved.x + 100, moved.y + 18); await page.mouse.down();
        await page.mouse.move(moved.x + 45, moved.y + 48, { steps: 8 });
        await page.keyboard.press("Escape"); await page.mouse.up();
        await checkGrid("after cancelled drag");
        await page.mouse.move(1100, 800); await page.keyboard.down("Control"); await page.mouse.wheel(0, 150); await page.keyboard.up("Control");
        await page.waitForTimeout(400);
        await checkGrid("after zoom");
        await page.screenshot({ path: join(output, `${theme}-pending-image-grid.png`), animations: "disabled" });
        check(requests.length === 0, `${theme}: pending grid gestures do not create tasks`);
        await context.close();
    }
    for (const theme of process.env.WORKFLOW_GRID_ONLY ? [] : ["dark", "light"]) {
        const f = workflowImageFixture();
        const prepared = createWorkflowImages({ ...f.request, imageSubjectIds: workflowImageSubjects(f.request, f.nodes).map((node) => node.id) }, f.nodes, f.connections, { x: 0, y: 0 });
        const image = prepared.created[0];
        const group = prepared.nodes.find((node) => node.id === image.parentId)!;
        const taskId = "image-task-retry";
        tasks.clear(); requests.length = 0; retryRequests.length = 0;
        Object.assign(image.metadata!, { status: "error", taskId, taskStatus: "failed", taskStage: "任务失败", errorDetails: "模型服务响应超时，请稍后重试" });
        image.metadata!.shortDrama!.submission = "submitted";
        tasks.set(taskId, { id: taskId, type: "canvas_image", status: "failed", error: image.metadata!.errorDetails, createdAt: new Date().toISOString(), clientContext: { nodeId: image.id } });
        project = { ...createCanvasPerformanceProject(100, "spread"), nodes: prepared.nodes, connections: prepared.connections, projectId: "", appearance: { mode: theme }, viewport: { x: 180 - group.position.x * 0.8, y: 120 - group.position.y * 0.8, k: 0.8 } };
        const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, serviceWorkers: "block" });
        await context.addInitScript((theme: string) => { if (location.protocol === "http:") localStorage.setItem("infinite-canvas:canvas-theme", JSON.stringify({ state: { theme }, version: 0 })); }, theme);
        await context.route("**/*", (route: any) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        const page = await context.newPage(); page.setDefaultTimeout(12000);
        page.on("pageerror", (error: Error) => report.pageErrors.push(error.message));
        await page.goto(`${origin}/canvas/${project.id}`);
        const node = page.locator(`[data-node-id="${image.id}"]`).first();
        const guideToggle = page.getByRole("button", { name: "短剧流程", exact: true });
        await guideToggle.waitFor();
        if (await guideToggle.getAttribute("aria-pressed") === "true") await guideToggle.click();
        const retry = node.getByRole("button", { name: "重新生成", exact: true }).first();
        await retry.click();
        const dialog = page.getByRole("dialog");
        await dialog.waitFor();
        check(retryRequests.length === 1 && !retryRequests[0].acknowledgedBillingOrderId, `${theme}: pending billing opens confirmation without new generation`);
        await dialog.getByRole("button", { name: "确认重新生成" }).waitFor();
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(output, `${theme}-retry-billing-confirmation.png`), animations: "disabled" });
        await dialog.getByRole("button", { name: "暂不生成" }).click();
        await dialog.waitFor({ state: "hidden" });
        check(tasks.get(taskId).status === "failed" && retryRequests.length === 1 && requests.length === 0, `${theme}: cancelled retry keeps failed task and original node`);
        await retry.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
        await dialog.waitFor();
        check(await dialog.count() === 1, `${theme}: repeated clicks share one confirmation`);
        await page.setViewportSize({ width: 390, height: 640 });
        await page.waitForTimeout(200);
        check(await dialog.evaluate((element: HTMLElement) => { const r = element.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 && element.scrollWidth <= element.clientWidth + 1; }), `${theme}: confirmation fits narrow viewport`);
        await page.screenshot({ path: join(output, `${theme}-retry-billing-narrow.png`), animations: "disabled" });
        await dialog.getByRole("button", { name: "确认重新生成" }).click();
        await dialog.waitFor({ state: "hidden" });
        await until(() => tasks.get(taskId).status === "queued");
        check(retryRequests.length === 3 && retryRequests[2].acknowledgedBillingOrderId === "pending-image-order", `${theme}: explicit confirmation submits one attempt bound to old order`);
        check(requests.length === 0 && prepared.nodes.filter((item) => item.id === image.id).length === 1 && image.parentId === group.id, `${theme}: retry reuses node and image container`);
        await context.close();
    }
    for (const theme of process.env.WORKFLOW_GRID_ONLY ? [] : ["dark", "light"]) {
        const f = workflowImageFixture();
        const prepared = createWorkflowImages({ ...f.request, imageSubjectIds: [workflowImageSubjects(f.request, f.nodes)[0].id] }, f.nodes, f.connections, { x: 0, y: 0 });
        const image = prepared.created[0];
        const group = prepared.nodes.find((node) => node.id === image.parentId)!;
        const taskId = "image-task-moderated";
        tasks.clear(); requests.length = 0; retryRequests.length = 0;
        const originalPrompt = image.metadata!.prompt!;
        Object.assign(image.metadata!, { status: "error", taskId, taskStatus: "failed", errorDetails: "请求内容未通过模型服务安全审核，请调整后重试" });
        image.metadata!.shortDrama!.submission = "submitted";
        tasks.set(taskId, { id: taskId, type: "canvas_image", status: "failed", prompt: originalPrompt, error: image.metadata!.errorDetails, createdAt: new Date().toISOString(), clientContext: { nodeId: image.id } });
        project = { ...createCanvasPerformanceProject(100, "spread"), nodes: prepared.nodes, connections: prepared.connections, projectId: "", appearance: { mode: theme }, viewport: { x: 180 - group.position.x * 0.8, y: 120 - group.position.y * 0.8, k: 0.8 } };
        const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, serviceWorkers: "block" });
        await context.addInitScript((theme: string) => { if (location.protocol === "http:") localStorage.setItem("infinite-canvas:canvas-theme", JSON.stringify({ state: { theme }, version: 0 })); }, theme);
        await context.route("**/*", (route: any) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        const page = await context.newPage(); page.setDefaultTimeout(12000);
        page.on("pageerror", (error: Error) => report.pageErrors.push(error.message));
        await page.goto(`${origin}/canvas/${project.id}`);
        const guide = page.getByRole("button", { name: "短剧流程", exact: true });
        await guide.waitFor(); if (await guide.getAttribute("aria-pressed") === "true") await guide.click();
        const node = page.locator(`[data-node-id="${image.id}"]`).first();
        const edit = node.getByRole("button", { name: "修改生成要求", exact: true });
        await edit.click();
        const dialog = page.getByRole("dialog");
        await dialog.waitFor();
        const input = dialog.getByRole("textbox", { name: "图片生成要求" });
        check(await input.inputValue() === originalPrompt, `${theme}: rejected image opens original prompt editor`);
        await dialog.getByRole("button", { name: "保存并生成" }).click();
        await page.getByText("请先修改生成要求，不能原样重试审核未通过的内容", { exact: true }).waitFor();
        check(await dialog.isVisible() && requests.length === 0 && retryRequests.length === 0, `${theme}: unchanged moderated prompt cannot submit`);
        await input.fill("Unsaved draft");
        await dialog.getByRole("button", { name: /取\s*消/ }).click();
        await dialog.waitFor({ state: "hidden" });
        check(requests.length === 0 && tasks.get(taskId).status === "failed", `${theme}: cancelled edit leaves failed task intact`);
        await edit.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
        await dialog.waitFor();
        check(await dialog.count() === 1 && await input.inputValue() === originalPrompt, `${theme}: repeated clicks open one editor and cancelled draft is discarded`);
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(output, `${theme}-moderation-edit.png`), animations: "disabled" });
        await page.setViewportSize({ width: 390, height: 640 });
        await page.waitForTimeout(250);
        check(await dialog.evaluate((el: HTMLElement) => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 && el.scrollWidth <= el.clientWidth + 1; }), `${theme}: prompt editor fits narrow screen`);
        await page.screenshot({ path: join(output, `${theme}-moderation-edit-narrow.png`), animations: "disabled" });
        const revised = "非功能性影视道具，统一设定板，仅展示外观、涂装和表面磨损。";
        await input.fill(revised);
        await dialog.getByRole("button", { name: "保存并生成" }).click();
        await dialog.waitFor({ state: "hidden" });
        await until(() => requests.length === 1);
        check(retryRequests.length === 0 && requests[0].prompt === revised && requests[0].input.metadata.retryOf === taskId && requests[0].input.metadata.nodeId === image.id, `${theme}: revised request creates one linked task with edited input`);
        await until(() => project.nodes.some((item: any) => item.id === image.id && item.metadata?.taskId === "image-task-1"));
        const saved = project.nodes.find((item: any) => item.id === image.id);
        check(saved.parentId === group.id && saved.metadata.prompt === revised && tasks.get(taskId).status === "failed", `${theme}: revised prompt and new task persist on original node/container`);
        await context.close();
    }
    for (const theme of process.env.WORKFLOW_GRID_ONLY ? [] : ["dark", "light"]) {
        for (const entry of ["node", "dialog"]) {
            const f = workflowImageFixture();
            const prepared = createWorkflowImages({ ...f.request, imageSubjectIds: [workflowImageSubjects(f.request, f.nodes)[0].id] }, f.nodes, f.connections, { x: 0, y: 0 });
            const image = prepared.created[0];
            const group = prepared.nodes.find((node) => node.id === image.parentId)!;
            const originalPrompt = image.metadata!.prompt!;
            const expected = adjustWorkflowImagePrompt(image, prepared.nodes, originalPrompt);
            const taskId = "image-task-auto";
            tasks.clear(); requests.length = 0; retryRequests.length = 0;
            Object.assign(image.metadata!, { status: "error", taskId, taskStatus: "failed", errorDetails: "请求内容未通过模型服务安全审核，请调整后重试" });
            image.metadata!.shortDrama!.submission = "submitted";
            tasks.set(taskId, { id: taskId, type: "canvas_image", status: "failed", prompt: originalPrompt, error: image.metadata!.errorDetails, createdAt: new Date().toISOString(), clientContext: { nodeId: image.id } });
            project = { ...createCanvasPerformanceProject(100, "spread"), nodes: prepared.nodes, connections: prepared.connections, projectId: "", appearance: { mode: theme }, viewport: { x: 180 - group.position.x * 0.8, y: 120 - group.position.y * 0.8, k: 0.8 } };
            const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, serviceWorkers: "block" });
            await context.addInitScript((theme: string) => { if (location.protocol === "http:") localStorage.setItem("infinite-canvas:canvas-theme", JSON.stringify({ state: { theme }, version: 0 })); }, theme);
            await context.route("**/*", (route: any) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
            const page = await context.newPage(); page.setDefaultTimeout(12000);
            page.on("pageerror", (error: Error) => report.pageErrors.push(error.message));
            await page.goto(`${origin}/canvas/${project.id}`);
            const guide = page.getByRole("button", { name: "短剧流程", exact: true });
            await guide.waitFor(); if (await guide.getAttribute("aria-pressed") === "true") await guide.click();
            const node = page.locator(`[data-node-id="${image.id}"]`).first();
            const auto = node.getByRole("button", { name: "自动调整并重试", exact: true });
            await auto.waitFor();
            check(await auto.evaluate((el: HTMLElement) => el.scrollWidth <= el.clientWidth + 1), `${theme}/${entry}: automatic retry label fits card`);
            let button = auto;
            if (entry === "dialog") {
                await node.getByRole("button", { name: "修改生成要求", exact: true }).click();
                button = page.getByRole("dialog").getByRole("button", { name: "自动调整并重试", exact: true });
                await button.waitFor(); await page.setViewportSize({ width: 390, height: 640 });
            }
            await page.waitForTimeout(400);
            await page.screenshot({ path: join(output, `${theme}-auto-retry-${entry}.png`), animations: "disabled" });
            taskGate = gate();
            await button.evaluate((el: HTMLButtonElement) => { el.click(); el.click(); });
            await until(() => taskGate!.entered);
            check(requests.length === 1 && retryRequests.length === 0 && requests[0].prompt === expected && requests[0].type === "canvas_image", `${theme}/${entry}: one click adjusts and creates one image task without a text call`);
            await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 1500 });
            check(await page.getByRole("dialog").count() === 0, `${theme}/${entry}: automatic action needs no extra confirmation and closes editor promptly`);
            taskGate.release(); taskGate = undefined;
            await until(() => project.nodes.some((item: any) => item.id === image.id && item.metadata?.taskId === "image-task-1"));
            const saved = project.nodes.find((item: any) => item.id === image.id);
            check(saved.parentId === group.id && saved.metadata.prompt === expected && saved.metadata.model === image.metadata!.model && tasks.get(taskId).prompt === originalPrompt, `${theme}/${entry}: original task, container and model are preserved`);
            Object.assign(tasks.get("image-task-1"), { status: "failed", error: "请求内容未通过模型服务安全审核，请调整后重试" });
            Object.assign(saved.metadata, { status: "error", taskStatus: "failed", errorDetails: "请求内容未通过模型服务安全审核，请调整后重试" });
            await page.setViewportSize({ width: 1440, height: 960 }); await page.reload();
            await auto.waitFor();
            if (await guide.getAttribute("aria-pressed") === "true") await guide.click();
            await auto.click();
            await page.getByText("已按当前资产调整过，仍未通过审核，请手动修改生成要求；未再次提交", { exact: true }).waitFor();
            check(requests.length === 1 && retryRequests.length === 0, `${theme}/${entry}: renewed moderation after reload does not loop or resubmit identical adjustment`);
            await context.close();
        }
    }
    check(report.pageErrors.length === 0, "no runtime errors");
} finally {
    saveGate?.release(); taskGate?.release();
    writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    await browser.close(); server.stop(true);
}
