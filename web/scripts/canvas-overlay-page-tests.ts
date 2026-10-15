/** Real production overlays on the synthetic loopback canvas; no generation requests. */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CanvasNodeType } from "../src/types/canvas";

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const origin = process.env.CANVAS_TEST_ORIGIN || "http://127.0.0.1:4020";
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error("Only isolated loopback fixtures are allowed");
if ((await (await fetch(`${origin}/api/auth/session`)).json()).data?.user?.id !== "canvas-benchmark") throw new Error("Refusing non-fixture session");
const baseline = process.argv.includes("--baseline");
const output = resolve(process.env.CANVAS_TEST_REPORT_DIR || `../.local/canvas-benchmark/overlays-${baseline ? "baseline" : "current"}`);
mkdirSync(output, { recursive: true });
const path = "/api/canvas-projects/benchmark-100-spread";
const read = async () => (await (await fetch(origin + path)).json()).data.project;
const initial = await read();
const save = async (project: any) => {
    const response = await fetch(origin + path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project }) });
    if (!response.ok) throw new Error(`Fixture save failed: ${response.status}`);
};
const report: any = { baseline, buildIndexSha256: createHash("sha256").update(await (await fetch(origin)).text()).digest("hex"), observations: [], errors: [], limitations: ["Viewport resizing is not native Chrome browser zoom.", "Synthetic model catalog; no Agent execution or paid generation."] };
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const theme = process.env.CANVAS_TEST_THEME || "dark";
const deviceScaleFactor = Number(process.env.CANVAS_TEST_DPR || 1);
report.environment = { theme, deviceScaleFactor, chrome: browser.version() };
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor });
page.on("pageerror", (error: Error) => report.errors.push(error.message));
await page.route("**/api/model-catalog", (route: any) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ code: 0, data: {
    source: "system", channels: Array.from({ length: 30 }, (_, group) => ({ id: `overlay-fixture-${group}`, displayName: `Overlay fixture ${group}`, models: Array.from({ length: group === 0 ? 30 : 1 }, (_, i) => ({ id: `fixture-${group}-${i}`, modelKey: `fixture-${group}-${i}`, displayName: `Fixture text ${group}`, capability: "text", protocol: "openai", available: true, description: "Synthetic model option for viewport boundary checks. ".repeat(8), priceTiers: [] })) })),
}, msg: "" }) }));
const measure = async (selector: string, name: string) => {
    const element = page.locator(selector).filter({ visible: true }).last();
    await element.waitFor({ state: "visible" });
    await page.waitForTimeout(650);
    const metrics = await element.evaluate((el: HTMLElement) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const x = Math.max(1, Math.min(innerWidth - 1, rect.left + rect.width / 2));
        const y = Math.max(1, Math.min(innerHeight - 1, rect.top + Math.min(30, rect.height / 2)));
        return { rect: rect.toJSON(), viewport: { width: innerWidth, height: innerHeight }, inBounds: rect.left >= -1 && rect.top >= -1 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1,
            hitInside: el.contains(document.elementFromPoint(x, y)), color: style.color, background: style.backgroundColor };
    });
    report.observations.push({ name, passed: metrics.inBounds && metrics.hitInside, ...metrics });
    return metrics;
};
const menu = "[data-canvas-context-menu]";
const scrollInside = async (selector: string, name: string) => {
    const element = page.locator(selector).filter({ visible: true }).last();
    const node = page.locator('[data-node-id="overlay-text"]');
    const before = await node.boundingBox();
    const box = await element.boundingBox();
    if (!box) throw new Error(`Missing scroll target: ${name}`);
    await page.mouse.move(box.x + box.width / 2, box.y + Math.min(40, box.height / 2));
    await page.mouse.wheel(0, 20000);
    await page.waitForTimeout(650);
    const scroll = await element.evaluate((el: HTMLElement) => ({ top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight }));
    const after = await node.boundingBox();
    const stable = before && after && ["x", "y", "width", "height"].every((key) => Math.abs(before[key] - after[key]) < 1);
    report.observations.push({ name, passed: stable && scroll.top > 0 && scroll.height - scroll.client - scroll.top < 2, scroll, canvasStable: stable });
};
const visit = async () => {
    await page.goto(`${origin}/canvas/benchmark-100-spread?canvasDiagnostics=1`);
    await page.waitForSelector('[data-node-id="overlay-text"]');
    await page.waitForTimeout(500);
};
try {
    await save({ ...initial, title: "Overlay fixture", appearance: { mode: theme }, nodes: [{ id: "overlay-text", type: CanvasNodeType.Text, title: "Overlay text", position: { x: 430, y: 250 }, width: 400, height: 180, metadata: { content: "Synthetic editable text", manualSize: true } }], connections: [], viewport: { x: 60, y: 80, k: 1 } });
    await visit();
    await page.waitForSelector(`.infinite-canvas-classic-${theme}`);
    report.observations.push({ name: "requested-canvas-theme-active", passed: true });
    for (const point of [{ name: "top-left", x: 100, y: 100 }, { name: "top-right", x: 1410, y: 100 }, { name: "bottom-left", x: 100, y: 860 }, { name: "bottom-right", x: 1410, y: 860 }]) {
        await page.mouse.click(point.x, point.y, { button: "right" });
        await measure(menu, `context-${point.name}`);
        await page.locator(menu).getByRole("button", { name: "添加节点", exact: true }).click();
        const createMenu = page.getByRole("heading", { name: "添加节点", exact: true });
        await createMenu.waitFor();
        await measure('.aceternity-floating-panel:has(h2)', `submenu-${point.name}`);
        await page.screenshot({ path: join(output, `menu-${point.name}.png`) });
        await page.keyboard.press("Escape");
        await page.locator(menu).waitFor({ state: "hidden" });
    }
    await page.mouse.click(1410, 860, { button: "right" });
    await page.locator(menu).getByRole("button", { name: "添加节点", exact: true }).click();
    await page.setViewportSize({ width: 800, height: 500 });
    await measure(menu, "context-resize-open");
    await measure('.aceternity-floating-panel:has(h2)', "submenu-resize-open");
    await page.screenshot({ path: join(output, "menu-resize.png") });
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('[data-node-id="overlay-text"]').click({ button: "right", position: { x: 50, y: 30 } });
    await measure(menu, "text-context-content-height");
    await page.setViewportSize({ width: 800, height: 360 });
    await measure(menu, "text-context-small-height");
    await scrollInside(`${menu} .thin-scrollbar`, "text-menu-scroll-without-canvas-movement");
    await page.screenshot({ path: join(output, "text-menu-small.png") });
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator(".canvas-agent-launcher").click();
    await page.getByRole("button", { name: "恢复 Agent 紧凑窗口", exact: true }).click();
    await measure(".canvas-agent-panel", "agent-initial");
    for (const name of ["top-left", "top-right", "bottom-left", "bottom-right"]) {
        const header = await page.locator(".agent-panel-header").boundingBox();
        const panel = await page.locator(".canvas-agent-panel").boundingBox();
        if (!header || !panel) throw new Error("Agent drag anchor missing");
        const corner = { name, x: name.endsWith("left") ? 12 : 1440 - panel.width - 12, y: name.startsWith("top") ? 12 : 1000 - panel.height - 12 };
        await page.mouse.move(header.x + 75, header.y + 20);
        await page.mouse.down();
        await page.mouse.move(header.x + 75 + corner.x - panel.x, header.y + 20 + corner.y - panel.y, { steps: 8 });
        await page.mouse.up();
        await measure(".canvas-agent-panel", `agent-${corner.name}`);
        await page.locator(".agent-context-ring").click();
        await measure(".agent-context-popover", `context-ring-${corner.name}`);
        await page.screenshot({ path: join(output, `agent-${corner.name}.png`) });
        await page.locator(".agent-context-ring").click();
    }
    await page.locator(".agent-composer-model-trigger").click();
    await measure(".agent-model-picker-popover", "agent-model-picker");
    await page.setViewportSize({ width: 1200, height: 500 });
    await measure(".canvas-agent-panel", "agent-resize-open");
    await measure(".agent-model-picker-popover", "agent-model-resize-open");
    await scrollInside(".canvas-model-picker-menu", "model-options-scroll-without-canvas-movement");
    const optionCount = await page.locator(".canvas-model-picker-option").count();
    const lastOptionVisible = await page.locator(".canvas-model-picker-option").last().evaluate((el: HTMLElement) => { const rect = el.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight; });
    report.observations.push({ name: "last-model-option-reachable", passed: optionCount === 30 && lastOptionVisible, optionCount });
    await page.screenshot({ path: join(output, "model-small.png") });
    await page.mouse.click(50, 100);
    await page.locator(".agent-model-picker-popover").waitFor({ state: "hidden" });
    report.observations.push({ name: "model-outside-click-close", passed: true });
    await page.locator(".agent-composer-model-trigger").click();
    await page.locator(".canvas-model-picker-option").first().focus();
    await page.keyboard.press("ArrowLeft");
    await measure(".agent-model-picker-popover", "model-brand-list-small-height");
    await scrollInside(".canvas-model-picker-menu.is-brand-list", "model-brands-scroll-without-canvas-movement");
    await page.keyboard.press("End");
    const lastBrandFocused = await page.locator(".canvas-model-picker-brands button").last().evaluate((el: HTMLElement) => document.activeElement === el);
    await page.keyboard.press("Escape");
    await page.locator(".agent-model-picker-popover").waitFor({ state: "hidden" });
    report.observations.push({ name: "model-brand-keyboard-end-escape", passed: lastBrandFocused && await page.locator(".agent-composer-model-trigger").evaluate((el: HTMLElement) => document.activeElement === el) });
    await page.locator(".agent-context-ring").click();
    await page.setViewportSize({ width: 1200, height: 220 });
    await measure(".agent-context-popover", "context-ring-small-height");
    await scrollInside(".agent-context-panel", "context-detail-scroll-without-canvas-movement");
    report.smallAgentLayout = await page.locator(".canvas-agent-panel").evaluate((el: HTMLElement) => [el, ...el.querySelectorAll(".agent-panel-header, .agent-composer-wrap, .agent-composer-surface, .agent-composer-prompt-scroll, .agent-composer-toolbar, .agent-context-ring")].map((item) => ({ className: item.className, rect: item.getBoundingClientRect().toJSON(), scrollHeight: item.scrollHeight, clientHeight: item.clientHeight, minHeight: getComputedStyle(item).minHeight })));
    await page.screenshot({ path: join(output, "agent-context-small.png") });
    await page.mouse.click(600, 100);
    await page.locator(".agent-context-popover").waitFor({ state: "hidden" });
    await scrollInside(".agent-panel-chat", "short-agent-chat-scroll-without-canvas-movement");
    await measure(".agent-context-ring", "short-agent-controls-reachable");
    await page.locator(".agent-context-ring").click();
    await page.locator(".agent-context-popover").waitFor({ state: "visible" });
    await page.waitForTimeout(650);
    await page.keyboard.press("Escape");
    await page.locator(".agent-context-popover").waitFor({ state: "hidden" });
    report.observations.push({ name: "context-escape-focus-restored", passed: await page.locator(".agent-context-ring").evaluate((el: HTMLElement) => document.activeElement === el), focusedElement: await page.evaluate(() => ({ tag: document.activeElement?.tagName, className: document.activeElement?.className })) });
    await page.setViewportSize({ width: 1200, height: 500 });
    await page.locator(".agent-composer-model-trigger").click();
    await page.locator(".agent-model-picker-popover").waitFor({ state: "visible" });
    await page.waitForTimeout(650);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(650);
    report.observations.push({ name: "model-trigger-escape-close", passed: await page.locator(".agent-composer-model-trigger").getAttribute("aria-expanded") === "false" });
    const failures = report.observations.filter((entry: any) => !entry.passed);
    if (report.errors.length || (!baseline && failures.length)) throw new Error(`${failures.length} boundary failures, ${report.errors.length} page errors`);
    console.log(JSON.stringify(report, null, 2));
} catch (error) {
    report.failure = String(error); process.exitCode = 1; console.error(error);
    await page.screenshot({ path: join(output, "failure.png") }).catch(() => {});
} finally {
    await browser.close();
    const latest = await read();
    await save({ ...initial, revision: latest.revision });
    writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
}
