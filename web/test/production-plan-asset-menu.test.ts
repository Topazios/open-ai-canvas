import { expect, test } from "bun:test";
import { productionPlanAssetMenu, productionPlanInventoryRecoveryAvailable } from "@/lib/canvas/production-plan-asset-menu";
import type { AgentRun, ProductionPlanAsset } from "@/services/api/agent";

const asset = (key: string, kind: string, status: ProductionPlanAsset["status"] = "pending", missingDependencies: string[] = []): ProductionPlanAsset => ({ key, kind, status, name: key, code: key, missingDependencies });
const run = (assets: ProductionPlanAsset[]): AgentRun => ({
    id: "run", canvasId: "canvas", status: "completed", permissionMode: "auto", createdAt: "", updatedAt: "",
    production: { targetNodeId: "plan", workKind: "plan", planReady: true, validated: true, assets },
});

test("category command includes all unfinished variants, preserves saved results, and excludes other categories", () => {
    const menu = productionPlanAssetMenu(run([asset("hero", "character"), asset("variant", "character", "failed", ["hero"]), asset("saved", "character", "complete"), asset("scene", "environment")]));
    expect(menu.map(item => item.label)).toEqual(["生成人物", "生成场景", "生成道具", "生成声音", "生成特殊资产"]);
    expect(menu[0]).toMatchObject({ disabled: false });
    expect("keys" in menu[0]).toBe(false);
    expect(menu[0].kinds).toEqual(["character"]);
    expect(menu[0].detail).toBe("生成全部未完成项");
    expect(menu[1]).toMatchObject({ disabled: false });
    expect(menu[4]).toMatchObject({ disabled: false, detail: "Agent 将依据制作方案提取此类资产并生成" });
});

test("external dependencies do not block generating a selected category", () => {
    const current = run([asset("scene", "environment"), asset("audio", "sound", "blocked", ["scene"])]);
    expect(productionPlanAssetMenu(current)[3]).toMatchObject({ disabled: false, detail: "生成全部未完成项" });
});

test("plan state never disables a category, only a local in-flight submission does", () => {
    const current = run([asset("hero", "character")]);
    current.production!.planReady = false;
    expect(productionPlanAssetMenu(current)[0].disabled).toBe(false);
    current.production!.planReady = true;
    current.production!.assetsStarted = true;
    current.status = "running";
    expect(productionPlanAssetMenu(current)[0].disabled).toBe(false);
    current.production!.paused = true;
    current.production!.waitingForBoundary = true;
    expect(productionPlanAssetMenu(current)[0]).toMatchObject({ disabled: false, detail: "当前调用收尾后开始" });
    current.production!.waitingForBoundary = false;
    expect(productionPlanAssetMenu(current)[0].disabled).toBe(false);
    expect(productionPlanAssetMenu(current, true)[0]).toMatchObject({ disabled: true, detail: "正在提交资产任务" });
});

test("active categories allow independent and dependent additions without duplicate submission", () => {
    const current = run([asset("hero", "character", "running"), asset("variant", "character", "blocked", ["hero"]), asset("scene", "environment"), asset("audio", "sound", "blocked", ["hero"])]);
    current.status = "running";
    current.production!.assetsStarted = true;
    current.production!.selectedAssetKeys = ["hero", "variant"];
    expect(productionPlanAssetMenu(current)[0]).toMatchObject({ disabled: false, detail: "此类资产已提交；再次提交会由系统判断是否重复" });
    expect(productionPlanAssetMenu(current)[1]).toMatchObject({ disabled: false });
    expect(productionPlanAssetMenu(current)[3]).toMatchObject({ disabled: false });
    current.production!.assets![0].status = "failed";
    expect(productionPlanAssetMenu(current)[0]).toMatchObject({ disabled: false });
    expect(productionPlanAssetMenu(current)[3].disabled).toBe(false);
    expect(productionPlanAssetMenu(current, true)[1].disabled).toBe(true);
});

test("completed categories stay clickable and append a new version", () => {
    const current = run([asset("prop", "prop", "complete"), asset("fx", "special", "failed")]);
    current.status = "failed";
    current.production!.assetsStarted = true;
    expect(productionPlanAssetMenu(current)[2]).toMatchObject({ disabled: false, detail: "此类资产已全部完成；再次生成会追加新版本" });
    expect(productionPlanAssetMenu(current)[4]).toMatchObject({ disabled: false });
    const missing = productionPlanAssetMenu();
    expect(missing.every(item => !item.disabled)).toBe(true);
    expect(missing[0].detail).toBe("将读取制作方案状态后创建资产任务");
});

test("validated asset plans remain selectable after cancellation or failure", () => {
    const current = run([asset("hero", "character")]);
    current.production!.assetsStarted = false;
    for (const status of ["cancelled", "failed"] as const) {
        current.status = status;
        expect(productionPlanAssetMenu(current)[0]).toMatchObject({ disabled: false });
    }
});

test("a terminal plan with a recoverable zero-item inventory exposes inventory recovery", () => {
    const current = run([]);
    current.production!.assetTotal = 0;
    current.production!.inventoryRecoveryAvailable = true;
    expect(productionPlanInventoryRecoveryAvailable(current)).toBe(true);
    current.status = "failed";
    expect(productionPlanInventoryRecoveryAvailable(current)).toBe(true);
    current.status = "cancelled";
    expect(productionPlanInventoryRecoveryAvailable(current)).toBe(true);
    current.status = "running";
    expect(productionPlanInventoryRecoveryAvailable(current)).toBe(false);
    current.status = "completed";
    current.production!.inventoryRecoveryAvailable = false;
    expect(productionPlanInventoryRecoveryAvailable(current)).toBe(false);
});

test("zero-item and stale plans still create asset tasks and only show a hint", () => {
    const current = run([]);
    current.production!.assetTotal = 0;
    current.production!.inventoryRecoveryAvailable = true;
    current.production!.assetGenerationReady = true;
    expect(productionPlanAssetMenu(current)[0]).toMatchObject({ disabled: false, detail: "Agent 将依据制作方案提取此类资产并生成" });
    current.production!.assetGenerationReady = false;
    expect(productionPlanAssetMenu(current)[0]).toMatchObject({ disabled: false, detail: "将直接按制作方案创建资产任务" });
});

test("asset generation uses the saved story even when other plan documents are not validated", () => {
    const current = run([asset("hero", "character")]);
    current.production!.assetGenerationReady = true;
    current.production!.planReady = false;
    expect(productionPlanAssetMenu(current)[0]).toMatchObject({ disabled: false });
});

test("a succeeded model call remains locked while its artifact is being saved", () => {
    const current = run([asset("hero", "character", "saving")]);
    current.status = "running";
    current.production!.assetsStarted = true;
    current.production!.selectedAssetKeys = ["hero"];
    expect(productionPlanAssetMenu(current)[0]).toMatchObject({ disabled: false, detail: "模型已返回，正在保存资产；再次生成会追加新版本" });
});
