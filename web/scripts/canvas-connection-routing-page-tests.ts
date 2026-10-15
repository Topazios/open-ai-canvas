/** Real production canvas, isolated synthetic API, no external/model calls. */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const origin = "http://127.0.0.1:4014";
if ((await (await fetch(`${origin}/api/auth/session`)).json()).data?.user?.id !== "canvas-benchmark") throw new Error("Isolated fixture required");
const canvasId = "benchmark-100-spread";
const original = (await (await fetch(`${origin}/api/canvas-projects/${canvasId}`)).json()).data.project;
const output = resolve("../.local/canvas-benchmark/connection-midpoints-current");
mkdirSync(output, { recursive: true });
const report = { passed: [] as string[], errors: [] as string[] };
const check = (condition: boolean, label: string) => { if (!condition) throw new Error(label); report.passed.push(label); };
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
try {
    for (const theme of ["dark", "light"]) {
        const nodes: CanvasNodeData[] = [
            ["source", 0, 0], ["above", 0, -260], ["below", 30, 280], ["left", -360, 30], ["right", 360, 0], ["new-target", 360, 280],
        ].map(([id, x, y]) => ({ id: String(id), title: String(id), type: id === "right" ? CanvasNodeType.Frame : CanvasNodeType.Text, position: { x: Number(x), y: Number(y) }, width: 200, height: 130, metadata: { content: `正文 ${id}`, status: "success", frame: { collapsed: false } } }));
        let cloud = { ...original, projectId: "", nodes, connections: nodes.slice(1, 5).map((node) => ({ id: `edge-${node.id}`, fromNodeId: "source", toNodeId: node.id })), appearance: { mode: theme }, viewport: { x: 630, y: 365, k: 0.8 } };
        const context = await browser.newContext({ viewport: { width: 1440, height: 945 }, serviceWorkers: "block" });
        await context.addInitScript((theme: string) => { if (location.protocol === "http:") localStorage.setItem("infinite-canvas:canvas-theme", JSON.stringify({ state: { theme }, version: 0 })); }, theme);
        await context.route("**/*", async (route: any) => {
            const req = route.request(), url = new URL(req.url());
            if (url.origin !== origin) { report.errors.push("unexpected external call"); return route.abort(); }
            const reply = (data: any) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ code: 0, data, msg: "" }) });
            if (url.pathname === `/api/canvas-projects/${canvasId}`) {
                if (req.method() === "PUT") cloud = { ...req.postDataJSON().project, revision: cloud.revision + 1 };
                return reply({ project: cloud });
            }
            if (req.method() !== "GET" && url.pathname !== "/api/assets/batch") { report.errors.push(`unexpected write: ${url.pathname}`); return route.abort(); }
            return route.continue();
        });
        const page = await context.newPage(); page.setDefaultTimeout(15000);
        page.on("pageerror", (error: Error) => report.errors.push(error.message));
        const underlay = page.locator("[data-canvas-leafer-underlay]");
        const digest = () => underlay.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
            const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
            let hash = 2166136261, nonblank = 0;
            for (let i = 0; i < pixels.length; i += 4) { if (pixels[i + 3]) nonblank++; hash = Math.imul(hash ^ pixels[i] ^ (pixels[i + 1] << 8) ^ (pixels[i + 3] << 16), 16777619); }
            return { hash, nonblank };
        });
        const edgePixels = () => underlay.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
            const path = document.querySelector('[data-connection-id="edge-above"]') as SVGPathElement;
            const box = path.getBoundingClientRect(), origin = canvas.getBoundingClientRect();
            const scale = canvas.width / origin.width;
            const pixels = canvas.getContext("2d")!.getImageData(Math.max(0, Math.floor((box.x - origin.x - 5) * scale)), Math.max(0, Math.floor((box.y - origin.y - 5) * scale)), Math.ceil((box.width + 10) * scale), Math.ceil((box.height + 10) * scale)).data;
            return Array.from(pixels);
        });
        try {
            await page.goto(`${origin}/canvas/${canvasId}`);
            await page.locator('[data-connection-id="edge-above"]').waitFor({ state: "attached" }); await page.waitForTimeout(800);
            for (const target of nodes.slice(1, 5)) {
                const values = (await page.locator(`[data-connection-id="edge-${target.id}"]`).getAttribute("d")).match(/-?\d+(?:\.\d+)?/g).map(Number);
                const [sx, sy] = values, [ex, ey] = values.slice(-2);
                const isMidpoint = (node: CanvasNodeData, x: number, y: number) => {
                    const localX = x - node.position.x, localY = y - node.position.y;
                    return (localX === node.width / 2 && (localY === 0 || localY === node.height)) || (localY === node.height / 2 && (localX === 0 || localX === node.width));
                };
                check(isMidpoint(nodes[0], sx, sy) && isMidpoint(target, ex, ey), `${theme}: ${target.id} uses fixed edge midpoints`);
                const [, , c1x, c1y, c2x, c2y] = values;
                check(Math.abs((c1x - sx) * (ey - sy) - (c1y - sy) * (ex - sx)) + Math.abs((c2x - sx) * (ey - sy) - (c2y - sy) * (ex - sx)) > 0.1, `${theme}: ${target.id} is visibly curved`);
            }
            const a = await digest(); await page.waitForTimeout(350); const b = await digest();
            check(a.nonblank > 100 && a.hash !== b.hash, `${theme}: rendered canvas pixels show moving flow`);
            const edgePoint = await page.locator('[data-connection-id="edge-above"]').evaluate((path: SVGPathElement) => {
                const point = path.getPointAtLength(path.getTotalLength()/2).matrixTransform(path.getScreenCTM()!); return {x:point.x,y:point.y};
            });
            await page.mouse.click(edgePoint.x, edgePoint.y); await page.mouse.move(1250, 750); await page.waitForTimeout(250);
            const selected = await edgePixels(); await page.waitForTimeout(400); const moving = await edgePixels();
            check(selected.filter((value: number, index: number) => index % 4 === 3 && Math.abs(value-moving[index]) > 45).length > 20, `${theme}: selected connection has high-contrast moving pixels`);
            await page.screenshot({ path: join(output, `${theme}-selected-flow.png`) });
            for (let zoom = 0; zoom < 3; zoom++) await page.getByRole('button', { name: '缩小画布', exact: true }).click();
            await page.waitForTimeout(400);
            const zoomed = await edgePixels(); await page.waitForTimeout(400); const zoomedNext = await edgePixels();
            check(zoomed.filter((value: number, index: number) => index % 4 === 3 && Math.abs(value-zoomedNext[index]) > 45).length > 10, `${theme}: overview keeps visible moving segments`);
            for (let zoom = 0; zoom < 3; zoom++) await page.getByRole('button', { name: '放大画布', exact: true }).click();
            await page.mouse.click(1250,750); await page.waitForTimeout(300);
            await page.emulateMedia({ reducedMotion: "reduce" }); await page.waitForTimeout(200);
            const still = await digest(); await page.waitForTimeout(300);
            check(still.hash === (await digest()).hash && await underlay.getAttribute("data-connection-flow") === "paused", `${theme}: reduced motion freezes flow without hiding connections`);
            await page.emulateMedia({ reducedMotion: "no-preference" }); await page.waitForTimeout(200);
            const source = page.locator('[data-node-id="source"]'); await source.hover();
            const rail = await source.locator('[data-canvas-connection-rail="right"]').boundingBox();
            const target = await page.locator('[data-node-id="new-target"]').boundingBox();
            await page.mouse.move(rail.x + rail.width / 2, rail.y + rail.height / 2); await page.mouse.down();
            await page.mouse.move(target.x + target.width / 2, target.y - 3, { steps: 12 }); await page.waitForTimeout(150); await page.mouse.up();
            await page.waitForFunction(() => document.querySelectorAll("[data-connection-id]").length === 5);
            check(await page.locator("[data-connection-id]").count() === 5, `${theme}: drag connects at the top midpoint`);
            const right = page.locator('[data-node-id="right"]');
            const beforePath = await page.locator('[data-connection-id="edge-right"]').getAttribute("d");
            const rightBox = await right.boundingBox();
            await page.mouse.move(rightBox.x + 80, rightBox.y + 14); await page.mouse.down();
            await page.mouse.move(rightBox.x + 145, rightBox.y + 14, { steps: 10 });
            await page.waitForTimeout(300);
            check(await page.locator('[data-canvas-leafer-overlay]').getAttribute('data-alignment-guides') === 'visible', `${theme}: aligned frame shows local alignment cues during drag`);
            check(await page.locator('[data-canvas-leafer-overlay] canvas').evaluate((canvas: HTMLCanvasElement) => {
                const ctx = canvas.getContext('2d')!;
                const scale = canvas.width / canvas.clientWidth;
                const pixels = ctx.getImageData(Math.round(180 * scale), Math.round(363 * scale), Math.round(100 * scale), Math.round(4 * scale)).data;
                return !pixels.some((value, index) => index % 4 === 3 && value > 0);
            }), `${theme}: alignment no longer draws a line across the empty canvas`);
            await page.screenshot({ path: join(output, `${theme}-frame-dragging.png`) });
            await page.mouse.up();
            await page.waitForTimeout(600);
            check(await page.locator('[data-canvas-leafer-overlay]').getAttribute('data-alignment-guides') === 'hidden', `${theme}: drop immediately clears alignment cues`);
            await page.screenshot({ path: join(output, `${theme}-frame-dropped.png`) });
            check(await page.locator('[data-connection-id="edge-right"]').getAttribute("d") !== beforePath, `${theme}: committed node drag recomputes border geometry`);
            const committedPath = await page.locator('[data-connection-id="edge-right"]').getAttribute("d");
            for (const cancel of ['escape', 'blur']) {
                const box = await right.boundingBox();
                await page.mouse.move(box.x + 80, box.y + 14); await page.mouse.down();
                await page.mouse.move(box.x + 125, box.y + 14, { steps: 8 }); await page.waitForTimeout(150);
                if (cancel === 'escape') await page.keyboard.press('Escape');
                else await page.evaluate(() => window.dispatchEvent(new Event('blur')));
                await page.mouse.up(); await page.waitForTimeout(200);
                check(await page.locator('[data-canvas-leafer-overlay]').getAttribute('data-alignment-guides') === 'hidden', `${theme}: ${cancel} clears alignment cues`);
                check(await page.locator('[data-connection-id="edge-right"]').getAttribute('d') === committedPath, `${theme}: ${cancel} restores committed curve`);
            }
            const midpoint = await page.locator('[data-connection-id="edge-above"]').evaluate((path: SVGPathElement) => {
                const point = path.getPointAtLength(path.getTotalLength() / 2).matrixTransform(path.getScreenCTM()!); return { x: point.x, y: point.y };
            });
            await page.mouse.click(midpoint.x, midpoint.y); await page.keyboard.press("Delete"); await page.waitForTimeout(250);
            check(await page.locator('[data-connection-id="edge-above"]').count() === 0, `${theme}: shortest line remains selectable and deletable`);
            await page.keyboard.press("Control+z"); await page.waitForTimeout(250);
            check(await page.locator('[data-connection-id="edge-above"]').count() === 1, `${theme}: undo restores connection with the same geometry`);
            await page.screenshot({ path: join(output, `${theme}-connections.png`), animations: "disabled" });
            await page.setViewportSize({ width: 390, height: 700 }); await page.waitForTimeout(300);
            check(await underlay.evaluate((el: HTMLElement) => el.clientWidth <= innerWidth && el.clientHeight <= innerHeight), `${theme}: renderer respects narrow viewport`);
            await page.screenshot({ path: join(output, `${theme}-narrow.png`), animations: "disabled" });
        } catch (error) { await page.screenshot({ path: join(output, `${theme}-failure.png`) }); throw error; }
        finally { await context.close(); }
    }
    check(report.errors.length === 0, "no uncaught errors, external calls or unexpected writes");
} catch (error) { report.errors.push(String(error)); process.exitCode = 1; }
finally { await browser.close(); writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }
