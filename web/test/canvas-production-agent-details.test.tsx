import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasProductionAgentDetails } from "../src/pages/canvas/canvas-production-agent-details";
import type { useProductionAgentRuns } from "../src/pages/canvas/use-production-agent-runs";
import { createCanvasNode } from "../src/lib/canvas/canvas-project-domain";
import { ProductionPlanPhase, productionPlanPhaseLabels } from "../src/lib/production-plan";
import type { AgentRun } from "../src/services/api/agent";
import { CanvasNodeType } from "../src/types/canvas";

function renderDetails(production: Partial<NonNullable<AgentRun["production"]>> = {}, status: AgentRun["status"] = "running", generationWarning = "") {
    const node = createCanvasNode(CanvasNodeType.Text, { x: 0, y: 0 }, {
        generationWarning: generationWarning ? { severity: "warning", errorSource: "content", message: generationWarning } : undefined,
        shortDrama: { stage: "story", step: "story.plan", pipelineId: "pipeline", role: "document", assetKey: "$summary", sourceNodeIds: [], sourceSignatures: {}, version: 1, productionAgent: { runId: "run" } },
    });
    const run: AgentRun = {
        id: "run", canvasId: "canvas", status, permissionMode: "auto", createdAt: "2026-10-16T00:00:00Z", updatedAt: "2026-10-16T00:00:00Z",
        production: { targetNodeId: node.id, workKind: "plan", paused: false, waitingForBoundary: false, processedPages: 2, totalPages: 12, artifactCount: 99, validated: false, ...(status === "failed" ? { plansStarted: true } : {}), ...production },
    };
    const state: ReturnType<typeof useProductionAgentRuns> = {
        runs: [run], nodeErrors: {}, readErrors: {}, syncError: "", busy: {}, control: async () => {}, refresh: () => {},
    };
    return renderToStaticMarkup(<CanvasProductionAgentDetails node={node} state={state} />);
}

test("parallel plan progress separates public documents, assets and in-flight names", () => {
    const html = renderDetails({ documentTotal: 5, documentCount: 4, assetTotal: 50, assetCount: 18, inventoryComplete: true, concurrencyLimit: 3, concurrentItems: ["主角", "渡口", "相机"] });
    expect(html).toContain("方案文档 4/5 · 资产 18/50");
    expect(html).toContain("主角、渡口、相机");
    expect(html).not.toContain("2/12");
    expect(renderDetails({ documentTotal: 5, assetTotal: 50, inventoryComplete: false })).not.toContain("/50");
});

test("missing current Agent concurrency renders an explicit unknown denominator", () => {
    const html = renderDetails({ concurrentItems: ["主角"] });
    expect(html).toContain("1/--");
    expect(html).not.toContain("undefined");
});

test("plan progress hides provisional totals until inventory is explicitly complete", () => {
    for (const phase of [ProductionPlanPhase.Input, ProductionPlanPhase.Story, ProductionPlanPhase.Inventory]) {
        for (const inventoryComplete of [false, undefined]) {
            const html = renderDetails({ phase, inventoryComplete });
            expect(html).toContain(`已保存 2 份 · ${productionPlanPhaseLabels[phase]}`);
            expect(html).not.toContain("2/12");
            expect(html.replace(/<[^>]*>/g, "")).not.toContain("99");
        }
    }
    expect(renderDetails({ phase: ProductionPlanPhase.Assets, inventoryComplete: false })).not.toContain("2/12");
    expect(renderDetails({ inventoryComplete: true, totalPages: 0 })).toContain("已保存 2 份 · 制作方案");
});

test("every plan phase has a centralized label and known totals appear after inventory", () => {
    expect(Object.values(ProductionPlanPhase)).toEqual(["input", "story", "inventory", "standards", "generation", "assets", "validation"]);
    for (const phase of Object.values(ProductionPlanPhase)) {
        expect(productionPlanPhaseLabels[phase]).toBeTruthy();
        expect(renderDetails({ phase, inventoryComplete: true })).toContain(`已保存 2/12 份 · ${productionPlanPhaseLabels[phase]}`);
    }
});

test("backend phase labels take precedence and the optional current item is escaped", () => {
    const html = renderDetails({ phase: ProductionPlanPhase.Assets, phaseLabel: " 正在完善资产 ", currentItem: " CHR-0001 <主角> ", inventoryComplete: true });
    expect(html).toContain("已保存 2/12 份 · 正在完善资产 · CHR-0001 &lt;主角&gt;");
    expect(html).not.toContain(productionPlanPhaseLabels[ProductionPlanPhase.Assets]);
    expect(renderDetails({ phase: ProductionPlanPhase.Validation, phaseLabel: " ", currentItem: " " })).toContain("已保存 2 份 · 完整性校验</div>");
    expect(renderDetails()).toContain("已保存 2 份 · 制作方案</div>");
});

