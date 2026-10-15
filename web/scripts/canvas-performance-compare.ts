/** Compare matching isolated production runs; incomplete samples never pass a gate. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { canvasBenchmarkEnvironmentIssues, canvasBenchmarkHasThreeRepeats, canvasBenchmarkInputIssues } from "./canvas-benchmark-integrity";

const [baselinePath, currentPath, outputPath] = process.argv.slice(2);
if (!baselinePath || !currentPath || !outputPath) throw new Error("Usage: bun scripts/canvas-performance-compare.ts baseline.json current.json report.md");
const baseline = JSON.parse(readFileSync(resolve(baselinePath), "utf8"));
const current = JSON.parse(readFileSync(resolve(currentPath), "utf8"));
for (const [name, report] of [["baseline", baseline], ["current", current]] as const) {
    if (report.interactionProtocol !== 6 || !report.integritySha256) throw new Error(`${name}: acceptance requires protocol 6 with an input audit`);
    const issues = canvasBenchmarkEnvironmentIssues(report.environment);
    if (issues.length) throw new Error(`${name}: diagnostic-only environment: ${issues.join(", ")}`);
    if (report.unexpectedRequests?.length) throw new Error(`${name}: unexpected API requests invalidate acceptance`);
}
for (const [name, left, right] of [
    ["fixture", baseline.code.fixtureSha256, current.code.fixtureSha256],
    ["runner", baseline.code.runnerSha256, current.code.runnerSha256],
    ["input integrity", baseline.integritySha256, current.integritySha256],
    ["protocol", baseline.interactionProtocol, current.interactionProtocol],
    ["media version", baseline.mediaVersion, current.mediaVersion],
    ["media", baseline.code.mediaSha256, current.code.mediaSha256],
    ["Chrome", baseline.environment.chrome, current.environment.chrome],
    ["headed mode", baseline.environment.headless, current.environment.headless],
    ["viewport", baseline.environment.viewport, current.environment.viewport],
    ["CPU", baseline.environment.cpu, current.environment.cpu],
    ["platform", baseline.environment.platform, current.environment.platform],
    ["OS", baseline.environment.release, current.environment.release],
    ["logical CPUs", baseline.environment.logicalCpus, current.environment.logicalCpus],
    ["memory", baseline.environment.memoryBytes, current.environment.memoryBytes],
    ["GPU", baseline.environment.gpu?.devices, current.environment.gpu?.devices],
    ["renderer", baseline.environment.gpu?.auxAttributes?.glRenderer, current.environment.gpu?.auxAttributes?.glRenderer],
    ["GPU features", baseline.environment.gpu?.featureStatus, current.environment.gpu?.featureStatus],
] as const) {
    if (JSON.stringify(left) !== JSON.stringify(right)) throw new Error(`Cannot compare mismatched ${name}`);
}
if (baseline.diagnosticCss !== undefined || current.diagnosticCss !== undefined || baseline.traceProbe || current.traceProbe || baseline.animations || current.animations) throw new Error("Diagnostic experiments/traces are not acceptance runs");
if (baseline.retainedMemoryProbe || current.retainedMemoryProbe) throw new Error("Forced-GC probes are diagnostic, not performance acceptance runs");
if (baseline.cpuProfileProbe || current.cpuProfileProbe) throw new Error("CPU profiles are diagnostic, not performance acceptance runs");
const median = (values: number[]) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
};
const metric = (rows: any[], read: (row: any) => number | undefined) => median(rows.map(read).filter((value): value is number => typeof value === "number" && Number.isFinite(value)));
const fmt = (value: number | null) => value === null ? "n/a" : value.toFixed(1);
const change = (previous: number | null, next: number | null) => previous && next !== null ? (next / previous - 1) * 100 : null;
const lines = [
    "# Canvas Performance Comparison", "",
    `Protocol: ${current.interactionProtocol}; fixture: ${current.fixtureVersion}; Chrome: ${current.environment.chrome}.`,
    `Baseline build: \`${baseline.code.indexSha256}\`.`,
    `Current build: \`${current.code.indexSha256}\`.`, "",
    `Empty-page frame cadence P50/P95 (baseline / current ms): ${fmt(baseline.environment.emptyPageCadence.p50 ?? null)}/${fmt(baseline.environment.emptyPageCadence.p95 ?? null)} / ${fmt(current.environment.emptyPageCadence.p50 ?? null)}/${fmt(current.environment.emptyPageCadence.p95 ?? null)}. Device cadence is reported separately and never relaxes the gates.`, "",
    "Each cell is the median of three run-level measurements, not a pooled percentile. Gates require all three current runs. Timed-out/incomplete runs are not replaced with successes.", "",
    "| Nodes | View | Cache | Valid runs B/C | Frame P95 B/C ms | Pan feedback P95 B/C ms | Frame / pan gates | Ready B/C ms | Ready change | JS heap B/C MB | Heap change |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
];
let regressions = 0;
let incomplete = 0;
for (const size of [100, 500, 2000]) for (const view of ["spread", "overview"]) for (const cache of ["cold", "warm"]) {
    const select = (report: any) => report.measurements.filter((row: any) => row.size === size && row.view === view && row.cache === cache && !row.timedOut && row.panFeedback?.count === 12 && !row.panFeedback.failed && row.missingVisible === 0 && row.geometry?.maximumError <= 0.75 && row.errors?.length === 0 && row.visible === "visible" && row.inputAudit && canvasBenchmarkInputIssues(row.inputAudit).length === 0
        && [row.readyMs, row.metrics?.JSHeapUsedSize, row.interaction?.frameMs?.p95, row.panFeedback?.p95].every((value) => typeof value === "number" && Number.isFinite(value) && value > 0));
    const before = select(baseline);
    const after = select(current);
    const complete = canvasBenchmarkHasThreeRepeats(before) && canvasBenchmarkHasThreeRepeats(after);
    if (!complete) incomplete++;
    const readyBefore = metric(before, (row) => row.readyMs);
    const readyAfter = metric(after, (row) => row.readyMs);
    const heapBefore = metric(before, (row) => row.metrics.JSHeapUsedSize / 1024 ** 2);
    const heapAfter = metric(after, (row) => row.metrics.JSHeapUsedSize / 1024 ** 2);
    const readyChange = complete ? change(readyBefore, readyAfter) : null;
    const heapChange = complete ? change(heapBefore, heapAfter) : null;
    if ((readyChange ?? 0) > 10 || (heapChange ?? 0) > 10) regressions++;
    const gate = (read: (row: any) => number | null, threshold: number) => !canvasBenchmarkHasThreeRepeats(after) ? "incomplete" : after.every((row: any) => read(row) !== null && read(row)! <= threshold) ? "pass" : "FAIL";
    const gates = view === "spread" && size !== 100 ? `${gate((row) => row.interaction.frameMs.p95, size === 500 ? 33 : 50)} / ${gate((row) => row.panFeedback.p95, size === 500 ? 100 : 200)}` : "reported separately";
    lines.push(`| ${size} | ${view} | ${cache} | ${before.length}/3; ${after.length}/3 | ${fmt(metric(before, (row) => row.interaction.frameMs.p95))} / ${fmt(metric(after, (row) => row.interaction.frameMs.p95))} | ${fmt(metric(before, (row) => row.panFeedback.p95))} / ${fmt(metric(after, (row) => row.panFeedback.p95))} | ${gates} | ${fmt(readyBefore)} / ${fmt(readyAfter)} | ${fmt(readyChange)}% | ${fmt(heapBefore)} / ${fmt(heapAfter)} | ${fmt(heapChange)}% |`);
}
lines.push("", `Incomplete comparison groups: ${incomplete}. Groups with >10% readiness/heap growth: ${regressions}.`, "",
    "Readiness is first node mount; raw reports also include mediaReadyMs and pre-warmup frames. JS heap is not total Chrome/process memory; browser-wide memory and ten-cycle media recovery remain separate checks. Pan feedback observes the cumulative requested transform then crosses a paint opportunity; it does not certify drag, editing, Agent or save completion.",
    "Manual business regression and all remaining refactor requirements remain pending. Frame success cannot replace media, save or interaction correctness.", "");
writeFileSync(resolve(outputPath), lines.join("\n"));
console.log(lines.join("\n"));
