/** Actual production route with isolated API fixtures; no paid model calls. */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import { createShortDramaPipeline } from "../src/lib/canvas/canvas-short-drama";
import { createWorkflowDocuments, nodeWorkflow } from "../src/lib/canvas/canvas-short-drama-workflow";
import { completeUnifiedWorkflowPlan } from "../test/fixtures/workflow-plan";
import { createCanvasPerformanceProject } from "../test/fixtures/canvas-performance-project";
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const partial = process.env.WORKFLOW_PARTIAL_ASSETS === "1";
const planMenus = process.env.WORKFLOW_PLAN_MENUS === "1";
const dist = resolve("dist"), output = resolve(`../.local/canvas-benchmark/${partial ? "partial-assets" : planMenus ? "plan-asset-menu" : "asset-menu"}`);
mkdirSync(output, { recursive: true });
const p = createShortDramaPipeline({ x: 0, y: 0 }, true); p.nodes[0].metadata!.content = "选定故事";
const result = createWorkflowDocuments({ step: "story.plan", pipelineId: nodeWorkflow(p.nodes[0])!.pipelineId, sourceNodeIds: [p.storyNodeId], model: "fixture::text", instruction: "", episodeCount: 3, minutesPerEpisode: "2", start: 1, count: 1 }, p.nodes, p.connections, { x: 0, y: 0 });
const plan = completeUnifiedWorkflowPlan(result), hero = plan.docs[1];
const group = structuredClone(plan.frame); group.id = "character-group"; group.title = "人物资产"; group.position = { x: 2000, y: 0 }; group.width = 872; group.height = 404;
group.metadata!.frame = { collapsed: false, expandedWidth: group.width, expandedHeight: group.height };
Object.assign(nodeWorkflow(group)!, { sourceNodeIds: [hero.id], planGroups: undefined, planGroup: { rootFrameId: plan.frame.id, kind: "character" } });
nodeWorkflow(plan.frame)!.planGroups = { character: group.id };
nodeWorkflow(plan.frame)!.sourceNodeIds = nodeWorkflow(plan.frame)!.sourceNodeIds.filter((id) => id !== hero.id);
hero.parentId = group.id; hero.position = { x: 2024, y: 100 };
Object.assign(nodeWorkflow(hero)!, { sourceNodeIds: [plan.frame.id], sourceSteps: ["story.plan"], sourceSignatures: {} });
const other = structuredClone(hero); other.id = "other-character"; other.title = "第二个人物"; other.position.x += 424;
Object.assign(nodeWorkflow(other)!, { assetKey: "C002", assetIdentity: { id: "asset-second", kind: "character", code: "CHR-0002" }, planAsset: { ...nodeWorkflow(other)!.planAsset, key: "C002", name: "第二个人物" } });
nodeWorkflow(group)!.sourceNodeIds.push(other.id);
result.nodes.push(group, other); result.connections.push({ id: "plan-to-characters", fromNodeId: plan.frame.id, toNodeId: group.id });
for (const node of result.nodes) if (nodeWorkflow(node)) { nodeWorkflow(node)!.productionAgent = undefined; nodeWorkflow(node)!.submission = "submitted"; }
const base = { ...createCanvasPerformanceProject(100), nodes: result.nodes, connections: result.connections, projectId: "", revision: 1 };
let project: any, requests: any[] = [];
const tasks: any[] = [];
const features = { welcomeEnabled: false, shortDramaEnabled: true, taskCenterEnabled: true, creditsEnabled: false, customChannelsEnabled: false, frontendModelsEnabled: false, pluginCenterEnabled: false };
const fixtures: Record<string, unknown> = {
    "/auth/session": { user: { id: "asset-menu-fixture", username: "fixture", role: "user", status: "active" }, features },
    "/features": { features }, "/channels/system": { channels: [] }, "/plugins": { plugins: [], states: {} }, "/plugins/status": { statuses: {}, states: {} },
    "/skills/added": { skills: [] }, "/skills/presets": { presets: [] }, "/public/appearance": { appearance: {} }, "/agent/profile": { revision: "1", hash: "fixture", layers: [] },
    "/skills": { skills: [], total: 0 }, "/announcements": { announcements: [], unreadCount: 0 }, "/banner-announcements": { banners: [] },
    "/assets": { assets: [], total: 0, hasMore: false, kindCounts: {}, categoryCounts: {}, folderCounts: {}, page: 1, pageSize: 50 }, "/projects": { projects: [], total: 0 }, "/settings/prompt-templates": { preferences: [] },
    "/agent/runs": { runs: [] },
    "/model-catalog": { source: "system", channels: [{ id: "fixture", displayName: "Fixture", models: [
        { id: "text", modelKey: "text", displayName: "Fixture text", capability: "text", protocol: "chat-completion", available: true, priceTiers: [] },
        { id: "image", modelKey: "image", displayName: "Fixture image", capability: "image", protocol: "openai-images", available: true, priceTiers: [] },
    ] }] },
};
const report = { passed: [] as string[], errors: [] as string[], blocked: [] as string[] };
const check = (condition: unknown, label: string) => { if (!condition) throw new Error(label); report.passed.push(label); };
const reply = (data: unknown, status = 200) => Response.json({ code: status === 200 ? 0 : status, data, msg: status === 200 ? "" : "isolated fixture" }, { status });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/")) {
        const api = path.slice(4);
        if (api === `/canvas-projects/${project?.id}`) {
            if (request.method === "PUT") { project = { ...(await request.json()).project, revision: project.revision + 1 }; }
            return reply({ project });
        }
        if (request.method === "GET" && api in fixtures) return reply(fixtures[api]);
        if (api.endsWith("/history")) return reply({ snapshots: [], currentRevision: project.revision });
        if (api.endsWith("/tasks/reconcile")) return reply({ accepted: true });
        if (api === "/user-data/snapshot") return reply({ projects: [project], assets: [] });
        if (api === "/assets/batch") return reply({ assets: [] });
        if (api === "/tasks" && request.method === "POST") {
            const input = await request.json(); requests.push(input);
            const task = { id: `fixture-task-${requests.length}`, projectId: project.id, type: input.type, operation: input.operation, status: "running", prompt: input.prompt, model: input.model, attempts: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), clientOperationId: input.clientOperationId, clientContext: { nodeId: input.input.metadata.nodeId } };
            tasks.push(task); return reply(task);
        }
        if (api === "/tasks") return reply(tasks);
        if (api.startsWith("/tasks/fixture-task-") && api.endsWith("/text-events")) return new Response("", { headers: { "Content-Type": "text/event-stream" } });
        if (api.startsWith("/tasks/fixture-task-")) return reply(tasks.find((task) => task.id === api.split("/")[2]));
        report.blocked.push(`${request.method} ${api}`); return reply(null, 501);
    }
    const file = resolve(dist, `.${decodeURIComponent(path)}`);
    if (file !== dist && !file.startsWith(dist + sep)) return new Response(null, { status: 403 });
    return new Response(file !== dist && await Bun.file(file).exists() ? Bun.file(file) : Bun.file(join(dist, "index.html")), { headers: { "Cache-Control": "no-store", "Content-Security-Policy": "connect-src 'self' blob:; img-src 'self' data: blob:; media-src 'self' data: blob:" } });
} });
const origin = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
try {
    if (planMenus) {
        for (const theme of ["dark", "light"]) {
            const sections = plan.docs.filter((node) => nodeWorkflow(node)?.planSection);
            const cases = [
                { name: "plan-root", source: plan.frame, variant: "root", expected: ["生成另一版项目制作方案", "下一步：分集集纲"] },
                ...sections.map((source) => ({ name: `plan-${nodeWorkflow(source)!.planSection}`, source, variant: "section", expected: [] as string[] })),
                { name: "plan-section-only", source: sections[0], variant: "plan-only", expected: [] },
                { name: "bible-section-only", source: sections[0], variant: "bible-only", expected: [] },
                { name: "legacy-plan-document", source: sections[0], variant: "legacy", expected: [] },
                { name: "body", source: sections[0], variant: "body", expected: ["生成另一版分集正文", "下一步：正文资产校核与补充", "下一步：场次与镜头拆解"] },
                { name: "free-text", source: sections[0], variant: "free", expected: [] },
            ];
            for (const entry of cases) {
                project = structuredClone(base); project.appearance = { mode: theme };
                const target = project.nodes.find((node: any) => node.id === entry.source.id);
                const data = nodeWorkflow(target)!;
                if (entry.variant === "plan-only" || entry.variant === "legacy") delete data.bibleSection;
                if (entry.variant === "bible-only" || entry.variant === "legacy") delete data.planSection;
                if (entry.variant === "body") {
                    target.metadata.shortDrama = { stage: "story", step: "story.body", pipelineId: data.pipelineId, role: "document", sourceNodeIds: [plan.frame.id], sourceSteps: ["story.plan"], sourceSignatures: {}, submission: "submitted", episodeNumber: 1 };
                    target.title = "第1集正文";
                }
                if (entry.variant === "free") { delete target.metadata.shortDrama; delete target.parentId; target.title = "普通自由文本"; }
                // The section fixture shares positions; move only the clicked document to an empty area.
                if (entry.variant !== "root") target.position = { x: 6000, y: 2000 };
                project.viewport = { x: 400 - target.position.x * 0.8, y: 240 - target.position.y * 0.8, k: 0.8 };
                const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
                await context.route("**/*", (route: any) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
                const page = await context.newPage(); page.setDefaultTimeout(12000);
                page.on("pageerror", (error: Error) => report.errors.push(`${theme}/${entry.name}: ${error.message}`));
                try {
                    await page.goto(`${origin}/canvas/${project.id}`);
                    const node = page.locator(`[data-node-id="${target.id}"]`); await node.waitFor({ state: "visible" });
                    const toggle = page.getByRole("button", { name: "隐藏短剧导引", exact: true }); if (await toggle.isVisible()) await toggle.click();
                    await node.click({ button: "right", position: { x: 40, y: 20 } });
                    const menu = page.locator("[data-canvas-context-menu]"); await menu.waitFor();
                    const workflow = await menu.evaluate((element: HTMLElement) => {
                        const heading = [...element.querySelectorAll("div")].find((item) => item.textContent === "短剧流程");
                        const labels: string[] = [];
                        for (let sibling = heading?.nextElementSibling; sibling && sibling.textContent !== "节点操作"; sibling = sibling.nextElementSibling) {
                            if (sibling.tagName === "BUTTON") labels.push(sibling.textContent!.trim());
                        }
                        return labels;
                    });
                    const label = `${theme}/${entry.name}`;
                    writeFileSync(join(output, `${label.replace("/", "-")}-menu.json`), JSON.stringify({ expected: entry.expected, workflow, text: await menu.innerText() }, null, 2));
                    await page.screenshot({ path: join(output, `${label.replace("/", "-")}-menu.png`), animations: "disabled" });
                    check(JSON.stringify(workflow) === JSON.stringify(entry.expected), `${label}: exact workflow actions (${workflow.join(", ") || "none"})`);
                    for (const name of ["用文本生图", "拆分角色/场景并批量生图"]) {
                        check(await menu.getByRole("button", { name, exact: true }).count() === (entry.variant === "free" ? 1 : 0), `${label}: ${name} ${entry.variant === "free" ? "retained" : "hidden"}`);
                    }
                    check(await menu.getByRole("button", { name: entry.variant === "root" ? /^复制背板及内容/ : /^复制节点/ }).count() === 1, `${label}: generic copy retained`);
                    check(await menu.getByRole("button", { name: entry.variant === "root" ? "删除背板" : "删除节点", exact: true }).count() === 1, `${label}: generic delete retained`);
                    if (entry.variant !== "root") check(await menu.getByRole("button", { name: "复制文本", exact: true }).count() === 1, `${label}: text copy retained`);
                } catch (error) {
                    report.errors.push(`${theme}/${entry.name}: ${String(error)}`);
                    await page.screenshot({ path: join(output, `${theme}-${entry.name}-failure.png`), animations: "disabled" }).catch(() => {});
                } finally { await context.close(); }
            }
        }
        check(requests.length === 0, "menu inspection creates no generation tasks");
    }
    for (const theme of ["dark", "light"]) {
        for (const scope of ["group", "single"]) {
            project = structuredClone(base); project.appearance = { mode: theme }; project.viewport = { x: 350 - group.position.x * 0.8, y: 300, k: 0.8 };
            if (partial) {
                const manifest = project.nodes.find((node: any) => node.id === plan.manifest.id);
                manifest.metadata.status = "loading"; manifest.metadata.shortDrama.assetOutput = true; delete manifest.metadata.shortDrama.materializedTaskId;
                const generation = project.nodes.find((node: any) => node.metadata?.shortDrama?.planSection === "generation");
                generation.metadata.status = "loading"; generation.metadata.content = "";
                const pending = structuredClone(other); pending.id = "unfinished-character"; pending.metadata!.status = "loading"; pending.metadata!.content = "未完成片段";
                nodeWorkflow(pending)!.assetIdentity = { id: "pending", code: "CHR-0003", kind: "character" }; nodeWorkflow(pending)!.assetKey = "C003";
                pending.position = { x: group.position.x + 24, y: group.position.y + 450 };
                project.nodes.push(pending); project.nodes.find((node: any) => node.id === group.id).metadata.shortDrama.sourceNodeIds.push(pending.id);
            }
            requests = []; tasks.length = 0;
            const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
            await context.route("**/*", (route: any) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
            const page = await context.newPage(); page.setDefaultTimeout(12000); page.on("pageerror", (error: Error) => report.errors.push(error.message));
            await page.goto(`${origin}/canvas/${project.id}`);
            const node = page.locator(`[data-node-id="${scope === "group" ? group.id : other.id}"]`); await node.waitFor({ state: "visible" });
            const toggle = page.getByRole("button", { name: "隐藏短剧导引", exact: true }); if (await toggle.isVisible()) await toggle.click();
            await node.click({ button: "right", position: { x: 40, y: 20 } });
            const menu = page.locator("[data-canvas-context-menu]"); await menu.waitFor();
            const text = await menu.innerText();
            check(text.includes("重做另一版") && text.includes("生图") && !/下一步|项目制作方案|用文本生图|拆分角色\/场景/.test(text), `${theme}/${scope}: asset menu has only scoped production actions`);
            await page.screenshot({ path: join(output, `${theme}-${scope}-menu.png`), animations: "disabled" });
            await menu.getByRole("button", { name: "生图", exact: true }).click();
            const panel = page.locator(".canvas-workflow-generator"); await panel.waitFor();
            check((await panel.innerText()).includes("生图模型"), `${theme}/${scope}: image action selects image capability`);
            if (scope === "single") check((await panel.locator(".ant-select-selection-item").allTextContents()).some((text: string) => text.includes("第二个人物")), `${theme}: individual image action selects the clicked second asset`);
            if (partial) {
                check(await panel.getByRole("alert").count() === 0, `${theme}/${scope}: running plan and unfinished siblings do not block images`);
                if (scope === "group") await panel.getByRole("checkbox", { name: "全选当前组", exact: true }).check();
                const count = scope === "group" ? 2 : 1;
                check((await panel.getByRole("status", { name: "资产选择数量" }).innerText()).includes(`已选 ${count} / 2 项`), `${theme}/${scope}: only completed assets are selectable`);
                await panel.getByRole("button", { name: "选择模型", exact: true }).click();
                const picker = page.locator(".canvas-model-picker-menu:visible");
                if (await picker.locator(".canvas-model-picker-brands").count()) await picker.locator(".canvas-model-picker-brand").first().click();
                await picker.locator(".canvas-model-picker-option").first().click(); await picker.waitFor({ state: "hidden" });
                const generate = panel.getByRole("button", { name: `生成 ${count} 张图片`, exact: true });
                check(await generate.isEnabled(), `${theme}/${scope}: generation is enabled before plan completion`);
                await page.screenshot({ path: join(output, `${theme}-${scope}-ready.png`), animations: "disabled" });
                await generate.click(); await panel.waitFor({ state: "hidden" });
                const deadline = Date.now() + 12000;
                while (requests.length < count && Date.now() < deadline) await page.waitForTimeout(50);
                check(requests.length === count && requests.every((request) => request.type === "canvas_image"), `${theme}/${scope}: creates ${count} image tasks while plan is running`);
                check(project.nodes.find((node: any) => node.id === plan.manifest.id).metadata.status === "loading", `${theme}/${scope}: original plan remains running`);
                await page.reload(); await page.locator("[aria-label='图片容器进度']").waitFor({ state: "visible" });
                check(requests.length === count, `${theme}/${scope}: reload does not duplicate image tasks`);
                await context.close(); continue;
            }
            await panel.getByRole("button", { name: "关闭生成设置", exact: true }).click();
            await node.click({ button: "right", position: { x: 40, y: 20 } });
            await menu.getByRole("button", { name: "重做另一版", exact: true }).click(); await panel.waitFor();
            const count = scope === "group" ? 2 : 1;
            check((await panel.innerText()).includes(`本次重做 ${count} 项资产`) && !(await panel.innerText()).includes("分集正文来源"), `${theme}/${scope}: scoped remake dialog has no whole-plan input`);
            await panel.getByRole("button", { name: "选择模型", exact: true }).click();
            const picker = page.locator(".canvas-model-picker-menu:visible");
            if (await picker.locator(".canvas-model-picker-brands").count()) await picker.locator(".canvas-model-picker-brand").first().click();
            await picker.locator(".canvas-model-picker-option").first().click();
            await picker.waitFor({ state: "hidden" });
            await page.screenshot({ path: join(output, `${theme}-${scope}-remake.png`), animations: "disabled" });
            await panel.getByRole("button", { name: `重做 ${count} 项资产`, exact: true }).click(); await panel.waitFor({ state: "hidden" });
            const deadline = Date.now() + 12000;
            while (requests.length < count && Date.now() < deadline) await page.waitForTimeout(50);
            check(requests.length === count && requests.every((request) => request.type === "canvas_text"), `${theme}/${scope}: submits exactly ${count} independent text tasks`);
            check(project.nodes.filter((node: any) => node.metadata?.shortDrama?.assetRevision).length === count, `${theme}/${scope}: saves the new asset versions`);
            await page.reload(); await page.locator("[aria-label='资产重做进度']").waitFor({ state: "visible" });
            check(requests.length === count, `${theme}/${scope}: reload restores progress without submitting again`);
            await context.close();
        }
    }
    check(report.errors.length === 0, "no browser runtime errors");
    check(!report.blocked.some((entry) => entry.startsWith("POST /agent/runs")), "remake never starts a production plan agent");
    console.log(JSON.stringify(report));
} finally { writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2)); await browser.close(); server.stop(true); }
