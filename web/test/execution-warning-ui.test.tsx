import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasExecutionJournal } from "../src/pages/canvas/canvas-execution-journal";
import { LogDetail } from "../src/pages/admin/components/api-log-detail-drawer";
import type { ApiCallLog } from "../src/services/api/auth";
import { CanvasPlanAssetSelector } from "../src/pages/canvas/canvas-plan-asset-selector";
import type { AgentRun } from "../src/services/api/agent";
import { productionParallelSummary } from "../src/lib/canvas/production-agent-journal";

test("real journal renders warnings with an alert icon instead of a success check", () => {
    const html = renderToStaticMarkup(<CanvasExecutionJournal rows={[{ id: 1, kind: "model", title: "内容待处理", detail: "尚未保存", time: "2026-10-25T00:00:00Z", failed: false, warning: true }]} order="asc" onOrder={() => {}} />);
    expect(html).toContain("production-agent-warning");
    expect(html).toContain('aria-label="警告"');
    expect(html).toContain("triangle-alert");
    expect(html).not.toContain("lucide-check");
    expect(html).not.toContain("production-agent-error");
});

test("real admin detail shares warning status and labels diagnostics as information", () => {
    const log = { id: "log", status: "warning", providerStatus: "incomplete", statusCode: 200, errorCode: "output_limit_exceeded", error: "输出内容未完整", inputTokens: 1, outputTokens: 1, cachedTokens: 0, usageAvailable: true, durationMs: 10, startedAt: "2026-10-25T00:00:00Z" } as ApiCallLog;
    const html = renderToStaticMarkup(<LogDetail log={log} querying={false} onQueryProviderTask={() => {}} />);
    expect(html).toContain("警告");
    expect(html).toContain("is-warning");
    expect(html).toContain("提示信息");
    expect(html).toContain("output_limit_exceeded");
    expect(html).not.toContain("text-red");
    expect(html).not.toContain("错误信息");
});

test("asset selector and parallel summary preserve unfinished warning work and block dependent assets", () => {
    const run = { id: "run", status: "failed", production: { targetNodeId: "plan", workKind: "plan", planReady: true, assetsStarted: true,
        parallelItems: [{ key: "a", name: "待补文稿", status: "error", severity: "warning" }],
        assets: [{ key: "a", code: "CHR-1", kind: "character", name: "未保存资产", status: "failed", severity: "warning", error: "尚未保存完整", missingDependencies: [] }, { key: "b", code: "AUD-1", kind: "sound", name: "依赖资产", status: "blocked", missingDependencies: ["a"] }] } } as AgentRun;
    const html = renderToStaticMarkup(<CanvasPlanAssetSelector run={run} state={{ runs: [run], busy: {}, nodeErrors: {}, readErrors: {}, syncError: "", control: async () => {}, refresh: () => {} }} />);
    expect(html).toContain("待处理");
    expect(html).toContain("尚未保存完整");
    expect(html).toContain("前置：");
    expect(html).toContain("选择前置项");
    expect(html).not.toContain("ant-tag-error");
    expect(productionParallelSummary(run.production)).toContain("待补文稿（待处理）");
});
