import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { probeMediaDurationMs, probeMediaUrlDurationMs } from "../src/lib/media-metadata";

let originalDocument: PropertyDescriptor | undefined;
let originalWindow: PropertyDescriptor | undefined;
let element: {
    duration: number;
    src: string;
    muted: boolean;
    preload: string;
    onloadedmetadata: (() => void) | null;
    onerror: (() => void) | null;
    removeAttribute: (name: string) => void;
    load: () => void;
};
let releases = 0;
let loads = 0;

beforeEach(() => {
    originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    releases = 0; loads = 0;
    element = { duration: 4.25, src: "", muted: false, preload: "", onloadedmetadata: null, onerror: null,
        removeAttribute: (name) => { if (name === "src") { releases += 1; element.src = ""; } }, load: () => { loads += 1; } };
    Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => element } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout, clearTimeout } });
});

afterEach(() => {
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
});

test("remote metadata reads real duration and releases the temporary player", async () => {
    const pending = probeMediaUrlDurationMs("https://example.invalid/video", "video");
    element.onloadedmetadata?.();
    expect(await pending).toBe(4250);
    expect(releases).toBe(1);
    expect(loads).toBe(1);
    expect(element.onloadedmetadata).toBeNull();
    expect(element.onerror).toBeNull();
});

test("leaving the panel aborts a metadata read and clears callbacks", async () => {
    const controller = new AbortController();
    const pending = probeMediaUrlDurationMs("https://example.invalid/video", "video", controller.signal);
    controller.abort();
    expect(await pending).toBeUndefined();
    expect(releases).toBe(1);
    expect(element.onloadedmetadata).toBeNull();
    expect(element.onerror).toBeNull();
});

test("decode errors and infinite durations never invent a usable duration", async () => {
    const failed = probeMediaUrlDurationMs("https://example.invalid/audio", "audio");
    element.onerror?.();
    expect(await failed).toBeUndefined();
    element.duration = Infinity;
    const infinite = probeMediaUrlDurationMs("https://example.invalid/audio", "audio");
    element.onloadedmetadata?.();
    expect(await infinite).toBeUndefined();
});

test("uploaded file probes release their own object URL, including decode failure", async () => {
    const revoke = spyOn(URL, "revokeObjectURL");
    try {
        const pending = probeMediaDurationMs(new File(["fixture"], "clip.mp4", { type: "video/mp4" }));
        const url = element.src;
        element.onerror?.();
        expect(await pending).toBeUndefined();
        expect(revoke).toHaveBeenCalledWith(url);
        expect(revoke).toHaveBeenCalledTimes(1);
    } finally {
        revoke.mockRestore();
    }
});
