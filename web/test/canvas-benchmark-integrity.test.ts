import { expect, test } from "bun:test";
import { canvasBenchmarkEnvironmentIssues, canvasBenchmarkHasThreeRepeats, canvasBenchmarkInputIssues, type BenchmarkAcceptanceEnvironment, type BenchmarkInputAudit } from "../scripts/canvas-benchmark-integrity";

const fixture = (): BenchmarkInputAudit => {
    const sent = Array.from({ length: 12 }, (_, i) => ({ deltaX: i < 6 ? 64 : -64, deltaY: i < 6 ? 32 : -32, clientX: 400, clientY: 200, target: "canvas" as const }));
    return {
        sent,
        received: sent.map((event, i) => ({ ...event, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, timeStamp: i * 80, target: "canvas" })),
        totalReceived: 12,
        foreground: { startVisible: true, startFocused: true, endVisible: true, endFocused: true, interruptions: 0 },
        initialCamera: { x: 60, y: 80, k: 0.6 }, finalCamera: { x: 60, y: 80, k: 0.6 },
    };
};

test("accepts the full trusted-input trace with subpixel camera rounding", () => {
    const audit = fixture();
    audit.finalCamera.x += 0.001;
    expect(canvasBenchmarkInputIssues(audit)).toEqual([]);
});

test("rejects additional, missing or truncated input rather than discarding it", () => {
    for (const change of [
        (audit: BenchmarkInputAudit) => { audit.totalReceived++; audit.received.push(audit.received[0]); },
        (audit: BenchmarkInputAudit) => { audit.totalReceived--; audit.received.pop(); },
        (audit: BenchmarkInputAudit) => { audit.received.pop(); },
        (audit: BenchmarkInputAudit) => { audit.sent.pop(); },
    ]) {
        const audit = fixture(); change(audit);
        expect(canvasBenchmarkInputIssues(audit)).toContain("wheel-count");
    }
});

test("accepts an explicitly chosen frame pan target but rejects changed hit targets", () => {
    const audit = fixture();
    audit.sent[0].target = "frame";
    expect(canvasBenchmarkInputIssues(audit)).toContain("wheel-sequence");
    audit.received[0].target = "frame";
    expect(canvasBenchmarkInputIssues(audit)).toEqual([]);
});

test("rejects a changed delta, modifiers, input unit, target or position", () => {
    for (const patch of [{ deltaX: 65 }, { deltaY: 100 }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { deltaMode: 1 }, { target: "node" as const }, { target: "overlay" as const }, { clientX: 404 }, { clientY: 202 }]) {
        const audit = fixture(); Object.assign(audit.received[0], patch);
        expect(canvasBenchmarkInputIssues(audit)).toContain("wheel-sequence");
    }
});

test("a foreground interruption cannot be hidden by restoring focus at the end", () => {
    for (const patch of [{ startVisible: false }, { startFocused: false }, { endVisible: false }, { endFocused: false }, { interruptions: 1 }]) {
        const audit = fixture(); Object.assign(audit.foreground, patch);
        expect(canvasBenchmarkInputIssues(audit)).toContain("foreground-interrupted");
    }
});

test("rejects zoom, wrong pan result and non-finite camera values", () => {
    for (const patch of [{ k: 0.208 }, { x: 70 }, { y: 81 }, { x: NaN }, { k: Infinity }]) {
        const audit = fixture(); Object.assign(audit.finalCamera, patch);
        expect(canvasBenchmarkInputIssues(audit)).toContain("camera-not-restored");
    }
});

const environment = (): BenchmarkAcceptanceEnvironment => ({
    headless: false,
    gpu: { auxAttributes: { glRenderer: "ANGLE (Intel, Intel Iris Xe Direct3D11)" }, featureStatus: { gpu_compositing: "enabled", rasterization: "enabled_on" } },
    emptyPageCadence: { count: 120, visible: true, focused: true },
});

test("acceptance requires headed hardware rendering and foreground cadence evidence", () => {
    expect(canvasBenchmarkEnvironmentIssues(environment())).toEqual([]);
    for (const patch of [{ headless: true }, { headless: undefined }, { gpu: undefined }, { emptyPageCadence: undefined }]) {
        expect(canvasBenchmarkEnvironmentIssues({ ...environment(), ...patch }).length).toBeGreaterThan(0);
    }
    for (const patch of [{ count: 119 }, { visible: false }, { focused: false }]) {
        const value = environment(); Object.assign(value.emptyPageCadence!, patch);
        expect(canvasBenchmarkEnvironmentIssues(value)).toContain("foreground-cadence-required");
    }
});

test("actual software renderer and disabled hardware features cannot pass", () => {
    for (const renderer of ["ANGLE SwiftShader", "llvmpipe", "softpipe", "Microsoft Basic Render Driver", "WARP", "Software Rasterizer", ""]) {
        const value = environment(); value.gpu!.auxAttributes!.glRenderer = renderer;
        expect(canvasBenchmarkEnvironmentIssues(value)).toContain("hardware-renderer-required");
    }
    for (const feature of ["gpu_compositing", "rasterization"]) for (const status of ["disabled_off", "unavailable_software", "disabled_software", ""]) {
        const value = environment(); value.gpu!.featureStatus![feature] = status;
        expect(canvasBenchmarkEnvironmentIssues(value)).toContain(`${feature}-not-enabled`);
    }
});

test("three copies of one measurement are not three independent runs", () => {
    expect(canvasBenchmarkHasThreeRepeats([{ repeat: 3 }, { repeat: 1 }, { repeat: 2 }])).toBe(true);
    for (const repeats of [[1], [1, 2], [1, 1, 1], [1, 2, 2], [0, 1, 2], [1, 2, 3, 4]]) {
        expect(canvasBenchmarkHasThreeRepeats(repeats.map((repeat) => ({ repeat })))).toBe(false);
    }
});
