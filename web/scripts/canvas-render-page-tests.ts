/** Trusted title edits on the actual production page; isolated synthetic API only. */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const origin = process.env.CANVAS_TEST_ORIGIN || "http://127.0.0.1:4013";
const baseline = process.argv.includes("--baseline");
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error("Only an isolated loopback fixture is allowed");
const session = await (await fetch(`${origin}/api/auth/session`)).json();
if (session.data?.user?.id !== "canvas-benchmark") throw new Error("Refusing to edit a non-fixture canvas");
const path = "/api/canvas-projects/benchmark-100-spread";
const read = async () => (await (await fetch(origin + path)).json()).data.project;
const initial = await read();
const save = async (project: any) => {
    const response = await fetch(origin + path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project }) });
    if (!response.ok) throw new Error(`Fixture write failed: ${response.status}`);
};
const output = resolve(process.env.CANVAS_TEST_REPORT_DIR || `../.local/canvas-benchmark/render-${baseline ? "baseline" : "current"}`);
mkdirSync(output, { recursive: true });
const nodes: CanvasNodeData[] = [
    CanvasNodeType.Text, CanvasNodeType.Text, CanvasNodeType.Markdown, CanvasNodeType.Markdown,
    CanvasNodeType.Config, CanvasNodeType.BatchTable, CanvasNodeType.Script, CanvasNodeType.Frame,
].map((type, index) => ({ id: `render-${index}`, type, title: `Render fixture ${index}`, position: { x: (index % 4) * 660, y: Math.floor(index / 4) * 640 },
    width: 620, height: 540, metadata: type === CanvasNodeType.Text ? { content: `Synthetic content ${index}` } : {} }));
nodes.push({ id: "frame-child", type: CanvasNodeType.Text, title: "Child", position: { x: 2050, y: 800 }, width: 400, height: 240, parentId: "render-7", metadata: { content: "Synthetic child" } });
const report: any = { baseline, fixtureVersion: 1, buildIndexSha256: createHash("sha256").update(await (await fetch(origin)).text()).digest("hex"), passed: [], errors: [], measurements: [] };
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
page.on("pageerror", (error: Error) => report.errors.push(error.message));
try {
    await save({ ...initial, nodes, connections: [{ id: "render-edge", fromNodeId: "render-0", toNodeId: "render-2" }], viewport: { x: 180, y: 200, k: 0.5 } });
    await page.goto(`${origin}/canvas/benchmark-100-spread?canvasDiagnostics=1`);
    await page.waitForFunction(() => Boolean(window.__canvasDiagnostics));
    await page.waitForSelector('[data-node-id="render-7"]');
    await page.waitForTimeout(1800);
    for (let iteration = 0; iteration < 2; iteration++) {
        const target = page.locator('[data-node-id="render-0"]');
        await target.getByRole("button", { name: /^编辑节点名称：/ }).click();
        const input = target.getByRole("textbox", { name: "节点名称" });
        await input.fill(`Renamed ${iteration}`);
        await page.waitForTimeout(350);
        await page.evaluate((ids: string[]) => { window.__canvasDiagnostics!.watchNodeRenders(ids); window.__canvasDiagnostics!.reset(); }, nodes.map((node) => node.id));
        await input.press("Enter");
        await page.waitForTimeout(1200);
        const snapshot: any = await page.evaluate(() => window.__canvasDiagnostics!.snapshot());
        const counts = snapshot.renderAttempts;
        report.measurements.push({ iteration, renderAttempts: counts, computations: snapshot.computations });
        if (counts.watched[0].node === 0) throw new Error("Probe did not observe the edited node");
        if (!baseline) {
            if (snapshot.computations["spatial-index"].count || snapshot.computations["connection-spatial-index"].count) throw new Error("A content-only edit rebuilt a geometry index");
            for (const index of [1, 3, 4, 5, 6, 7, 8]) {
                if (Object.values(counts.watched[index]).some((count) => count !== 0)) throw new Error(`Unrelated node at slot ${index} rendered: ${JSON.stringify(counts.watched[index])}`);
            }
        }
        const deadline = Date.now() + 15000;
        while ((await read()).nodes.find((node: CanvasNodeData) => node.id === "render-0")?.title !== `Renamed ${iteration}`) {
            if (Date.now() > deadline) throw new Error("Title did not reach normal save API");
            await page.waitForTimeout(150);
        }
        report.passed.push(`Actual page title edit ${iteration}: measured rendering and persisted latest title`);
    }
    if (report.errors.length) throw new Error(report.errors.join("\n"));
    await page.screenshot({ path: join(output, "actual-page.png") });
    console.log(JSON.stringify(report, null, 2));
} catch (error) {
    report.failure = String(error); process.exitCode = 1; console.error(error);
    await page.screenshot({ path: join(output, "failure.png") }).catch(() => {});
} finally {
    await browser.close();
    await save({ ...initial, revision: (await read()).revision });
    writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
}
