/** Actual canvas UI; all task/model APIs stay inside the isolated fixture. */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createShortDramaPipeline } from "../src/lib/canvas/canvas-short-drama";
import { createWorkflowDocuments, nodeWorkflow } from "../src/lib/canvas/canvas-short-drama-workflow";
import { canonicalize } from "json-canonicalize";
import { commitCanvasGenerationResult } from "../src/lib/canvas/canvas-generation-result";
import { bibleOutput } from "../test/fixtures/workflow-asset-output";
import { shortDramaStep } from "../src/lib/short-drama-steps";
import { productionBibleSections } from "../src/lib/production-bible";
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const origin = "http://127.0.0.1:4014";
if ((await (await fetch(`${origin}/api/auth/session`)).json()).data?.user?.id !== "canvas-benchmark") throw new Error("Isolated fixture required");
const canvasId = "benchmark-100-spread";
const original = (await (await fetch(`${origin}/api/canvas-projects/${canvasId}`)).json()).data.project;
const output = resolve("../.local/canvas-benchmark/production-agent-current");
mkdirSync(output, { recursive: true });
const report = { passed: [] as string[], errors: [] as string[], blocked: [] as string[] };
const check = (value: boolean, label: string) => { if (!value) throw new Error(label); report.passed.push(label); };
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
try {
    for (const theme of ["dark", "light"]) {
        const p = createShortDramaPipeline({ x: 0, y: 0 }, true);
        p.nodes[0].metadata!.content = "采用的选题：相机与记忆";
        const request = { step: "story.plan" as const, pipelineId: nodeWorkflow(p.nodes[0])!.pipelineId, sourceNodeIds: [p.nodes[0].id], model: "fixture", instruction: "", episodeCount: 3, minutesPerEpisode: "2", start: 1, count: 3 };
        let result = createWorkflowDocuments(request, p.nodes, p.connections, { x: 0, y: 0 });
        result.created.forEach((node) => Object.assign(node.metadata!, { content: "三集相机故事制作方案", status: "success" }));
        result = createWorkflowDocuments({ ...request, step: "story.episodes", sourceNodeIds: [result.created[0].id] }, result.nodes, result.connections, { x: 0, y: 0 });
        result.created.forEach((node) => Object.assign(node.metadata!, { content: "林岚找回旧相机，回到照相馆。", status: "success" }));
        result = createWorkflowDocuments({ ...request, step: "story.body", sourceNodeIds: [result.created[0].id] }, result.nodes, result.connections, { x: 0, y: 0 });
        result.created.forEach((node, i) => Object.assign(node.metadata!, { content: `第${i + 1}集 林岚提着旧相机走进照相馆。`, status: "success" }));
        const bodies = result.nodes.find((node) => nodeWorkflow(node)?.step === "story.body" && nodeWorkflow(node)?.role === "collection")!;
        result = createWorkflowDocuments({ ...request, step: "assets.bible", sourceNodeIds: [bodies.id] }, result.nodes, result.connections, { x: 0, y: 0 });
        const oldBible = result.created[0];
        oldBible.metadata!.shortDrama!.productionAgent = undefined;
        result.nodes = commitCanvasGenerationResult(result.nodes, oldBible, { ...oldBible, metadata: { ...oldBible.metadata, content: bibleOutput, status: "success" } }, "fixture");
        const bibleFrame = result.nodes.find((node) => node.id === oldBible.parentId)!;
        let cloud: any = JSON.parse(canonicalize({ ...original, nodes: result.nodes, connections: result.connections, projectId: "", appearance: { mode: theme }, viewport: { x: 320 - bibleFrame.position.x * 0.65, y: 80 - bibleFrame.position.y * 0.65, k: 0.65 } }));
        const context = await browser.newContext({ viewport: { width: 1440, height: 945 }, serviceWorkers: "block" });
        await context.addInitScript((value: string) => { if (location.protocol === "http:") localStorage.setItem("infinite-canvas:canvas-theme", JSON.stringify({ state: { theme: value }, version: 0 })); }, theme);
        const page = await context.newPage(); page.setDefaultTimeout(15000);
        page.on("pageerror", (e: Error) => report.errors.push(e.message));
        let run: any; let secondRun: any; let pendingRun: any; let secondReadFails = true; let pendingAttempts = 0; let creates = 0; let taskCreates = 0; let submissionKey = "";
        let failMarkerSave = theme === "dark";
        let generationConflict = false;
        let deletionConflict = false;
        let concurrentX = 0;
        const controls: string[] = [];
        await context.route("**/*", async (route: any) => {
            const req = route.request(); const url = new URL(req.url()); const path = url.pathname;
            const reply = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ code: status === 200 ? 0 : status, data, msg: status === 200 ? "" : "fixture failure" }) });
            if (url.origin !== origin) { report.blocked.push(path); return route.abort(); }
            if (path === "/api/model-catalog") return reply({ source: "system", channels: [{ id: "fixture", displayName: "Fixture channel", models: [{ id: "story-text", modelKey: "story-text", displayName: "Fixture text", capability: "text", protocol: "openai", available: true, priceTiers: [] }] }] });
            if (path === `/api/canvas-projects/${canvasId}/tasks/reconcile`) {
                if (run && !cloud.nodes.some((node: any) => node.id === run.production.targetNodeId)) { run.status = "cancelled"; run.removed = true; }
                return reply({ accepted: true });
            }
            if (path === `/api/canvas-projects/${canvasId}` && req.method() === "GET") return reply({ project: cloud });
            if (path === `/api/canvas-projects/${canvasId}` && req.method() === "PUT") {
                const input = req.postDataJSON();
                if (!generationConflict && input.project.nodes.some((node: any) => node.metadata?.shortDrama?.productionAgent)) {
                    generationConflict = true;
                    const concurrent = cloud.nodes.find((node: any) => node.id === oldBible.id);
                    concurrent.position.x += 47; concurrentX = concurrent.position.x;
                    cloud.revision++;
                    return reply(null, 409);
                }
                if (!deletionConflict && run && cloud.nodes.some((node: any) => node.id === run.production.targetNodeId) && !input.project.nodes.some((node: any) => node.id === run.production.targetNodeId)) {
                    deletionConflict = true;
                    cloud.nodes.find((node: any) => node.id === run.production.targetNodeId).metadata.taskStage = "late background update";
                    cloud.revision++;
                    return reply(null, 409);
                }
                if (input.project.revision !== cloud.revision) return reply(null, 409);
                if (!run && input.project.nodes.some((node: any) => node.metadata?.shortDrama?.productionAgent?.request)) {
                    if (failMarkerSave) return reply(null, 503);
                    await new Promise((resolve) => setTimeout(resolve, 2600));
                }
                cloud = JSON.parse(canonicalize({ ...input.project, revision: cloud.revision + 1 })); return reply({ project: cloud });
            }
            if (path === "/api/tasks" && req.method() === "POST") { taskCreates++; return reply(null, 400); }
            if (path === "/api/agent/runs" && req.method() === "POST") {
                const input = req.postDataJSON();
                if (input.idempotencyKey === "secondary-pending") {
                    pendingAttempts++;
                    if (pendingAttempts === 1) return reply(null, 400);
                    const target = cloud.nodes.find((node: any) => node.id === "fixture-pending-node");
                    pendingRun = { ...secondRun, id: "fixture-pending", production: { ...secondRun.production, targetNodeId: target.id } };
                    target.metadata.shortDrama.productionAgent.runId = pendingRun.id;
                    target.metadata.shortDrama.submission = "submitted"; target.metadata.status = "loading"; cloud.revision++;
                    return reply({ run: pendingRun });
                }
                if (run && submissionKey === input.idempotencyKey) return reply({ run });
                check(input.reasoningEffort === (theme === "dark" ? "high" : "low"), `${theme}: Agent receives captured reasoning effort`);
                if (run) throw new Error("Recovery attempted a different submission identity");
                submissionKey = input.idempotencyKey; creates++;
                check(input.permissionMode === "auto" && input.production?.targetNodeId && input.budget.maxGenerationTasks === 0, `${theme}: controlled production request`);
                check(!input.prompt.includes("第1集 林岚提着"), `${theme}: prompt references source instead of embedding prose`);
                const target = cloud.nodes.find((node: any) => node.id === input.production.targetNodeId);
                check(target.metadata.shortDrama.productionAgent.request?.idempotencyKey === input.idempotencyKey, `${theme}: recovery waits for slow submit-marker save`);
                target.metadata.shortDrama.productionAgent.runId = "fixture-agent";
                target.metadata.shortDrama.submission = "submitted";
                target.metadata.status = "loading";
                cloud = { ...cloud, revision: cloud.revision + 1 };
                run = { id: "fixture-agent", canvasId, status: "running", permissionMode: "auto", step: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), events: [], production: { targetNodeId: target.id, paused: false, waitingForBoundary: false, processedPages: 0, totalPages: 3, artifactCount: 0, validated: false } };
                return reply({ run });
            }
            if (path === "/api/agent/runs/fixture-secondary" && req.method() === "GET") return secondReadFails ? reply(null, 503) : reply({ run: secondRun });
            if (path === "/api/agent/runs/fixture-pending" && req.method() === "GET") return reply({ run: pendingRun });
            if (path === "/api/agent/runs/fixture-agent" && req.method() === "GET") {
                const before = Number(url.searchParams.get("beforeSeq"));
                const since = Number(url.searchParams.get("sinceSeq"));
                const limit = Number(url.searchParams.get("eventLimit")) || 40;
                return reply({ run: { ...run, events: (run.events || []).filter((event: any) => (!before || event.seq < before) && (!since || event.seq > since)).slice(-limit) } });
            }
            if (path === "/api/agent/runs/fixture-agent/production-control") { const { action, maxSteps } = req.postDataJSON(); check(maxSteps === undefined, `${theme}: task control does not add a call budget`); controls.push(action); run.production.paused = action === "pause"; if (action === "resume") { run.status = "running"; run.failureMessage = ""; } return reply({}); }
            if (path === "/api/agent/runs/fixture-agent/cancel") { controls.push("cancel"); run.status = "cancelled"; return reply({}); }
            return route.continue();
        });
        const wait = async (fn: () => boolean, label: string) => { for (let i = 0; i < 160 && !fn(); i++) await page.waitForTimeout(100); check(fn(), `${theme}: ${label}`); };
        try {
            await page.goto(`${origin}/canvas/${canvasId}`);
            const toggle = page.getByRole("button", { name: "短剧流程", exact: true }); await toggle.waitFor();
            if (await toggle.getAttribute("aria-pressed") === "true") await toggle.click();
            const bibleContainer = page.locator(`[data-node-id="${bibleFrame.id}"]`);
            await bibleContainer.getByText("8/8 项规范", { exact: true }).waitFor();
            for (const section of productionBibleSections) {
                const node = cloud.nodes.find((entry: any) => entry.parentId === bibleFrame.id && entry.metadata?.shortDrama?.bibleSection === section.key);
                check(Boolean(node), `${theme}: typed bible section ${section.key}`);
                await page.locator(`[data-node-id="${node.id}"]`).waitFor();
            }
            await page.screenshot({ path: join(output, `${theme}-eight-bible-sections.png`) });
            await bibleContainer.getByText("8/8 项规范", { exact: true }).click({ button: "right" });
            await page.getByRole("button", { name: "查看制作规范", exact: true }).click();
            const bibleReview = page.getByRole("region", { name: "统一制作规范", exact: true });
            await bibleReview.waitFor();
            for (const section of productionBibleSections) check(await bibleReview.getByRole("button", { name: `编辑${section.label}`, exact: true }).count() === 1, `${theme}: independently editable ${section.key}`);
            check(await bibleReview.getByRole("button", { name: /确认/ }).count() === 0, `${theme}: bible review has no approval gate`);
            await page.getByRole("button", { name: "关闭资产资料", exact: true }).click();
            if (await toggle.getAttribute("aria-pressed") === "false") await toggle.click();
            const guide = page.getByRole("region", { name: "短剧完整制作流程", exact: true });
            await guide.getByRole("combobox", { name: "短剧制作阶段" }).selectOption("assets");
            await guide.locator('[data-task-key="assets.bible"] button').click();
            const panel = page.locator(".canvas-workflow-generator");
            await panel.getByRole("combobox", { name: "推理强度", exact: true }).waitFor();
            check(await panel.getByRole("spinbutton", { name: /上限/ }).count() === 0, `${theme}: production form has no call or credit cap`);
            check(await panel.getByRole("combobox", { name: "推理强度", exact: true }).inputValue() === "medium", `${theme}: default reasoning effort is medium`);
            await panel.getByRole("combobox", { name: "推理强度", exact: true }).selectOption(theme === "dark" ? "high" : "low");
            await panel.getByRole("button", { name: "选择模型", exact: true }).click();
            const menu = page.locator(".canvas-model-picker-menu:visible");
            if (await menu.locator(".canvas-model-picker-brand").count()) await menu.locator(".canvas-model-picker-brand").first().click();
            await menu.locator(".canvas-model-picker-options button").first().click();
            check(await panel.getByRole("button", { name: "生成统一制作规范", exact: true }).isEnabled(), `${theme}: sorted JSON keeps bible generation enabled`);
            await page.getByRole("button", { name: "关闭生成设置", exact: true }).click();
            for (const step of ["assets.characters", "assets.environments", "assets.props", "assets.special"] as const) {
                if (await toggle.getAttribute("aria-pressed") === "false") await toggle.click();
                await guide.getByRole("combobox", { name: "短剧制作阶段" }).selectOption("assets");
                await guide.locator(`[data-task-key="${step}"] button`).click();
                check(await panel.getByRole("combobox", { name: "推理强度", exact: true }).inputValue() === (theme === "dark" ? "high" : "low"), `${theme}: ${step} remembers effort`);
                check(await panel.getByRole("button", { name: `生成${shortDramaStep(step)!.label}`, exact: true }).isEnabled(), `${theme}: sorted JSON keeps ${step} generation enabled`);
                await page.getByRole("button", { name: "关闭生成设置", exact: true }).click();
            }
            if (await toggle.getAttribute("aria-pressed") === "false") await toggle.click();
            await guide.getByRole("combobox", { name: "短剧制作阶段" }).selectOption("assets");
            await guide.locator('[data-task-key="assets.bible"] button').click();
            await page.screenshot({ path: join(output, `${theme}-generation.png`) });
            await panel.getByRole("button", { name: "生成统一制作规范", exact: true }).click();
            if (theme === "dark") {
                await panel.getByText("制作任务尚未保存，未向模型提交请求", { exact: true }).waitFor();
                await page.waitForTimeout(2800);
                check(creates === 0 && taskCreates === 0, "failed marker save never dispatches from recovery polling");
                failMarkerSave = false;
                await panel.getByRole("button", { name: "生成统一制作规范", exact: true }).click();
            }
            await wait(() => Boolean(run), "submits Agent from existing stage entry");
            check(generationConflict && cloud.nodes.find((node: any) => node.id === oldBible.id).position.x === concurrentX, `${theme}: generation survives a revision conflict and keeps concurrent geometry`);
            check(await page.getByRole("complementary", { name: "制作 Agent 任务" }).count() === 0, `${theme}: no independent scheduler on canvas`);
            const status = page.getByRole("region", { name: "制作任务执行记录", exact: true });
            await page.locator(`[data-node-id="${run.production.targetNodeId}"]`).getByRole("button", { name: "详情", exact: true }).click();
            await status.getByText("后台执行中", { exact: true }).waitFor();
            await status.getByRole("button", { name: "暂停任务", exact: true }).click();
            await status.getByText("已暂停", { exact: true }).waitFor();
            await status.getByRole("button", { name: "继续任务", exact: true }).click();
            await wait(() => controls.includes("resume"), "pause and resume same run");
            // Simulate backend writes while the page is closed, then reopen from server state.
            await page.goto("about:blank");
            const target = cloud.nodes.find((node: any) => node.id === run.production.targetNodeId);
            const asset = structuredClone(target); asset.id = "fixture-asset"; asset.title = "全局设定";
            asset.position = { x: target.position.x + 424, y: target.position.y };
            asset.metadata = { content: "正文事实：林岚返回照相馆。设计建议：相机材质待确认。", status: "success", shortDrama: { ...target.metadata.shortDrama, step: "assets.settings", assetKey: "settings", assetOutput: false, productionAgent: undefined } };
            cloud.nodes.push(asset); cloud.nodes.find((node: any) => node.id === target.parentId).metadata.shortDrama.sourceNodeIds.push(asset.id);
            cloud.revision++; run.production.processedPages = 3; run.production.artifactCount = 1; run.step = 4;
            // The second task cannot starve this task even when its GET fails.
            const second = structuredClone(target); second.id = "fixture-secondary-node"; second.title = "场景资产 · 提取记录";
            second.position = { x: target.position.x + 440, y: target.position.y + 320 };
            second.metadata.shortDrama.productionAgent.runId = "fixture-secondary";
            cloud.nodes.push(second);
            secondRun = { ...run, id: "fixture-secondary", step: 9, events: [{ seq: 1, eventId: "second-message", runId: "fixture-secondary", createdAt: new Date().toISOString(), type: "assistant_message", payload: { text: "仅属于场景任务的执行说明。" } }], production: { ...run.production, targetNodeId: second.id, processedPages: 2, artifactCount: 2 } };
            cloud.viewport = { x: 80 - target.position.x * 0.8, y: 200 - target.position.y * 0.8, k: 0.8 };
            const cdp = await context.newCDPSession(page); await cdp.send("Storage.clearDataForOrigin", { origin, storageTypes: "indexeddb" }); await cdp.detach();
            await page.goto(`${origin}/canvas/${canvasId}`);
            if (await toggle.getAttribute("aria-pressed") === "true") await toggle.click();
            await page.locator(`[data-node-id="${target.id}"]`).getByRole("button", { name: "详情", exact: true }).click();
            await status.getByText("已解析 3/3 页 · 已产出 1 项", { exact: true }).waitFor();
            check(creates === 1 && taskCreates === 0, `${theme}: reopening observes one Agent without plain task submission`);
            check(cloud.nodes.filter((node: any) => node.id === asset.id).length === 1 && asset.parentId === target.parentId, `${theme}: native text artifact remains in category container`);
            await page.screenshot({ path: join(output, `${theme}-progress.png`) });
            await page.setViewportSize({ width: 390, height: 600 }); await page.waitForTimeout(300);
            check(await page.locator(".canvas-node-inspector-scroll").evaluate((el: HTMLElement) => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && el.scrollWidth <= el.clientWidth + 1; }), `${theme}: task details scroll inside narrow viewport`);
            await page.screenshot({ path: join(output, `${theme}-narrow.png`) });
            await page.setViewportSize({ width: 1440, height: 945 });
            await page.locator(".canvas-node-info-modal .ant-modal-close").click();
            await page.locator(`[data-node-id="${second.id}"]`).getByRole("button", { name: "详情", exact: true }).click();
            await status.getByText(/状态核对失败/).waitFor();
            check(await status.getByText("场景资产 · 提取记录", { exact: true }).isVisible(), `${theme}: error belongs to second node`);
            secondReadFails = false;
            await status.getByText("已解析 2/3 页 · 已产出 2 项", { exact: true }).waitFor();
            await status.getByText("仅属于场景任务的执行说明。", { exact: true }).waitFor();
            check(await status.count() === 1 && await status.getByText("统一制作规范 · 提取记录", { exact: true }).count() === 0, `${theme}: switching nodes leaves one independently scoped task detail`);
            check(true, `${theme}: second task independently recovers while first keeps its progress`);
            await page.locator(".canvas-node-info-modal .ant-modal-close").click();
            await page.goto("about:blank");
            const pending = structuredClone(cloud.nodes.find((node: any) => node.id === second.id));
            pending.id = "fixture-pending-node";
            cloud.nodes.find((node: any) => node.id === second.id).position.y += 600;
            const pendingAgent = pending.metadata.shortDrama.productionAgent;
            delete pendingAgent.runId;
            pendingAgent.request = { ...pendingAgent.request, idempotencyKey: "secondary-pending", production: { targetNodeId: pending.id } };
            pending.metadata.shortDrama.submission = "submitting";
            pending.metadata.errorDetails = 'json: unknown field "reasoningEffort"'; cloud.nodes.push(pending); cloud.revision++;
            cloud.viewport = { x: 80 - target.position.x * 0.8, y: 200 - target.position.y * 0.8, k: 0.8 };
            const pendingCDP = await context.newCDPSession(page); await pendingCDP.send("Storage.clearDataForOrigin", { origin, storageTypes: "indexeddb" }); await pendingCDP.detach();
            await page.goto(`${origin}/canvas/${canvasId}`);
            if (await toggle.getAttribute("aria-pressed") === "true") await toggle.click();
            await page.locator(`[data-node-id="${pending.id}"]`).getByRole("button", { name: "详情", exact: true }).click();
            await status.getByText('json: unknown field "reasoningEffort"', { exact: true }).waitFor();
            check(pendingAttempts === 0, `${theme}: uncertain submission does not silently dispatch on reload`);
            await status.getByRole("button", { name: "继续提交", exact: true }).click();
            await status.getByRole("alert").filter({ hasText: "fixture failure" }).waitFor();
            await status.getByRole("button", { name: "继续提交", exact: true }).click();
            await status.getByText("已解析 2/3 页 · 已产出 2 项", { exact: true }).waitFor();
            check(pendingAttempts === 2, `${theme}: uncertain submission retries same identity and restores node-bound status`);
            await page.locator(".canvas-node-info-modal .ant-modal-close").click();
            run.status = "failed"; run.step = 120; run.production.maxSteps = 120; run.failureMessage = "本轮调用次数用完，已有进度保留";
            run.events = Array.from({ length: 220 }, (_, i) => {
                const group = Math.floor(i / 5);
                const taskId = `model-${group}`;
                const types = ["production_model_started", "production_model_completed", "assistant_message", "tool_completed", "production_progress"];
                const payloads = [
                    { taskId, step: group + 1 },
                    { taskId, status: "succeeded" },
                    { messageId: taskId, text: `已阅读第 ${group + 1} 页正文，正在核对人物称谓与首次出场信息。\n\n接下来会保存本页事实，并与已有角色条目进行归并。` },
                    { toolName: "production_facts", result: { pageId: `page-${group + 1}`, processedPages: group + 1, totalPages: 44 }, text: "本页事实已保存。" },
                    { text: `第 ${group + 1} 页处理进度已保存。` },
                ];
                return { seq: i + 1, eventId: `e-${i + 1}`, runId: run.id, createdAt: new Date(Date.UTC(2026, 9, 14, 0, 0, i)).toISOString(), type: types[i % 5], payload: payloads[i % 5] };
            });
            run.events.push({ seq: 221, eventId: "last-error", runId: run.id, createdAt: new Date().toISOString(), type: "run_failed", payload: { error: "历史任务触发旧调用上限。已保存的产物仍然保留。" } });
            // A node retry opens the same inspector and never submits before confirmation.
            const failedTarget = cloud.nodes.find((node: any) => node.id === target.id);
            failedTarget.metadata.prompt = "长提示词布局验证。".repeat(200);
            failedTarget.metadata.shortDrama.productionAgent.request.prompt = failedTarget.metadata.prompt;
            failedTarget.metadata.status = "error"; failedTarget.metadata.errorDetails = run.failureMessage; cloud.revision++;
            await page.reload();
            if (await toggle.getAttribute("aria-pressed") === "true") await toggle.click();
            await page.locator(`[data-node-id="${target.id}"]`).getByRole("button", { name: "查看详情并重试", exact: true }).click();
            await status.getByText("待恢复", { exact: true }).waitFor();
            check(controls.join(",") === "pause,resume", `${theme}: retry button opens details without dispatching`);
            await status.locator(".production-agent-commentary").first().waitFor();
            check(await status.count() === 1 && await status.getByText("仅属于场景任务的执行说明。", { exact: true }).count() === 0, `${theme}: reopening first task does not retain the other task journal`);
            const singleScroll = async (label: string) => {
                const result = await page.locator(".canvas-node-info-modal").evaluate((root: HTMLElement) => {
                    const all = [root, ...root.querySelectorAll<HTMLElement>("*")];
                    const scrolls = all.filter((el) => el.getClientRects().length > 0 && /auto|scroll/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1);
                    const scroll = root.querySelector<HTMLElement>(".canvas-node-inspector-scroll")!;
                    return scrolls.length === 1 && scrolls[0] === scroll && scroll.scrollWidth <= scroll.clientWidth + 1;
                });
                check(result, `${theme}: ${label}`);
            };
            await singleScroll("one vertical scrollbar for the whole execution history");
            await status.locator(".production-agent-parameters summary").click();
            check(await status.locator(".production-agent-parameters dd").count() === 3, `${theme}: only model effort and prompt remain in parameters`);
            check(await status.locator(".production-agent-prompt").textContent() === "提示词" + failedTarget.metadata.prompt, `${theme}: prompt moved inside run parameters`);
            await singleScroll("expanded long prompt shares the only scrollbar");
            await status.locator(".production-agent-parameters summary").click();
            await status.locator(".production-agent-event summary").first().click();
            check(await status.locator(".production-agent-event[open] .production-agent-event-detail").first().isVisible(), `${theme}: meaningful progress expands inline`);
            await singleScroll("expanded progress has no nested scrollbar");
            check(await page.locator(".canvas-node-inspector-metadata").count() === 0, `${theme}: unrelated node metadata removed from task detail`);
            await page.locator(".canvas-node-inspector-scroll").evaluate((el: HTMLElement) => { el.scrollTop = 0; });
            await page.screenshot({ path: join(output, `${theme}-execution-feed.png`) });
            await status.getByRole("button", { name: "加载更早记录" }).click();
            await page.waitForTimeout(250);
            await status.getByRole("button", { name: "加载更早记录" }).click();
            await page.waitForTimeout(250);
            check(await status.getByRole("button", { name: "加载更早记录" }).count() === 0, `${theme}: history reaches first dispatch`);
            check(await status.locator(".production-agent-commentary").count() === 44, `${theme}: commentary from every page retained once`);
            const ordered = await status.locator("[data-event-seq]").evaluateAll((items: HTMLElement[]) => items.map((el) => Number(el.dataset.eventSeq)));
            check(ordered.every((seq: number, i: number) => i === 0 || seq < ordered[i - 1]), `${theme}: newest records appear first by default`);
            check(await status.getByText(/调度模型|保存正文事实 · 完成/).count() === 0, `${theme}: routine model and tool receipts hidden`);
            await status.getByText("最早在前", { exact: true }).click();
            const ascending = await status.locator("[data-event-seq]").evaluateAll((items: HTMLElement[]) => items.map((el) => Number(el.dataset.eventSeq)));
            check(ascending.every((seq: number, i: number) => i === 0 || seq > ascending[i - 1]), `${theme}: sorting reverses the feed without jumping to the bottom`);
            await status.getByText("最新在前", { exact: true }).click();
            await page.locator(".canvas-node-inspector-scroll").evaluate((el: HTMLElement) => { el.scrollTop = 0; });
            await page.screenshot({ path: join(output, `${theme}-retry-history.png`) });
            await page.setViewportSize({ width: 390, height: 600 });
            check(await page.locator(".canvas-node-inspector-scroll").evaluate((el: HTMLElement) => el.scrollWidth <= el.clientWidth + 1), `${theme}: long journal stays inside narrow dialog`);
            await singleScroll("narrow dialog keeps one scrollbar");
            await status.locator(".production-agent-parameters summary").click();
            await singleScroll("narrow expanded parameters keep one scrollbar");
            await status.locator(".production-agent-parameters summary").click();
            check(await status.locator(".production-agent-actions").evaluate((el: HTMLElement) => [...el.children].every((child) => { const r = child.getBoundingClientRect(); return r.left >= el.getBoundingClientRect().left && r.right <= el.getBoundingClientRect().right + 1; })), `${theme}: narrow action controls fit their row`);
            await page.screenshot({ path: join(output, `${theme}-retry-history-narrow.png`) });
            await page.setViewportSize({ width: 1440, height: 945 });
            await status.getByRole("button", { name: "继续任务", exact: true }).click();
            await status.getByText("后台执行中", { exact: true }).waitFor();
            check(run.step === 120 && run.production.processedPages === 3, `${theme}: continuation retains cumulative calls and saved pages`);
            if (theme === "dark") {
                await status.getByRole("button", { name: "取消任务", exact: true }).click();
                await status.getByText("已停止", { exact: true }).waitFor();
                check(controls.join(",") === "pause,resume,resume,cancel", `${theme}: controls use original Agent identity`);
            }
            await page.setViewportSize({ width: 1440, height: 945 });
            if (await toggle.getAttribute("aria-pressed") === "true") await toggle.click();
            await page.locator(".canvas-node-info-modal .ant-modal-close").click();
            await page.locator(`[data-node-id="${target.id}"]`).click({ button: "right", position: { x: 80, y: 50 } });
            await page.getByRole("button", { name: "删除节点", exact: true }).click();
            await wait(() => !cloud.nodes.some((node: any) => node.id === target.id), "node deletion persists");
            check(deletionConflict, `${theme}: deletion reconciles a late background write without resurrecting its target`);
            await wait(() => run.removed && run.status === "cancelled", "task stops before removal");
            await page.waitForTimeout(2200);
            check(await status.count() === 0, `${theme}: removed node leaves no stale task panel`);
            await page.reload(); await toggle.waitFor(); await page.waitForTimeout(2200);
            check(await status.count() === 0 && creates === 1, `${theme}: reopening never resurrects deleted task`);
            if (await toggle.getAttribute("aria-pressed") === "false") await toggle.click();
            await guide.getByRole("combobox", { name: "短剧制作阶段" }).selectOption("assets");
            await guide.locator('[data-task-key="assets.bible"] button').click();
            check(await panel.getByRole("combobox", { name: "推理强度", exact: true }).inputValue() === (theme === "dark" ? "high" : "low"), `${theme}: preference survives reload`);
            await page.setViewportSize({ width: 390, height: 600 });
            await page.waitForTimeout(250);
            check(await panel.getByRole("combobox", { name: "推理强度", exact: true }).evaluate((el: HTMLElement) => { const r = el.getBoundingClientRect(); return r.width >= 50 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; }), `${theme}: reasoning selector fits narrow viewport`);
            await page.screenshot({ path: join(output, `${theme}-reasoning-narrow.png`) });
        } catch (error) { await page.screenshot({ path: join(output, `${theme}-failure.png`) }); throw error; }
        finally { await context.close(); }
    }
    check(report.errors.length === 0, "no page runtime errors");
    check(report.blocked.length === 0, "no external or paid requests");
} finally { await browser.close(); writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2)); }
console.log(JSON.stringify(report, null, 2));
