/** Exercises the real built admin route against an isolated, non-billable API. */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve, sep } from "node:path";
import { defaultModelCapabilityConfig } from "../src/lib/model-capabilities";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const dist = resolve("dist");
const output = resolve("../.local/protocol-browser");
mkdirSync(output, { recursive: true });
const channel = { id: "fixture", name: "Protocol fixture", enabled: true, scope: "system", baseUrl: "https://provider.invalid", apiFormat: "openai", models: ["fixture-text"], concurrencyLimit: 2 };
const initialModel = { id: "fixture-model", channelId: channel.id, modelKey: "fixture-text", providerModelKey: "fixture-text", displayName: "Fixture text", tags: [], icon: "", capability: "text", protocol: "kimi-chat", capabilityConfig: defaultModelCapabilityConfig("chat-completion"), enabled: true, priceConfigured: true, billingMode: "fixed_request", unitPriceMicrocredits: 1, inputTokenPriceMicrocredits: 0, outputTokenPriceMicrocredits: 0, cachedTokenPriceMicrocredits: 0, priceVersion: 1, priceTiers: [] };
let model = structuredClone(initialModel);
const providers = [
    ["chat-completion", "OpenAI Chat Completions", "chat-completions", "/chat/completions", "text"],
    ["kimi-chat", "Kimi OpenAI-Compatible", "chat-completions", "/v1/chat/completions", "text"],
    ["openrouter-chat", "OpenRouter Chat", "chat-completions", "/v1/chat/completions", "text"],
    ["openai-response", "OpenAI Responses", "responses", "/responses", "text"],
    ["claude-api", "Claude Messages", "messages", "/v1/messages", "text"],
    ["openai-image", "OpenAI Image", "image-generations", "/images/generations", "image"],
].map(([id, name, contract, path, capability]) => ({ id, name, contract, create: `POST ${path}`, categories: [capability], scopes: ["admin.system-channel"], version: "1", vendor: "Fixture", enabled: true, agentSupported: capability === "text" }));
const features = { welcomeEnabled: false, shortDramaEnabled: true, taskCenterEnabled: true, creditsEnabled: false, customChannelsEnabled: true, frontendModelsEnabled: false, pluginCenterEnabled: false, systemPluginsVisibleToUsers: false };
const checks: string[] = [], errors: string[] = [], unknown = new Set<string>();
let writes: any[] = [];
const envelope = (data: unknown, status = 200) => Response.json({ code: status === 200 ? 0 : status, data, msg: "" }, { status });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/")) {
        if (path === "/api/auth/session") return envelope({ user: { id: "protocol-fixture", username: "fixture", displayName: "Fixture", role: "admin", status: "active" }, features });
        if (path === "/api/features") return envelope({ features });
        if (path === "/api/admin/references") return envelope({ users: [], channels: [channel] });
        if (path === "/api/admin/channels") return envelope({ channels: [channel], total: 1, page: 1, pageSize: 100 });
        if (path === "/api/admin/channels/fixture/models") return envelope({ models: [model] });
        if (path === "/api/admin/channels/fixture/models/batch-settings") {
            const body = await request.json(); writes.push(body);
            model = { ...model, protocol: body.protocol, capabilityConfig: { ...model.capabilityConfig, protocols: body.protocols } };
            return envelope({ updated: 1 });
        }
        if (path === "/api/admin/channels/fixture/models/fixture-model" && request.method === "PATCH") {
            const body = await request.json(); writes.push(body); model = { ...model, ...body }; return envelope({ model });
        }
        if (path === "/api/plugins/catalog") return envelope({ providers });
        if (path === "/api/channels/system") return envelope({ channels: [] });
        if (path === "/api/model-catalog") return envelope({ source: "system", channels: [] });
        if (path === "/api/plugins") return envelope({ plugins: [], states: {} });
        if (path === "/api/plugins/status") return envelope({ statuses: {}, states: {} });
        if (path === "/api/public/appearance") return envelope({ setting: { brand: { name: "Protocol fixture" }, features }, version: 1 });
        if (path === "/api/user-preferences") return envelope({ preferences: {} });
        if (path === "/api/notifications/unread-count") return envelope({ count: 0 });
        unknown.add(path); return envelope(null, 404);
    }
    const filePath = resolve(dist, `.${decodeURIComponent(path)}`);
    if (filePath !== dist && !filePath.startsWith(dist + sep)) return new Response(null, { status: 403 });
    const file = Bun.file(filePath);
    if (path !== "/" && await file.exists()) return new Response(file);
    return new Response(Bun.file(resolve(dist, "index.html")));
} });
const origin = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
function check(condition: unknown, label: string) { if (!condition) throw new Error(label); checks.push(label); }
try {
    for (const variant of [{ theme: "light", width: 1440, height: 960 }, { theme: "dark", width: 1440, height: 960 }, { theme: "light", width: 390, height: 844 }]) {
        model = structuredClone(initialModel); writes = [];
        const context = await browser.newContext({ viewport: { width: variant.width, height: variant.height }, colorScheme: variant.theme, serviceWorkers: "block" });
        await context.addInitScript((theme: string) => localStorage.setItem("infinite-canvas:theme_store", JSON.stringify({ state: { theme }, version: 0 })), variant.theme);
        await context.route("**/*", (route: any) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        const page = await context.newPage(); page.setDefaultTimeout(12000);
        page.on("pageerror", (error: Error) => errors.push(error.message));
        const tag = `${variant.theme}-${variant.width}`;
        try {
            await page.goto(`${origin}/admin/channels?channel=fixture`);
            await page.getByRole("button", { name: "编辑", exact: true }).first().click();
            let dialog = page.getByRole("dialog");
            const radios = dialog.getByRole("radiogroup", { name: "调用协议" });
            check(await radios.getByRole("radio").count() === 3, `${tag}: vendor aliases consolidated`);
            check(await radios.locator('input[value="kimi-chat"]').isChecked(), `${tag}: preserves existing adapter`);
            await dialog.getByRole("checkbox", { name: "Responses", exact: true }).click();
            await page.waitForFunction(() => Array.from(document.querySelectorAll(".ant-checkbox-wrapper")).some((label) => label.textContent?.trim() === "Responses" && label.querySelector("input")?.checked));
            await dialog.getByText("始终使用默认协议", { exact: true }).click();
            await dialog.getByRole("button", { name: "保存修改", exact: true }).click();
            await dialog.waitFor({ state: "hidden" });
            check(writes[0]?.protocol === "kimi-chat" && writes[0]?.capabilityConfig.protocols.supported.includes("openai-response"), `${tag}: save default and support independently`);
            check(writes[0]?.capabilityConfig.protocols.policy === "fixed", `${tag}: fixed policy saves`);
            await page.getByRole("button", { name: "编辑", exact: true }).first().click();
            dialog = page.getByRole("dialog");
            check(await dialog.getByRole("checkbox", { name: "Responses", exact: true }).isChecked(), `${tag}: reload saved support`);
            await dialog.locator(".model-protocol-routing").scrollIntoViewIfNeeded();
            await dialog.screenshot({ path: resolve(output, `editor-${tag}.png`) });
            const bounds = await dialog.boundingBox();
            check(bounds && bounds.x >= 0 && bounds.x + bounds.width <= variant.width + 1, `${tag}: dialog fits viewport`);
            await dialog.getByRole("button", { name: /^取\s*消$/ }).click();
            await dialog.waitFor({ state: "hidden" });
            await page.locator('tr[data-row-key="fixture-model"] .ant-checkbox-wrapper').click();
            await page.getByRole("button", { name: "批量设置", exact: true }).click();
            dialog = page.getByRole("dialog");
            await dialog.getByRole("checkbox", { name: "能力与调用协议" }).check();
            await dialog.getByRole("checkbox", { name: "Responses", exact: true }).check();
            await dialog.getByText("按任务自动选择", { exact: true }).click();
            await dialog.locator(".model-protocol-routing").scrollIntoViewIfNeeded();
            await dialog.screenshot({ path: resolve(output, `batch-${tag}.png`) });
            await dialog.getByRole("button", { name: /保存设置/ }).click();
            await dialog.waitFor({ state: "hidden" });
            check(writes.at(-1)?.protocols?.supported.includes("openai-response"), `${tag}: batch writes supported contracts`);
            check(writes.at(-1)?.protocols?.policy === "auto", `${tag}: batch auto policy saves`);
        } catch (error) {
            await page.screenshot({ path: resolve(output, `failure-${tag}.png`), fullPage: true });
            throw error;
        } finally { await context.close(); }
    }
    check(errors.length === 0, "no browser runtime errors");
} finally {
    await Bun.write(resolve(output, "report.json"), JSON.stringify({ checks, errors, unknown: [...unknown] }, null, 2));
    await browser.close(); server.stop(true);
}
console.log(JSON.stringify({ checks: checks.length, errors, unknown: [...unknown], output }));
