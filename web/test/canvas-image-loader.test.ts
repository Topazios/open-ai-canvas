import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { prepareCanvasImage, canvasImagePreparationStats } from "../src/services/canvas-image-loader";

const originalImage = globalThis.Image;
let images: TestImage[];
const controllers: AbortController[] = [];
class TestImage {
    src = "";
    decoding = "";
    complete = false;
    naturalWidth = 640;
    onload: ((event: Event) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    decodeCalls = 0;
    decodeResult: Promise<void> = Promise.resolve();
    constructor() { images.push(this); }
    decode() { this.decodeCalls++; return this.decodeResult; }
    removeAttribute() { this.src = ""; }
    load() { this.onload?.(new Event("load")); }
    fail() { this.onerror?.(new Event("error")); }
}
const controller = () => { const value = new AbortController(); controllers.push(value); return value; };
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => { images = []; globalThis.Image = TestImage as unknown as typeof Image; });
afterEach(async () => {
    controllers.splice(0).forEach((value) => value.abort());
    await tick();
    globalThis.Image = originalImage;
    expect(canvasImagePreparationStats()).toEqual({ active: 0, queued: 0, limit: 4, consumers: 0 });
});

describe("canvas image preparation lifetime", () => {
    test("shared source decodes once; cancelling one consumer does not interrupt another", async () => {
        const a = controller(), b = controller();
        const first = prepareCanvasImage("same", a.signal).catch((error) => error);
        const second = prepareCanvasImage("same", b.signal);
        expect(images).toHaveLength(1);
        a.abort();
        expect(images[0].src).toBe("same");
        images[0].load(); images[0].load();
        expect((await first).name).toBe("AbortError");
        expect(await second).toBe(images[0]);
        expect(images[0].decodeCalls).toBe(1);
        expect(images[0].onload).toBeNull();
        expect(images[0].onerror).toBeNull();
    });
    test("last consumer abort releases active network and ignores late decode", async () => {
        const a = controller();
        let finish!: () => void;
        const result = prepareCanvasImage("late", a.signal).catch((error) => error);
        images[0].decodeResult = new Promise((resolve) => { finish = resolve; });
        images[0].load(); a.abort(); finish();
        expect((await result).name).toBe("AbortError");
        expect(images[0].src).toBe("");
        await tick();
        expect(canvasImagePreparationStats().active).toBe(0);
    });
    test("queued cancellation never creates an Image and four-job budget is respected", async () => {
        const pending = Array.from({ length: 4 }, (_, i) => prepareCanvasImage(`active-${i}`, controller().signal).catch((error) => error));
        const queued = controller();
        const cancelled = prepareCanvasImage("queued", queued.signal).catch((error) => error);
        expect(canvasImagePreparationStats().queued).toBe(1);
        queued.abort();
        expect(images).toHaveLength(4);
        images.forEach((image) => image.load());
        await Promise.all(pending);
        expect((await cancelled).name).toBe("AbortError");
    });
    test("queued caller retains its own timeout after a slot opens", async () => {
        const pending = Array.from({ length: 4 }, (_, i) => prepareCanvasImage(`slot-${i}`, controller().signal).catch((error) => error));
        const timeout = prepareCanvasImage("short", controller().signal, 10).catch((error) => error);
        await tick(20);
        expect(images).toHaveLength(4);
        images[0].load();
        await tick(30);
        expect((await timeout).message).toContain("超时");
        expect(images[4].src).toBe("");
        images.slice(1, 4).forEach((image) => image.load());
        await Promise.all(pending);
    });
    test("consumer deadlines are independent for shared work", async () => {
        const short = prepareCanvasImage("deadlines", controller().signal, 10).catch((error) => error);
        const long = prepareCanvasImage("deadlines", controller().signal, 1000);
        await tick(30);
        expect((await short).message).toContain("超时");
        expect(images).toHaveLength(1);
        images[0].load();
        expect(await long).toBe(images[0]);
    });
    test("failed source can be retried without a poisoned in-flight entry", async () => {
        const first = prepareCanvasImage("retry", controller().signal).catch((error) => error);
        images[0].fail();
        expect((await first).message).toContain("失败");
        const retry = prepareCanvasImage("retry", controller().signal);
        expect(images).toHaveLength(2);
        images[1].load();
        expect(await retry).toBe(images[1]);
    });
    test("already aborted request consumes no slot", async () => {
        const a = controller(); a.abort();
        await expect(prepareCanvasImage("aborted", a.signal)).rejects.toHaveProperty("name", "AbortError");
        expect(images).toHaveLength(0);
    });
});
