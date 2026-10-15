/** Actual production UI with isolated task responses. Never invokes a model provider. */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createShortDramaPipeline } from "../src/lib/canvas/canvas-short-drama";
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const origin = process.env.CANVAS_TEST_ORIGIN || "http://127.0.0.1:4014";
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin) || (await (await fetch(`${origin}/api/auth/session`)).json()).data?.user?.id !== "canvas-benchmark") throw new Error("Isolated fixture account required");
const canvasId = "benchmark-100-spread";
const original = (await (await fetch(`${origin}/api/canvas-projects/${canvasId}`)).json()).data.project;
const output = resolve(process.env.CANVAS_TEST_REPORT_DIR || "../.local/canvas-benchmark/story-development-current");
mkdirSync(output, { recursive: true });
const report = { buildIndexSha256: createHash("sha256").update(await (await fetch(origin)).text()).digest("hex"), passed: [] as string[], errors: [] as string[], blocked: [] as string[] };
const check = (condition: boolean, label: string) => { if (!condition) throw new Error(label); report.passed.push(label); };
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
try {
    for (const theme of ["dark", "light"]) {
        const pipeline = createShortDramaPipeline({ x: 0, y: 0 });
        pipeline.nodes.find((node) => node.metadata?.storyDevelopment?.stage === "topic")!.metadata!.storyDevelopment!.brief!.episodeCount = 2;
        if (theme === "light") {
            const plan = pipeline.nodes.find((node) => node.metadata?.storyDevelopment?.stage === "plan")!;
            const legacy = { ...plan, id: "legacy-outline", title: "原故事粗纲", position: { x: plan.position.x, y: 500 }, metadata: { ...plan.metadata, content: "LEGACY_STORY_CONTENT：主角最终放下相机。", storyDevelopment: { ...plan.metadata!.storyDevelopment!, stage: "outline" as const, sourceNodeIds: [...plan.metadata!.storyDevelopment!.sourceNodeIds, plan.id], sourceSignatures: { [plan.id]: "obsolete-plan" } } } };
            pipeline.nodes.push(legacy);
            for (const node of pipeline.nodes.filter((item) => ["episodes", "body"].includes(item.metadata?.storyDevelopment?.stage || ""))) node.metadata!.storyDevelopment!.sourceNodeIds.push(legacy.id);
        }
        let cloud = { ...original, ...pipeline, projectId: "", appearance: { mode: theme }, viewport: { x: 600, y: 200, k: 0.6 } };
        const context = await browser.newContext({ viewport: { width: 1440, height: 945 }, serviceWorkers: "block" });
        await context.addInitScript((theme: string) => localStorage.setItem("infinite-canvas:canvas-theme", JSON.stringify({ state: { theme }, version: 0 })), theme);
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        page.on("pageerror", (error: Error) => report.errors.push(error.message));
        const requests: any[] = [];
        let fail = false;
        let pending = false;
        let loseReceipt = false;
        let queryOffline = false;
        let cancelCount = 0;
        const tasks = new Map<string, any>();
        await context.route("**/*", async (route: any) => {
            const request = route.request();
            const url = new URL(request.url());
            const path = url.pathname;
            const envelope = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ code: status === 200 ? 0 : status, data, msg: status === 200 ? "" : "Fixture generation failed" }) });
            if (url.origin !== origin) { report.blocked.push(path); return route.abort(); }
            if (path === "/api/model-catalog") return envelope({ source: "system", channels: [{ id: "story-test", displayName: "Fixture", models: [{ id: "story-text", modelKey: "story-text", displayName: "Fixture text", capability: "text", protocol: "openai", available: true, priceTiers: [] }] }] });
            if (path === `/api/canvas-projects/${canvasId}` && request.method() === "GET") return envelope({ project: cloud });
            if (path === `/api/canvas-projects/${canvasId}` && request.method() === "PUT") {
                const input = request.postDataJSON();
                if (input.project.revision !== cloud.revision) return envelope(null, 409);
                cloud = { ...input.project, revision: cloud.revision + 1 }; return envelope({ project: cloud });
            }
            if (path === "/api/tasks" && request.method() === "POST") {
                const input = request.postDataJSON(); requests.push(input);
                if (fail) return envelope(null, 400);
                const stage = input.input.metadata.stage;
                const requestedCount = /一次生成 (\d+) 个差异明确/.exec(input.prompt);
                const text = requestedCount ? JSON.stringify({ topics: Array.from({ length: Number(requestedCount[1]) }, (_, index) => ({ title: `选题${index + 1}中的人生`, logline: "相机让主角看到另一种选择", conflict: "选择改变了亲友的生活", appeal: "情感与悬疑" })) }) : `${stage} 创作结果\n${stage === "body" ? "第 1 集 场次 1 内景 日\n林晚：我想看看另一个选择。" : "故事定位、人物关系与连续性。"}`;
                const task = { id: `story-task-${requests.length}`, projectId: canvasId, clientContext: { storyNodeId: input.input.metadata.storyNodeId, clientOperationId: input.input.metadata.clientOperationId }, type: "canvas_text", status: pending ? "running" : "succeeded", model: "story-text", prompt: input.prompt, resultJson: JSON.stringify({ text }), attempts: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
                tasks.set(task.id, task); return loseReceipt ? envelope(null, 503) : envelope(task);
            }
            if (path === "/api/tasks" && request.method() === "GET") return envelope([...tasks.values()].map(({ resultJson, ...summary }) => summary));
            if (/^\/api\/tasks\/story-task-\d+\/cancel$/.test(path)) { cancelCount++; const task = { ...tasks.get(path.split("/")[3]), status: "cancelled" }; tasks.set(task.id, task); return envelope(task); }
            if (/^\/api\/tasks\/story-task-\d+$/.test(path)) return queryOffline ? envelope(null, 503) : envelope(tasks.get(path.split("/")[3]));
            if (request.method() !== "GET" && path !== "/api/assets/batch") { report.blocked.push(`${request.method()} ${path}`); return route.abort(); }
            return route.continue();
        });
        const saved = async (predicate: () => boolean) => { for (let attempt = 0; attempt < 150 && !predicate(); attempt++) await new Promise((resolve) => setTimeout(resolve, 100)); check(predicate(), `${theme}: edited document reached fixture cloud`); };
        const openStage = async (stage: string, targetPage = page) => {
            const guide = targetPage.getByRole("region", { name: "短剧完整制作流程", exact: true });
            const toggle = targetPage.getByRole("button", { name: "短剧流程", exact: true });
            await toggle.waitFor();
            if (await toggle.getAttribute("aria-pressed") === "false") await toggle.click();
            await guide.waitFor();
            await guide.locator(".canvas-drama-stage").filter({ hasText: "剧情与章节" }).click();
            await guide.locator(`[data-task-key='story.${stage}'] button`).click();
            await targetPage.getByRole("textbox", { name: "创作正文", exact: true }).waitFor();
            await targetPage.waitForFunction(() => !document.querySelector<HTMLTextAreaElement>('[aria-label="创作正文"]')?.disabled);
        };
        const closeEditor = () => page.getByRole("button", { name: "关闭创作编辑器", exact: true }).click();
        const saveEditor = async () => {
            await page.getByRole("button", { name: "保存", exact: true }).click();
            await page.locator(".story-development-header").getByRole("status").filter({ hasText: "已写回画布" }).waitFor();
        };
        try {
            await page.goto(`${origin}/canvas/${canvasId}`);
            await page.getByRole("region", { name: "剧情与章节子任务", exact: true }).waitFor();
            check(await page.getByRole("region", { name: "短剧制作阶段与子任务总览", exact: true }).count() === 0, `${theme}: only current stage expands initially`);
            check(await page.locator('[data-task-key="story.outline"]').count() === 0 && await page.locator('[data-task-key^="story."]').count() === 4, `${theme}: story guide exposes four steps without separate outline`);
            const modelGuide = page.getByRole("button", { name: "关闭模型配置引导", exact: true });
            if (await modelGuide.isVisible()) await modelGuide.click();
            await openStage("topic");
            check(await page.locator('.story-development-ai').getByRole("textbox", { name: "类型", exact: true }).count() === 1, `${theme}: topic inputs live in right sidebar`);
            check(await page.getByRole("spinbutton", { name: "计划集数", exact: true }).count() === 0 && await page.getByRole("textbox", { name: "目标观众", exact: true }).count() === 0, `${theme}: topic form omits production and audience fields`);
            check(await page.getByRole("button", { name: "生成选题抽取", exact: true }).count() === 0, `${theme}: empty topic has one generation action`);
            await page.getByRole("textbox", { name: "类型", exact: true }).fill("当代奇幻、群像情感");
            await page.getByRole("textbox", { name: "风格", exact: true }).fill("原创3D动漫，情感悬疑");
            await page.getByRole("textbox", { name: "核心设定", exact: true }).fill("相机让人看见自己放弃的人生");
            await page.getByRole("spinbutton", { name: "一次生成选题数", exact: true }).fill("7");
            await page.getByRole("button", { name: "生成选题", exact: true }).click();
            await page.getByRole("region", { name: "选题结果" }).waitFor();
            check(await page.getByRole("textbox", { name: "创作正文", exact: true }).inputValue() === "", `${theme}: drawing candidates never silently adopts one`);
            await page.getByRole("button", { name: "随机采用一个", exact: true }).click();
            check(await page.locator('.story-development-document .story-development-result-list article').count() === 7 && requests.at(-1).prompt.includes("一次生成 7 个"), `${theme}: requested seven candidates appear on left`);
            const chosen = await page.getByRole("textbox", { name: "创作正文", exact: true }).inputValue();
            check(chosen.includes("选择改变"), `${theme}: random draw selects a complete candidate`);
            await page.getByRole("button", { name: "AI 调整", exact: true }).click();
            await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('[aria-label="创作正文"]')?.value.includes("topic 创作结果"));
            check(true, `${theme}: selected topic AI adjustment writes directly into body`);
            await page.getByRole("button", { name: "撤销 AI 更新", exact: true }).click();
            check(await page.getByRole("textbox", { name: "创作正文", exact: true }).inputValue() === chosen, `${theme}: topic AI adjustment can be undone`);
            await saveEditor();
            await saved(() => cloud.nodes.some((node: any) => node.metadata?.storyDevelopment?.stage === "topic" && node.metadata.content === chosen));
            await page.waitForTimeout(400);
            await page.screenshot({ path: join(output, `${theme}-topic.png`) });
            await page.setViewportSize({ width: 390, height: 844 });
            await page.getByRole("spinbutton", { name: "一次生成选题数", exact: true }).scrollIntoViewIfNeeded();
            check(await page.locator('.story-development-layout').evaluate((el: HTMLElement) => el.scrollWidth <= el.clientWidth + 1), `${theme}: topic results and controls fit narrow viewport`);
            await page.screenshot({ path: join(output, `${theme}-topic-narrow.png`) });
            await page.setViewportSize({ width: 1440, height: 945 });
            for (const [stage, label] of [["plan", "制作方案"], ["episodes", "分集集纲"], ["body", "分集正文"]]) {
                await page.getByRole("button", { name: `保存并进入${label}`, exact: true }).click();
                await page.getByRole("region", { name: `${label}编辑器`, exact: true }).waitFor();
                check(true, `${theme}: next action opens ${stage} in the same pipeline`);
                if (stage === "plan") pending = true;
                await page.getByRole("button", { name: `生成${label}`, exact: true }).click();
                if (stage === "plan") {
                    await page.getByRole("button", { name: "停止", exact: true }).waitFor();
                    check(["故事总纲", "明确结局", "人物弧光", "集数分配", "伏笔与回收"].every((text) => requests.at(-1).prompt.includes(text)), `${theme}: plan generation includes merged story architecture`);
                    check(await page.getByRole("button", { name: "保存并进入分集集纲", exact: true }).count() === 1, `${theme}: plan next step is episode outlines`);
                    const count = requests.length;
                    await page.getByRole("textbox", { name: "创作正文", exact: true }).fill("任务运行期间补充的方案");
                    await page.getByRole("textbox", { name: "AI 调整要求", exact: true }).fill("下一轮保留人物关系");
                    await page.getByRole("button", { name: "后台运行", exact: true }).click();
                    await page.getByRole("region", { name: "制作方案编辑器", exact: true }).waitFor({ state: "hidden" });
                    check(cancelCount === 0, `${theme}: suspending editor never cancels backend task`);
                    await page.reload(); await openStage("plan");
                    await page.getByRole("button", { name: "停止", exact: true }).waitFor();
                    check(requests.length === count, `${theme}: refresh resumes task without duplicate POST`);
                    check(await page.getByRole("textbox", { name: "AI 调整要求", exact: true }).inputValue() === "下一轮保留人物关系", `${theme}: generation instructions survive suspend and refresh`);
                    const active = [...tasks.values()].at(-1)!;
                    tasks.set(active.id, { ...active, status: "succeeded" }); pending = false;
                }
                await page.waitForFunction((stage: string) => document.querySelector<HTMLTextAreaElement>('[aria-label="创作正文"]')?.value.includes(`${stage} 创作结果`), stage);
                if (stage === "plan") {
                    const count = requests.length;
                    await closeEditor(); await page.reload(); await openStage("plan");
                    check((await page.getByRole("textbox", { name: "创作正文", exact: true }).inputValue()).includes("plan 创作结果"), `${theme}: generated body survives refresh`);
                    check(requests.length === count, `${theme}: completed body recovers without regeneration`);
                    await page.waitForTimeout(400);
                    await page.screenshot({ path: join(output, `${theme}-plan-recovered.png`) });
                }
                check(requests.at(-1).input.textOptions.stream === true, `${theme}: ${stage} enables backend streaming`);
                check(await page.getByRole("button", { name: "采用到草稿", exact: true }).count() === 0, `${theme}: ${stage} requires no adoption step`);
                check(requests.at(-1).prompt.includes(JSON.stringify(chosen)), `${theme}: ${stage} reads adopted topic`);
                check(!requests.at(-1).prompt.includes("LEGACY_STORY_CONTENT"), `${theme}: legacy reference never silently overrides the production plan`);
                await page.getByRole("button", { name: "撤销 AI 更新", exact: true }).click();
                check(await page.getByRole("textbox", { name: "创作正文", exact: true }).inputValue() === (stage === "plan" ? "任务运行期间补充的方案" : ""), `${theme}: ${stage} undo restores the previous body including in-flight edits`);
                await page.getByRole("button", { name: "重做 AI 更新", exact: true }).click();
                check((await page.getByRole("textbox", { name: "创作正文", exact: true }).inputValue()).includes(`${stage} 创作结果`), `${theme}: ${stage} redo restores the generated body`);
                await saveEditor();
                await saved(() => cloud.nodes.some((node: any) => node.metadata?.storyDevelopment?.stage === stage && node.metadata.content?.includes(`${stage} 创作结果`)));
            }
            check(requests.at(-1).prompt.includes("本次只生成第 1 集") && requests.at(-1).prompt.includes("episodes 创作结果"), `${theme}: body uses episode outlines and explicit episode number`);
            await page.getByRole("textbox", { name: "AI 调整要求", exact: true }).fill("减少旁白，保留悬念");
            pending = true;
            await page.getByRole("button", { name: "AI 调整", exact: true }).click();
            await page.getByRole("button", { name: "停止", exact: true }).waitFor();
            await page.getByRole("textbox", { name: "创作正文", exact: true }).fill("我正在手工修改的正文");
            const adjusted = [...tasks.values()].at(-1)!;
            tasks.set(adjusted.id, { ...adjusted, status: "succeeded" }); pending = false;
            await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('[aria-label="创作正文"]')?.value.includes("body 创作结果"));
            await page.getByRole("button", { name: "撤销 AI 更新", exact: true }).click();
            check(await page.getByRole("textbox", { name: "创作正文", exact: true }).inputValue() === "我正在手工修改的正文", `${theme}: undo retains manual edits made before completion`);
            await closeEditor(); await page.reload(); await openStage("body");
            check(await page.getByRole("textbox", { name: "创作正文", exact: true }).inputValue() === "我正在手工修改的正文", `${theme}: undo survives refresh and completed task is not applied twice`);
            check(await page.getByRole("button", { name: "重做 AI 更新", exact: true }).isEnabled(), `${theme}: redo survives refresh`);
            await page.getByRole("textbox", { name: "创作正文", exact: true }).fill("撤销后继续改稿");
            check(await page.getByRole("button", { name: "重做 AI 更新", exact: true }).isDisabled(), `${theme}: editing after undo clears redo`);
            await page.getByRole("textbox", { name: "创作正文", exact: true }).fill("我正在手工修改的正文");
            await saveEditor();
            fail = true;
            await page.getByRole("button", { name: "AI 调整", exact: true }).click();
            await page.getByRole("alert").filter({ hasText: "Fixture generation failed" }).waitFor();
            check(await page.getByRole("textbox", { name: "创作正文", exact: true }).inputValue() === "我正在手工修改的正文", `${theme}: HTTP failure keeps manual content`);
            fail = false; pending = true;
            loseReceipt = true;
            const taskResponse = page.waitForResponse((response: any) => response.url() === `${origin}/api/tasks` && response.request().method() === "POST");
            await page.getByRole("button", { name: "AI 调整", exact: true }).click();
            await taskResponse;
            await page.getByRole("button", { name: "停止", exact: true }).waitFor();
            check(true, `${theme}: lost submission receipt recovers exact task from safe list context`);
            loseReceipt = false;
            const submittedCount = requests.length;
            queryOffline = true;
            await page.getByRole("status").filter({ hasText: "任务状态暂不可用" }).waitFor();
            check(await page.getByRole("button", { name: "AI 调整", exact: true }).isDisabled(), `${theme}: offline observation does not release active generation`);
            queryOffline = false;
            await page.getByRole("status").filter({ hasText: "任务状态暂不可用" }).waitFor({ state: "hidden" });
            check(requests.length === submittedCount, `${theme}: reconnect never resubmits model request`);
            await page.getByRole("button", { name: "停止", exact: true }).click();
            await page.getByRole("status").filter({ hasText: "任务已取消" }).waitFor();
            pending = false;
            check(await page.getByRole("textbox", { name: "创作正文", exact: true }).inputValue() === "我正在手工修改的正文", `${theme}: stopping keeps draft`);
            pending = true;
            await page.getByRole("button", { name: "AI 调整", exact: true }).click();
            await page.getByRole("button", { name: "停止", exact: true }).waitFor();
            const interrupted = [...tasks.values()].at(-1)!;
            tasks.set(interrupted.id, { ...interrupted, status: "failed", error: "模型服务响应超时，请稍后重试", textDraft: "未完成的制作片段" });
            await page.getByRole("status").filter({ hasText: "生成失败，原稿已保留" }).waitFor();
            check(await page.getByRole("textbox", { name: "生成中片段", exact: true }).inputValue() === "未完成的制作片段", `${theme}: provider failure retains partial output as incomplete`);
            check(await page.getByRole("region", { name: "AI 修改预览" }).count() === 0, `${theme}: partial failure is never offered as a completed result`);
            check(await page.getByRole("textbox", { name: "创作正文", exact: true }).inputValue() === "我正在手工修改的正文", `${theme}: partial failure never replaces the body`);
            pending = false;
            await page.getByRole("button", { name: "新建下一集正文", exact: true }).click();
            await page.waitForFunction(() => document.querySelector<HTMLInputElement>('[aria-label="创作节点标题"]')?.value === "第 2 集 · 正文");
            check(await page.getByRole("textbox", { name: "创作节点标题", exact: true }).inputValue() === "第 2 集 · 正文", `${theme}: next episode has a separate node`);
            check(await page.getByRole("textbox", { name: "创作正文", exact: true }).inputValue() === "", `${theme}: next episode does not reuse prior body`);
            await page.getByRole("textbox", { name: "创作正文", exact: true }).fill("第2集手写正文");
            await closeEditor(); await openStage("body");
            check(await page.getByRole("textbox", { name: "创作正文", exact: true }).inputValue() === "第2集手写正文", `${theme}: unsaved local draft survives closing editor`);
            await saveEditor();
            await page.waitForTimeout(400);
            await page.screenshot({ path: join(output, `${theme}-body.png`) });
            await page.setViewportSize({ width: 390, height: 844 });
            const bounds = await page.locator(".story-development-editor").boundingBox();
            check(bounds.x >= 0 && bounds.x + bounds.width <= 390 && bounds.y >= 0 && bounds.y + bounds.height <= 844, `${theme}: editor fits narrow viewport`);
            check(await page.locator(".story-development-layout").evaluate((el: HTMLElement) => el.scrollWidth <= el.clientWidth + 1), `${theme}: editor has no horizontal overflow`);
            await page.getByRole("button", { name: "AI 调整", exact: true }).scrollIntoViewIfNeeded();
            await page.screenshot({ path: join(output, `${theme}-narrow.png`) });
            await closeEditor();
            await saved(() => cloud.nodes.some((node: any) => node.metadata?.storyDevelopment?.episodeNumber === 2 && node.metadata.content === "第2集手写正文"));
            await page.setViewportSize({ width: 1440, height: 945 });
            await page.reload();
            await page.getByRole("button", { name: "短剧流程", exact: true }).waitFor();
            await openStage("body");
            check(await page.getByRole("textbox", { name: "创作正文", exact: true }).inputValue() === "第2集手写正文", `${theme}: reload restores episode body from saved canvas`);
            await closeEditor();
            await openStage("topic");
            check(await page.getByRole("spinbutton", { name: "一次生成选题数", exact: true }).inputValue() === "7", `${theme}: candidate count survives reload`);
            await page.getByRole("textbox", { name: "创作正文", exact: true }).fill(`${chosen}\n新增结局约束`); await saveEditor(); await closeEditor();
            await openStage("plan");
            await page.getByRole("status").filter({ hasText: "上游内容已变更" }).waitFor();
            check((await page.getByRole("textbox", { name: "创作正文", exact: true }).inputValue()).includes("plan 创作结果"), `${theme}: upstream change flags review and preserves downstream text`);
            await closeEditor();
            const planNodeId = pipeline.nodes.find((node) => node.metadata?.storyDevelopment?.stage === "plan")!.id;
            await page.locator(`[data-node-id='${planNodeId}']`).dblclick({ position: { x: 110, y: 90 } });
            await page.getByRole("region", { name: "制作方案编辑器", exact: true }).waitFor();
            check(true, `${theme}: double click opens the same document editor`);
            check(await page.getByRole("button", { name: "完善制作方案", exact: true }).count() === 1, `${theme}: existing plans expose an improvement action`);
            if (theme === "light") {
                await page.locator("summary").filter({ hasText: "历史粗纲参考" }).click();
                check((await page.getByRole("textbox", { name: "历史粗纲参考", exact: true }).inputValue()).includes("LEGACY_STORY_CONTENT"), "Legacy outline remains readable from the plan");
                await page.getByRole("button", { name: "补入制作方案草稿", exact: true }).click();
                const merged = await page.getByRole("textbox", { name: "创作正文", exact: true }).inputValue();
                check(merged.includes("plan 创作结果") && merged.includes("LEGACY_STORY_CONTENT"), "Explicit merge preserves both plan and legacy content");
                await saveEditor();
                await saved(() => cloud.nodes.some((node: any) => node.id === planNodeId && node.metadata.content === merged));
                check(cloud.nodes.find((node: any) => node.id === "legacy-outline")?.metadata?.content === "LEGACY_STORY_CONTENT：主角最终放下相机。", "Merge preserves original legacy node");
                await page.screenshot({ path: join(output, "light-plan-merged.png") });
                await page.setViewportSize({ width: 390, height: 844 });
                await page.getByRole("button", { name: "补入制作方案草稿", exact: true }).scrollIntoViewIfNeeded();
                check(await page.locator(".story-development-layout").evaluate((el: HTMLElement) => el.scrollWidth <= el.clientWidth + 1), "Expanded legacy reference fits narrow viewport");
                await page.screenshot({ path: join(output, "light-plan-merged-narrow.png") });
                await page.setViewportSize({ width: 1440, height: 945 });
            }
            check(cancelCount >= 1, `${theme}: stop requests backend task cancellation`);
            await closeEditor(); await openStage("topic");
            const otherPage = await context.newPage();
            await otherPage.goto(`${origin}/canvas/${canvasId}`); await openStage("topic", otherPage);
            await page.getByRole("textbox", { name: "AI 调整要求", exact: true }).fill("第一窗口已保存的要求");
            await closeEditor();
            await otherPage.getByRole("textbox", { name: "AI 调整要求", exact: true }).fill("第二窗口旧草稿");
            await otherPage.getByRole("alert").filter({ hasText: "另一窗口已更新" }).waitFor();
            check(await otherPage.getByRole("button", { name: "生成选题", exact: true }).isDisabled(), `${theme}: stale tab cannot submit generation after a draft conflict`);
            await otherPage.close(); await openStage("topic");
            check(await page.getByRole("textbox", { name: "AI 调整要求", exact: true }).inputValue() === "第一窗口已保存的要求", `${theme}: stale tab cannot overwrite durable draft`);
            await closeEditor();
            const legacyNodeId = pipeline.nodes.find((node) => node.metadata?.storyDevelopment?.stage === "episodes")!.id;
            await page.evaluate(async ({ canvasId, nodeId }: { canvasId: string; nodeId: string }) => {
                const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("infinite-canvas"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
                try {
                    await new Promise<void>((resolve, reject) => {
                        const transaction = database.transaction("app_state", "readwrite");
                        const store = transaction.objectStore("app_state");
                        const key = `story-development:${canvasId}:${nodeId}:user:canvas-benchmark`;
                        const request = store.get(key);
                        request.onsuccess = () => {
                            const value = JSON.parse(request.result);
                            store.put(JSON.stringify({ ...value, content: "旧版编辑中的集纲", dirty: true, revision: value.revision + 1, preview: { text: "恢复的旧集纲生成结果", draft: "old-incompatible-draft-key", signatures: { ...value.data.sourceSignatures, "legacy-outline": "obsolete" } } }), key);
                        };
                        transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error);
                    });
                } finally { database.close(); }
            }, { canvasId, nodeId: legacyNodeId });
            const countBeforeRecovery = requests.length;
            await openStage("episodes");
            check(await page.getByRole("textbox", { name: "创作正文", exact: true }).inputValue() === "恢复的旧集纲生成结果", `${theme}: previously blocked preview opens directly in left body`);
            check(await page.getByRole("button", { name: "采用到草稿", exact: true }).count() === 0 && requests.length === countBeforeRecovery, `${theme}: old result recovers without adoption or new model request`);
            await page.waitForTimeout(400);
            await page.screenshot({ path: join(output, `${theme}-old-result-recovered.png`) });
            await page.getByRole("button", { name: "撤销 AI 更新", exact: true }).click();
            check(await page.getByRole("textbox", { name: "创作正文", exact: true }).inputValue() === "旧版编辑中的集纲", `${theme}: migrated preview preserves the previous draft`);
            await closeEditor(); await page.reload(); await openStage("episodes");
            check(await page.getByRole("textbox", { name: "创作正文", exact: true }).inputValue() === "旧版编辑中的集纲", `${theme}: migrated preview is not reapplied after undo and reload`);
            await page.getByRole("button", { name: "重做 AI 更新", exact: true }).click();
            check(await page.getByRole("textbox", { name: "创作正文", exact: true }).inputValue() === "恢复的旧集纲生成结果", `${theme}: migrated result supports redo after reload`);
        } catch (error) {
            await page.screenshot({ path: join(output, `${theme}-failure.png`), fullPage: true }); throw error;
        } finally { await context.close(); }
    }
    check(report.errors.length === 0, "No uncaught page errors"); check(report.blocked.length === 0, "No external or unmocked writes");
} catch (error) { report.errors.push(String(error)); process.exitCode = 1; }
finally { await browser.close(); writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ passed: report.passed.length, errors: report.errors, output }, null, 2)); }
