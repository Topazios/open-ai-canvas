import { expect, test } from "bun:test";
import { workflowImageFixture } from "./fixtures/workflow-image-project";
import { createWorkflowImages, workflowImageSubjects } from "@/lib/canvas/canvas-workflow-images";
import { nodeWorkflow } from "@/lib/canvas/canvas-short-drama-workflow";
import { retryWorkflowGeneration } from "@/services/workflow-generation-retry";
import { defaultConfig } from "@/stores/use-config-store";
import { generationPromptFingerprint } from "@/lib/generation-error";
import { assetSheetSubjectMaterial } from "@/lib/asset-sheet-material";
import { AssetSheetKind } from "@/lib/asset-reference-sheet";
import { globalSettingsPrompt, defaultShortDramaSettings } from "@/lib/short-drama-settings";
import { resolveProductionAssetReferences } from "@/lib/canvas/production-asset-references";
import { assetSheetReferenceContent } from "@/lib/canvas/canvas-asset-sheet-context";
import type { GenerationTask } from "@/services/api/task-center";

function fixture() {
    const f = workflowImageFixture();
    const subject = workflowImageSubjects(f.request, f.nodes)[0];
    subject.metadata!.content = "## 年龄感、体型、面部与辨识特征\n成年女性，左眉缺口\n## 固定服装、配饰与材质配色\n棉布蓝衫\n## 人物参考图生成提示词\n先持机再伸出另一只手\n## 人物跨集不变项与变化条件\n冗长故事账本";
    const result = createWorkflowImages({ ...f.request, imageSubjectIds: [subject.id] }, f.nodes, f.connections, { x: 0, y: 0 });
    const image = result.created[0];
    image.metadata!.prompt = "旧版系统生成提示词\n冗长故事账本";
    nodeWorkflow(image)!.assetSheet!.promptFingerprint = generationPromptFingerprint(image.metadata!.prompt);
    const source: GenerationTask = { id: "old-image", type: "canvas_image", status: "failed", prompt: image.metadata!.prompt, attempts: 1, createdAt: "", updatedAt: "", error: "upstream_timeout" };
    const calls: any[] = [];
    const api = { prepare: async (input: any) => input, create: async (input: any) => { calls.push(input); return { ...source, id: "new-image", prompt: input.prompt }; },
        retry: async (id: string) => { calls.push({ retry: id }); return source; }, query: async () => { throw new Error("Unexpected query"); } };
    return { ...result, subject, image, source, api, calls };
}

test("retry rebuilds unchanged generated requests from pinned sources without changing model, size or retry identity", async () => {
    const f = fixture();
    const before = JSON.stringify(f.nodes);
    await retryWorkflowGeneration(f.image, f.source, "canvas", defaultConfig, f.api, f.nodes);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].prompt).toContain("成年女性，左眉缺口");
    expect(f.calls[0].prompt).not.toContain("冗长故事账本");
    expect(f.calls[0].prompt).not.toContain("先持机再伸出另一只手");
    expect(f.calls[0].config.model).toBe(f.image.metadata!.model);
    expect(f.calls[0].config.size).toBe(f.image.metadata!.size);
    expect(f.calls[0].retryOf).toBe(f.source.id);
    expect(JSON.stringify(f.nodes)).toBe(before);
});

test("manual edits, including edits before submission, are not silently replaced", async () => {
    const f = fixture();
    f.image.metadata!.prompt = "我手动指定的绿色外套";
    await retryWorkflowGeneration(f.image, f.source, "canvas", defaultConfig, f.api, f.nodes);
    expect(f.calls[0].prompt).toBe("我手动指定的绿色外套");
    f.calls.length = 0;
    f.source.prompt = f.image.metadata!.prompt;
    await retryWorkflowGeneration(f.image, f.source, "canvas", defaultConfig, f.api, f.nodes);
    expect(f.calls).toEqual([{ retry: "old-image" }]);
});

test("legacy prompts without a generated fingerprint and recoverable media keep the original retry path", async () => {
    for (const change of ["legacy", "media"] as const) {
        const f = fixture();
        if (change === "legacy") delete nodeWorkflow(f.image)!.assetSheet!.promptFingerprint;
        else { f.source.mediaStage = "local_save"; f.source.canRecoverMedia = true; }
        await retryWorkflowGeneration(f.image, f.source, "canvas", defaultConfig, f.api, f.nodes);
        expect(f.calls).toEqual([{ retry: "old-image" }]);
    }
});

test("source changes and moderation still block an automatic unedited resubmission", async () => {
    const f = fixture();
    f.subject.metadata!.content += "外观已变";
    await expect(retryWorkflowGeneration(f.image, f.source, "canvas", defaultConfig, f.api, f.nodes)).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
    const moderated = fixture(); moderated.source.errorCode = "moderation_blocked";
    await expect(retryWorkflowGeneration(moderated.image, moderated.source, "canvas", defaultConfig, moderated.api, moderated.nodes)).rejects.toThrow("不能原样重试");
    expect(moderated.calls).toHaveLength(0);
});

test("visual-only settings and missing visual data cannot leak story settings into an image", () => {
    const settings = { ...defaultShortDramaSettings(), premise: "完整故事梗概不进入设定板", episodeCount: 60 };
    const image = globalSettingsPrompt(settings, "assets", "image");
    for (const excluded of ["完整故事梗概", "总集数", "单集时长", "目标市场", "发行方向"]) expect(image).not.toContain(excluded);
    expect(globalSettingsPrompt(settings, "story")).toContain(settings.premise);
    expect(() => assetSheetSubjectMaterial("## 声音设计\n低音声线", AssetSheetKind.Character)).toThrow("缺少可用于生图的外观设计");
});

test("explicit asset references retain codes and selected variants but exclude their full narrative", () => {
    const f = fixture();
    nodeWorkflow(f.subject)!.assetIdentity = { id: "identity", code: "CHR-0001", kind: "character" };
    nodeWorkflow(f.subject)!.assetProfile = { indexContent: "test", variants: [{ code: "CHR-0001-V01", name: "雨衣", description: "黄色雨衣" }], references: [] } as any;
    const resolved = resolveProductionAssetReferences("@CHR-0001-V01", [f.subject], [], (node) => assetSheetReferenceContent(node, "another-subject"));
    expect(resolved.content).toContain("CHR-0001"); expect(resolved.content).toContain("黄色雨衣");
    expect(resolved.content).not.toContain("冗长故事账本");
    expect(resolveProductionAssetReferences("@CHR-0001", [f.subject], [], (node) => assetSheetReferenceContent(node, f.subject.id)).content).toBe("");
    expect(resolveProductionAssetReferences("@CHR-0001-V01", [f.subject], [], (node) => assetSheetReferenceContent(node, f.subject.id)).content).toContain("黄色雨衣");
});
