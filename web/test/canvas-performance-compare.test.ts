import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function fixture(): any {
    const sent = Array.from({ length: 12 }, (_, i) => ({ deltaX: i < 6 ? 64 : -64, deltaY: i < 6 ? 32 : -32, clientX: 400, clientY: 200, target: "canvas" }));
    const audit = {
        sent, received: sent.map((event) => ({ ...event, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, timeStamp: 1 })), totalReceived: 12,
        foreground: { startVisible: true, startFocused: true, endVisible: true, endFocused: true, interruptions: 0 },
        initialCamera: { x: 1, y: 2, k: 0.6 }, finalCamera: { x: 1, y: 2, k: 0.6 },
    };
    return {
        interactionProtocol: 6, fixtureVersion: 2, mediaVersion: 2, integritySha256: "integrity",
        code: { fixtureSha256: "fixture", runnerSha256: "runner", mediaSha256: "media", indexSha256: "build" },
        environment: {
            headless: false, chrome: "test", cpu: "test", platform: "win32", release: "test", logicalCpus: 8, memoryBytes: 32e9,
            viewport: { width: 1440, height: 1000 },
            gpu: { devices: [{ deviceString: "physical device" }], auxAttributes: { glRenderer: "ANGLE Intel Iris Xe" }, featureStatus: { gpu_compositing: "enabled", rasterization: "enabled" } },
            emptyPageCadence: { count: 120, visible: true, focused: true },
        },
        unexpectedRequests: [],
        measurements: [100, 500, 2000].flatMap((size) => ["spread", "overview"].flatMap((view) => ["cold", "warm"].flatMap((cache) => [1, 2, 3].map((repeat) => ({
            size, view, cache, repeat, readyMs: 500, metrics: { JSHeapUsedSize: 40 * 1024 ** 2 },
            panFeedback: { count: 12, failed: 0, p95: 70 }, interaction: { frameMs: { p95: 30 } },
            missingVisible: 0, geometry: { maximumError: 0 }, errors: [], visible: "visible", inputAudit: structuredClone(audit),
        }))))),
    };
}

function compare(current: any, baseline = fixture()) {
    const directory = mkdtempSync(join(tmpdir(), "canvas-compare-test-"));
    try {
        const before = join(directory, "baseline.json"), after = join(directory, "current.json"), output = join(directory, "report.md");
        writeFileSync(before, JSON.stringify(baseline)); writeFileSync(after, JSON.stringify(current));
        const result = Bun.spawnSync([process.execPath, fileURLToPath(new URL("../scripts/canvas-performance-compare.ts", import.meta.url)), before, after, output]);
        return { code: result.exitCode, error: result.stderr.toString(), report: result.exitCode === 0 ? readFileSync(output, "utf8") : "" };
    } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("comparison reports matching complete runs and fails slow runs without changing thresholds", () => {
    const current = fixture();
    expect(compare(current).report).toContain("Incomplete comparison groups: 0");
    current.measurements.find((row: any) => row.size === 500 && row.view === "spread" && row.cache === "warm").interaction.frameMs.p95 = 34;
    expect(compare(current).report).toContain("FAIL / pass");
});

test("comparison refuses diagnostic flags and headless or software environments", () => {
    for (const patch of [{ cpuProfileProbe: true }, { retainedMemoryProbe: true }, { traceProbe: true }, { diagnosticCss: "" }]) {
        expect(compare({ ...fixture(), ...patch }).code).not.toBe(0);
    }
    for (const change of [
        (report: any) => { report.environment.headless = true; },
        (report: any) => { report.environment.gpu.auxAttributes.glRenderer = "ANGLE SwiftShader"; },
        (report: any) => { report.environment.gpu.featureStatus.rasterization = "disabled_software"; },
    ]) {
        const value = fixture(); change(value);
        const result = compare(value, value);
        expect(result.code).not.toBe(0);
        expect(result.error).toContain("diagnostic-only environment");
    }
});

test("comparison rejects mismatched protocol, hardware settings and unexpected requests", () => {
    for (const change of [
        (report: any) => { report.interactionProtocol = 5; },
        (report: any) => { report.integritySha256 = "changed"; },
        (report: any) => { report.environment.gpu.auxAttributes.glRenderer = "different physical renderer"; },
        (report: any) => { report.environment.release = "different OS"; },
        (report: any) => { report.unexpectedRequests = ["POST /tasks"]; },
    ]) {
        const value = fixture(); change(value);
        expect(compare(value).code).not.toBe(0);
    }
});

test("comparison recomputes input integrity instead of trusting stored inputIssues", () => {
    const current = fixture();
    const row = current.measurements.find((row: any) => row.size === 500 && row.view === "spread" && row.cache === "warm");
    row.inputIssues = [];
    row.inputAudit.received[0].ctrlKey = true;
    const result = compare(current);
    expect(result.code).toBe(0);
    expect(result.report).toContain("Incomplete comparison groups: 1");
    expect(result.report).toContain("incomplete / incomplete");
});

test("missing metrics or duplicate repeats cannot produce a complete comparison", () => {
    for (const change of [
        (row: any) => { row.repeat = 2; },
        (row: any) => { row.metrics = {}; },
        (row: any) => { row.interaction.frameMs.p95 = null; },
        (row: any) => { delete row.missingVisible; },
    ]) {
        const current = fixture();
        change(current.measurements.find((row: any) => row.size === 500 && row.view === "spread" && row.cache === "warm"));
        const result = compare(current);
        expect(result.code).toBe(0);
        expect(result.report).toContain("Incomplete comparison groups: 1");
        expect(result.report).toContain("incomplete / incomplete");
    }
});
