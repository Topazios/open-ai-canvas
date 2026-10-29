/** Exercise the real canvas route with isolated API fixtures, without model calls. */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import { createShortDramaPipeline } from "../src/lib/canvas/canvas-short-drama";
import { createWorkflowDocuments, nodeWorkflow } from "../src/lib/canvas/canvas-short-drama-workflow";
import { completeUnifiedWorkflowPlan } from "../test/fixtures/workflow-plan";
import { createCanvasPerformanceProject } from "../test/fixtures/canvas-performance-project";
import { defaultShortDramaSettings } from "../src/lib/short-drama-settings";
import { ProductionPlanSection } from "../src/lib/production-plan";
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const dist = resolve("dist"), out = resolve("../.local/canvas-benchmark/production-plan-assets");
mkdirSync(out, { recursive: true });
const report = { passed: [] as string[], errors: [] as string[], blocked: [] as string[] };
const check = (ok: unknown, label: string) => { if (!ok) throw new Error(label); report.passed.push(label); };
const features = { welcomeEnabled: false, shortDramaEnabled: true, taskCenterEnabled: true, creditsEnabled: false, customChannelsEnabled: false, frontendModelsEnabled: false, pluginCenterEnabled: false };
let project: any, run: any;
const controls: unknown[] = [];
const reply = (data: unknown) => Response.json({ code: 0, data, msg: "" });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/")) {
        const key = path.slice(4);
        if (key === "/auth/session") return reply({ user: { id: "canvas-benchmark", username: "fixture", role: "user", status: "active" }, features, runtimeLimits: { activeTaskLimit: 20, resourceUploadMB: 50, recycleBinRetentionDays: 30, concurrency: { image: 6, text: 4, agent: 4, video: 2, audio: 3, other: 2, channel: 12, customRelay: 12, imagePreparation: 4, resourceDownload: 4, upload: 4, mediaRecovery: 2, agentSessions: 4 } } });
        if (key === "/features") return reply({ features });
        if (key === "/model-catalog") return reply({ source: "system", channels: [] });
        if (key === `/canvas-projects/${project?.id}`) {
            if (request.method === "PUT") { const input = await request.json(); project = { ...input.project, revision: project.revision + 1 }; }
            return reply({ project });
        }
        if (key === `/agent/runs/${run?.id}`) return reply({ run });
        if (key === `/agent/runs/${run?.id}/production-control`) {
            const input = await request.json(); controls.push(input);
            const selected = ["running", "queued"].includes(run.status) && run.production.assetsStarted && !run.production.paused
                ? [...new Set([...run.production.selectedAssetKeys, ...input.assetKeys])] : input.assetKeys;
            run = { ...run, status: "running", updatedAt: new Date().toISOString(), production: { ...run.production, assetsStarted: true, validated: false, selectedAssetKeys: selected,
                assets: run.production.assets.map((item: any) => input.assetKeys.includes(item.key) && item.status !== "complete" ? { ...item, status: item.missingDependencies.length ? "blocked" : "queued", error: undefined } : item) } };
            return reply({ accepted: true });
        }
        if (key.endsWith("/history")) return reply({ snapshots: [], currentRevision: project.revision });
        if (key === "/user-data/snapshot") return reply({ projects: [project], assets: [] });
        if (key.endsWith("/tasks/reconcile")) return reply({ accepted: true });
        const fixtures: Record<string, unknown> = { "/tasks": [], "/assets": { assets: [], total: 0, hasMore: false, kindCounts: {}, categoryCounts: {}, folderCounts: {} }, "/assets/batch": { assets: [] }, "/projects": { projects: [], total: 0 }, "/channels/system": { channels: [] }, "/plugins": { plugins: [], states: {} }, "/plugins/status": { statuses: {}, states: {} }, "/skills/added": { skills: [] }, "/skills/presets": { presets: [] }, "/skills": { skills: [], total: 0 }, "/public/appearance": { appearance: {} }, "/announcements": { announcements: [], unreadCount: 0 }, "/banner-announcements": { banners: [] }, "/settings/prompt-templates": { preferences: [] }, "/agent/profile": { revision: "1", hash: "fixture", layers: [] } };
        if (key in fixtures) return reply(fixtures[key]);
        report.blocked.push(`${request.method} ${key}`);
        return Response.json({ code: 501, msg: "fixture blocked" }, { status: 501 });
    }
    const filePath = resolve(dist, `.${decodeURIComponent(path)}`);
    if (filePath !== dist && !filePath.startsWith(dist + sep)) return new Response(null, { status: 403 });
    const file = Bun.file(filePath);
    return new Response(filePath !== dist && await file.exists() ? file : Bun.file(join(dist, "index.html")));
} });
const origin = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
try {
    for (const theme of ["dark", "light"]) {
        const controlsBefore = controls.length;
        const pipeline = createShortDramaPipeline({ x: 0, y: 0 }, true);
        pipeline.nodes[0].metadata!.content = "已采用的故事与冲突";
        const generated = createWorkflowDocuments({ step: "story.plan", pipelineId: nodeWorkflow(pipeline.nodes[0])!.pipelineId, sourceNodeIds: [pipeline.nodes[0].id], model: "fixture::text", instruction: "", episodeCount: 2, minutesPerEpisode: "1-2", start: 1, count: 1 }, pipeline.nodes, [], { x: 0, y: 0 });
        const plan = completeUnifiedWorkflowPlan(generated);
        const inventory = { ...plan.docs[0], id: `${plan.manifest.id}:inventory`, title: "资产总表与编码", metadata: { ...plan.docs[0].metadata, content: "CHR-0001 主角；SCN-0001 照相馆。", shortDrama: { ...nodeWorkflow(plan.docs[0])!, assetKey: "inventory", planSection: ProductionPlanSection.Inventory, bibleSection: undefined } } };
        plan.docs.splice(1, 0, inventory); generated.nodes.push(inventory);
        const assetIds = new Set(plan.docs.filter(node => nodeWorkflow(node)?.planAsset).map(node => node.id));
        const nodes = generated.nodes.filter(node => !assetIds.has(node.id));
        nodeWorkflow(plan.frame)!.sourceNodeIds = [plan.manifest.id, ...plan.docs.filter(node => !assetIds.has(node.id)).map(node => node.id)];
        nodeWorkflow(plan.manifest)!.productionAgent = { runId: "fixture-plan-run" };
        nodeWorkflow(plan.frame)!.planReady = false;
        plan.frame.width = 1296; plan.frame.height = 796;
        plan.frame.metadata!.frame = { collapsed: false, expandedWidth: 1296, expandedHeight: 796 };
        const publicDocs = plan.docs.filter(node => !assetIds.has(node.id));
        publicDocs.forEach((node, index) => { node.position = { x: plan.frame.position.x + 24 + index % 3 * 424, y: plan.frame.position.y + 100 + Math.floor(index / 3) * 336 }; });
        project = { ...createCanvasPerformanceProject(100), nodes, connections: [], projectId: "", globalSettings: defaultShortDramaSettings(), appearance: { mode: theme }, viewport: { x: 120 - plan.frame.position.x * 0.8, y: 120 - plan.frame.position.y * 0.8, k: 0.8 } };
        run = { id: "fixture-plan-run", canvasId: project.id, status: "running", permissionMode: "auto", createdAt: "2026-10-24T00:00:00Z", updatedAt: "2026-10-24T00:00:00Z", events: [], production: { targetNodeId: plan.manifest.id, workKind: "plan", paused: false, waitingForBoundary: false, processedPages: 4, totalPages: 5, artifactCount: 4, documentCount: 4, documentTotal: 5, assetCount: 0, assetTotal: 2, validated: false, planReady: false, assetsStarted: false,
            concurrentItems: ["视觉与美术规范", "导演与视听规范"], parallelItems: [{ key: "visual", name: "视觉与美术规范", status: "running" }, { key: "direction", name: "导演与视听规范", status: "retrying" }],
            assets: [
                { key: "hero", code: "CHR-0001", name: "主角", kind: "character", status: "pending", missingDependencies: [] },
                { key: "friend", code: "CHR-0002", name: "朋友", kind: "character", status: "pending", missingDependencies: [] },
                { key: "saved", code: "CHR-0003", name: "已完成角色", kind: "character", status: "complete", missingDependencies: [] },
                { key: "scene", code: "SCN-0001", name: "照相馆", kind: "environment", status: "pending", missingDependencies: [] },
                { key: "camera", code: "PRP-0001", name: "相机", kind: "prop", status: "pending", missingDependencies: [] },
                { key: "sound", code: "AUD-0001", name: "场景环境声", kind: "sound", status: "blocked", missingDependencies: ["scene"] },
            ],
        } };
        const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, serviceWorkers: "block" });
        await context.addInitScript((theme: string) => { if (location.protocol === "http:") localStorage.setItem("infinite-canvas:canvas-theme", JSON.stringify({ state: { theme }, version: 0 })); }, theme);
        await context.route("**/*", (route: any) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        const page = await context.newPage(); page.setDefaultTimeout(12000);
        page.on("pageerror", (error: Error) => report.errors.push(error.message));
        await page.goto(`${origin}/canvas/${project.id}`);
        const guide = page.getByRole("button", { name: "短剧流程", exact: true }); await guide.waitFor();
        if (await guide.getAttribute("aria-pressed") === "true") await guide.click();
        const setupGuide = page.getByRole("button", { name: "关闭模型配置引导", exact: true });
        if (await setupGuide.isVisible()) await setupGuide.click();
        const frame = page.locator(`[data-node-id="${plan.frame.id}"]`).first();
        const button = frame.getByRole("button", { name: "生成资产", exact: true });
        await button.waitFor(); await page.mouse.move(1400, 900);
        check(await button.isVisible() && await button.isDisabled(), `${theme}: unfinished plan has a visible disabled footer action`);
        const bounds = await frame.boundingBox(), actionBounds = await button.boundingBox();
        check(bounds && actionBounds && Math.abs(bounds.y + bounds.height - actionBounds.y - actionBounds.height) < 20, `${theme}: action is fixed to the frame bottom`);
        const lastDoc = await page.locator(`[data-node-id="${publicDocs.at(-1)!.id}"]`).first().boundingBox();
        check(lastDoc && actionBounds && lastDoc.y + lastDoc.height + 8 < actionBounds.y, `${theme}: final document cannot cover the footer`);
        check(controls.length === controlsBefore, `${theme}: loading and polling never start assets`);
        const taskPanel = page.locator('section[aria-label="当前画布生成任务"]');
        await taskPanel.waitFor(); await taskPanel.getByRole("button").first().click();
        await taskPanel.getByRole("button", { name: "查看执行详情" }).waitFor();
        const taskPanelText = await taskPanel.textContent();
        check(taskPanelText?.includes("文稿 4/5") && taskPanelText.includes("生成中") && !taskPanelText.includes("纠正"), `${theme}: Agent-only work shows phase, saved documents and individual parallel states without exposing internal validation retries`);
        await page.waitForFunction(() => {
            const panel = document.querySelector('section[aria-label="当前画布生成任务"]');
            const list = panel?.querySelector<HTMLElement>("#canvas-active-task-list");
            const action = [...(panel?.querySelectorAll("button") || [])].find(button => button.textContent?.includes("查看执行详情"));
            return list?.style.height === "auto" && action && panel && action.getBoundingClientRect().bottom <= panel.getBoundingClientRect().bottom;
        });
        await page.screenshot({ path: join(out, `${theme}-active-tasks.png`) });
        run = { ...run, status: "failed", failureMessage: "公共规范只提交 document", updatedAt: "2026-10-24T00:00:30Z" };
        await taskPanel.waitFor({ state: "detached" });
        await frame.getByText(/制作未完成/).waitFor();
        check(await button.isDisabled(), `${theme}: failed receipt stops the stale canvas spinner and preserves the manual asset gate`);
        run = { ...run, status: "completed", updatedAt: "2026-10-24T00:01:00Z", production: { ...run.production, processedPages: 5, artifactCount: 5, documentCount: 5, validated: true, planReady: true } };
        await button.waitFor(); await page.waitForFunction(() => [...document.querySelectorAll('button[aria-label="生成资产"]')].some(button => !(button as HTMLButtonElement).disabled));
        check(await button.isEnabled(), `${theme}: all documents and successful completion enable the action`);
        await page.screenshot({ path: join(out, `${theme}-ready.png`) });
        const frameBounds = await frame.boundingBox();
        await frame.click({ button: "right", position: { x: frameBounds!.width - 28, y: frameBounds!.height - 65 } });
        const contextMenu = page.locator("[data-canvas-context-menu]");
        await contextMenu.getByRole("button", { name: /^生成人物/ }).waitFor();
        check(await contextMenu.locator('section[aria-label="选择资产生成"]').count() === 0 && await page.locator(".canvas-node-info-modal").count() === 0, `${theme}: right-click offers direct commands without a picker or details`);
        for (const label of ["生成人物", "生成场景", "生成道具", "生成声音", "生成特殊资产"]) {
            check(await contextMenu.getByRole("button", { name: new RegExp(`^${label}`) }).isVisible(), `${theme}: ${label} is directly visible`);
        }
        check(await contextMenu.getByRole("button", { name: /^生成声音/ }).isDisabled(), `${theme}: missing scene dependency disables sound generation`);
        check(await contextMenu.getByRole("button", { name: /^生成特殊资产/ }).isDisabled(), `${theme}: absent special inventory cannot create invented assets`);
        check(controls.length === controlsBefore, `${theme}: opening the menu does not start generation`);
        await page.screenshot({ path: join(out, `${theme}-right-click-assets.png`), animations: "disabled" });
        const generationResponse = page.waitForResponse((response: any) => response.url().endsWith("/production-control"));
        await contextMenu.getByRole("button", { name: /^生成人物/ }).click();
        await generationResponse;
        check(controls.length === controlsBefore + 1 && JSON.stringify((controls.at(-1) as any).assetKeys) === '["hero","friend"]', `${theme}: one click submits every unfinished character and no other assets`);
        await contextMenu.waitFor({ state: "detached" });
        await frame.click({ button: "right", position: { x: frameBounds!.width - 28, y: frameBounds!.height - 65 } });
        await page.waitForFunction(() => document.querySelector("[data-canvas-context-menu]")?.textContent?.includes("此类资产已提交"));
        check(await contextMenu.getByRole("button", { name: /^生成人物/ }).isDisabled(), `${theme}: submitted characters cannot be submitted twice`);
        check(await contextMenu.getByRole("button", { name: /^生成场景/ }).isEnabled() && await contextMenu.getByRole("button", { name: /^生成道具/ }).isEnabled(), `${theme}: other categories remain available during character generation`);
        const appendResponse = page.waitForResponse((response: any) => response.url().endsWith("/production-control"));
        await contextMenu.getByRole("button", { name: /^生成场景/ }).click(); await appendResponse;
        check(JSON.stringify((controls.at(-1) as any).assetKeys) === '["scene"]' && JSON.stringify(run.production.selectedAssetKeys) === '["hero","friend","scene"]', `${theme}: scene appends to the active scope and preserves character work`);
        await contextMenu.waitFor({ state: "detached" });
        await frame.click({ button: "right", position: { x: frameBounds!.width - 28, y: frameBounds!.height - 65 } });
        await page.waitForFunction(() => [...(document.querySelector("[data-canvas-context-menu]")?.querySelectorAll("button") || [])].some(button => button.textContent?.startsWith("生成声音") && !button.disabled));
        check(await contextMenu.getByRole("button", { name: /^生成声音/ }).isEnabled(), `${theme}: sound can be queued behind an authorized scene dependency`);
        await page.keyboard.press("Escape");
        run = { ...run, status: "failed", failureMessage: "模型服务暂时不可用，已有资产保留", production: { ...run.production, assetCount: 1, assetTotal: 4, concurrentItems: ["待重试场景"], parallelItems: [{ key: "scene", name: "待重试场景", status: "retrying" }], assets: run.production.assets.map((item: any) => item.key === "hero" ? { ...item, status: "complete" } : item.key === "scene" ? { ...item, status: "failed", error: "服务暂时不可用" } : item) } };
        await frame.getByText(/制作未完成/).waitFor();
        await taskPanel.waitFor({ state: "detached" });
        await frame.getByRole("button", { name: "详情", exact: true }).click();
        const details = page.locator(".canvas-node-info-modal");
        await details.getByText(/已完成 2\/6/).waitFor();
        const list = details.locator('section[aria-label="选择资产生成"]');
        const scene = list.locator("li").filter({ has: page.getByText("照相馆", { exact: true }) });
        check(await scene.getByRole("button", { name: "重试", exact: true }).isEnabled(), `${theme}: failed asset exposes a per-item retry`);
        check(await list.getByRole("checkbox", { name: "选择 主角", exact: true }).isDisabled(), `${theme}: completed assets are preserved`);
        await list.getByRole("checkbox", { name: "选择 场景环境声", exact: true }).check();
        check(await list.getByRole("button", { name: "生成所选（1）" }).isDisabled(), `${theme}: missing dependency prevents invalid generation`);
        await list.getByRole("button", { name: "勾选缺少的前置项", exact: true }).click();
        check(await list.getByRole("checkbox", { name: "选择 照相馆", exact: true }).isChecked() && await list.getByRole("button", { name: "生成所选（2）" }).isEnabled(), `${theme}: dependencies are explicitly selected before submission`);
        check(!(await details.textContent())?.includes("全局 Agent 并发上限"), `${theme}: stopped retry checkpoints are not shown as active work`);
        await page.screenshot({ path: join(out, `${theme}-assets-stopped.png`), animations: "disabled" });
        await scene.getByRole("button", { name: "重试", exact: true }).click();
        await page.waitForFunction(() => [...document.querySelectorAll('section[aria-label="选择资产生成"] li')].some(item => item.textContent?.includes("照相馆") && item.textContent?.includes("已提交")));
        check(JSON.stringify((controls.at(-1) as any).assetKeys) === '["scene"]', `${theme}: per-item retry does not submit checked siblings`);
        await page.close();
        const emptyGroup = { ...plan.frame, id: `${plan.frame.id}-empty-assets`, title: "道具资产", width: 800, height: 400, position: { x: plan.frame.position.x + 2000, y: plan.frame.position.y }, metadata: { frame: { collapsed: false }, shortDrama: { ...nodeWorkflow(plan.frame), sourceNodeIds: [], planGroup: { rootFrameId: plan.frame.id, kind: "prop" }, assetGroup: { kind: "prop", manifestId: plan.manifest.id } } } };
        project = { ...project, id: `${project.id}-empty-assets`, nodes: [...project.nodes, emptyGroup], viewport: { x: 120 - emptyGroup.position.x * 0.8, y: 120 - emptyGroup.position.y * 0.8, k: 0.8 } };
        run = { ...run, status: "failed", canvasId: project.id, production: { ...run.production, assets: run.production.assets.map((item: any) => item.key === "camera" ? { ...item, status: "failed", error: "测试失败，可重试" } : item), assetGroups: [{ kind: "prop", total: 1, completed: 0, status: "waiting" }] } };
        const assetPage = await context.newPage(); assetPage.setDefaultTimeout(12000);
        assetPage.on("pageerror", (error: Error) => report.errors.push(error.message));
        await assetPage.goto(`${origin}/canvas/${project.id}`);
        const assetGuide = assetPage.getByRole("button", { name: "短剧流程", exact: true }); await assetGuide.waitFor();
        if (await assetGuide.getAttribute("aria-pressed") === "true") await assetGuide.click();
        const assetSetupGuide = assetPage.getByRole("button", { name: "关闭模型配置引导", exact: true });
        if (await assetSetupGuide.isVisible()) await assetSetupGuide.click();
        const assetFrame = assetPage.locator(`[data-node-id="${emptyGroup.id}"]`).first();
        await assetFrame.getByText(/已停止，可在详情继续/).waitFor();
        const assetBounds = await assetFrame.boundingBox();
        await assetFrame.click({ button: "right", position: { x: assetBounds!.width - 25, y: assetBounds!.height - 60 } });
        const assetMenu = assetPage.locator("[data-canvas-context-menu]");
        check(await assetMenu.getByRole("button", { name: /^生成道具/ }).isEnabled(), `${theme}: empty derived group resolves the original plan and its category command`);
        await assetPage.keyboard.press("Escape");
        await assetFrame.getByRole("button", { name: "查看制作任务详情", exact: true }).click();
        const assetSelector = assetPage.locator('.canvas-node-info-modal section[aria-label="选择资产生成"]');
        await assetSelector.waitFor();
        check(await assetPage.getByRole("button", { name: /上次范围/ }).count() === 0, `${theme}: derived container cannot accidentally retry another category's previous batch`);
        check(await assetSelector.locator("li").count() === 1 && await assetSelector.getByRole("button", { name: "重试", exact: true }).isEnabled(), `${theme}: corresponding container details show only its category and a failed-item retry`);
        await assetPage.setViewportSize({ width: 420, height: 860 });
        check(await assetSelector.evaluate((element: HTMLElement) => element.scrollWidth <= element.clientWidth + 1), `${theme}: narrow selector has no horizontal overflow`);
        await assetPage.screenshot({ path: join(out, `${theme}-empty-assets-stopped.png`), animations: "disabled" });
        const retryResponse = assetPage.waitForResponse((response: any) => response.url().endsWith("/production-control"));
        await assetSelector.getByRole("button", { name: "重试", exact: true }).click();
        await retryResponse;
        check(JSON.stringify((controls.at(-1) as any).assetKeys) === '["camera"]', `${theme}: container retry submits only the failed prop`);
        await context.close();
    }
    check(report.errors.length === 0 && report.blocked.length === 0, "no browser errors or unexpected API requests");
} finally {
    writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    await browser.close(); server.stop(true);
}