test("identical phase and current item render once while zero saved remains explicit", () => {
    const html = renderDetails({ processedPages: 0, phase: ProductionPlanPhase.Story, phaseLabel: " 故事总纲与世界规则 ", currentItem: " 故事总纲与世界规则 " });
    expect(html).toContain("已保存 0 份 · 故事总纲与世界规则</div>");
    expect(html.match(/故事总纲与世界规则/g)).toHaveLength(1);
    const fallback = renderDetails({ phase: ProductionPlanPhase.Story, currentItem: productionPlanPhaseLabels[ProductionPlanPhase.Story] });
    expect(fallback.match(new RegExp(productionPlanPhaseLabels[ProductionPlanPhase.Story], "g"))).toHaveLength(1);
    const distinct = renderDetails({ phaseLabel: "故事总纲", currentItem: "故事总纲与世界规则" });
    expect(distinct).toContain("故事总纲 · 故事总纲与世界规则</div>");
});

test("phase progress preserves task statuses and controls", () => {
    const paused = renderDetails({ phase: ProductionPlanPhase.Assets, paused: true, inventoryComplete: true });
    expect(paused).toContain("已暂停");
    expect(paused).toContain("继续任务");
    expect(paused).toContain("取消任务");
    expect(paused).toContain("已保存 2/12 份 · 逐项资产档案");
    const failed = renderDetails({ phase: ProductionPlanPhase.Generation }, "failed");
    expect(failed).toContain("待恢复");
    expect(failed).toContain("继续任务");
    const completed = renderDetails({ phase: ProductionPlanPhase.Validation, inventoryComplete: true, processedPages: 12, validated: true, assetsStarted: true }, "completed");
    expect(completed).toContain("所选资产已完成 · 可继续选择");
    expect(completed).toContain("已保存 12/12 份 · 完整性校验");
    expect(completed).not.toContain("继续任务");
});

test("completed but incomplete plan documents expose a continuation action", () => {
    const html = renderDetails({ documentCount: 1, documentTotal: 5, assetsStarted: false, plansStarted: true }, "completed");
    expect(html).toContain("方案文档未完成 · 可继续");
    expect(html).toContain("继续任务");
});

test("storyboard and extraction progress retain their existing counts", () => {
    expect(renderDetails({ workKind: "storyboard", phaseLabel: "不应显示", currentItem: "不应显示" })).toContain("已完成 2/12 场 · 详情 99/99 镜头");
    const extraction = renderDetails({ workKind: undefined, phaseLabel: "不应显示" });
    expect(extraction).toContain("已解析 2/12 集正文 · 已产出 99 项");
    expect(extraction).not.toContain("不应显示");
});

test("completed plan details keep manual asset generation out of the task log", () => {
    const html = renderDetails({ workKind: "plan", planReady: true, assetsStarted: false, validated: true, assetTotal: 8 }, "completed");
    expect(html).toContain("方案已完成 · 资产待手动生成");
    expect(html).not.toContain("选择资产生成");
    expect(html).not.toContain("资产清单");
    expect(html).not.toContain("继续任务");
    expect(renderDetails({ assetsStarted: true }, "running")).not.toContain(">生成资产<");
});

test("stopped asset batch does not present its retained retry checkpoints as active work", () => {
    const html = renderDetails({ plansStarted: true, assetsStarted: true, assetCount: 8, assetTotal: 44, concurrentItems: ["待重试场景"], concurrencyLimit: 10, parallelItems: [{ key: "scene", name: "待重试场景", status: "retrying" }] }, "failed");
    expect(html).toContain("方案已完成 · 资产执行未完成");
    expect(html).toContain("资产执行已停止，方案文稿仍然完成；已保存 8/44 项");
    expect(html).toContain("重试上次范围（44项）");
    expect(html).not.toContain("并行制作");
    expect(html).not.toContain("纠正重试中");
});

test("waiting user state does not surface internal validation metadata as a task warning", () => {
    const html = renderDetails({}, "waiting_user", "模型重复读取或说明且制作进度未变化");
    expect(html).not.toContain("模型重复读取或说明且制作进度未变化");
    expect(html).not.toContain("production-agent-warning");
});

test("waiting user checkpoints keep a visible resume control", () => {
    const html = renderDetails({ paused: true, phase: ProductionPlanPhase.Validation }, "waiting_user");
    expect(html).toContain("已暂停");
    expect(html).toContain("继续任务");
});
