import { expect, test } from "bun:test";
import { adjustWorkflowImagePrompt } from "@/lib/canvas/canvas-image-prompt-adjustment";
import { createWorkflowImages, workflowImageSubjects } from "@/lib/canvas/canvas-workflow-images";
import { defaultWorkflowSources, nodeWorkflow, workflowSignature } from "@/lib/canvas/canvas-short-drama-workflow";
import { ShortDramaStep } from "@/lib/short-drama-steps";
import { retryWorkflowGeneration } from "@/services/workflow-generation-retry";
import { defaultConfig } from "@/stores/use-config-store";
import { workflowImageFixture } from "./fixtures/workflow-image-project";

function fixture(step = ShortDramaStep.PropReferences) {
    const f = workflowImageFixture();
    const request = { ...f.request, step, sourceNodeIds: defaultWorkflowSources(step, f.request.pipelineId, f.nodes) };
    const subject = workflowImageSubjects(request, f.nodes)[0];
    subject.title = step === ShortDramaStep.PropReferences ? "P05猎人枪械" : "测试资产";
    subject.metadata!.content = "## 身份与正文依据\n第八集追逐剧情\n\n## 固定特征与制作设计\n灰色磨损外壳，青色装饰灯，橙色布条。\n\n## 道具声音\n低频音效\n\n## 生成提示词\n旧的结构拆解要求\n\n## 跨集连续性\n第九集补充剧情";
    const result = createWorkflowImages({ ...request, imageSubjectIds: [subject.id] }, f.nodes, f.connections, { x: 0, y: 0 });
    return { ...result, image: result.created[0], subject };
}

test("automatic adjustment keeps visual identity and layout, excludes unrelated production sections", () => {
    const f = fixture();
    const before = JSON.stringify(f.nodes);
    const prompt = adjustWorkflowImagePrompt(f.image, f.nodes, f.image.metadata!.prompt!);
    expect(prompt).toContain("P05猎人枪械");
    expect(prompt).toContain("灰色磨损外壳，青色装饰灯，橙色布条");
    expect(prompt).toContain("不具备发射功能");
    expect(prompt).toContain("左侧占18%");
    expect(prompt).toContain(f.image.metadata!.size!);
    for (const discarded of ["第八集追逐剧情", "第九集补充剧情", "低频音效", "旧的结构拆解要求"]) expect(prompt).not.toContain(discarded);
    expect(JSON.stringify(f.nodes)).toBe(before);
});

test("character and environment use their own visual views", () => {
    for (const step of [ShortDramaStep.CharacterReferences, ShortDramaStep.EnvironmentReferences]) {
        const f = fixture(step);
        const prompt = adjustWorkflowImagePrompt(f.image, f.nodes, f.image.metadata!.prompt!);
        expect(prompt).toContain(step === ShortDramaStep.CharacterReferences ? "同一人物的正面全身" : "同一空间的主视角全景");
    }
});

test("same adjusted request cannot be submitted repeatedly after another rejection", async () => {
    const f = fixture();
    const prompt = adjustWorkflowImagePrompt(f.image, f.nodes, f.image.metadata!.prompt!);
    expect(() => adjustWorkflowImagePrompt(f.image, f.nodes, prompt)).toThrow("未再次提交");
    const previous = f.image.metadata!.prompt!;
    f.image.metadata!.prompt = prompt;
    let submitted: any;
    const source = { id: "rejected", type: "canvas_image", status: "failed", errorCode: "moderation_blocked", prompt: previous, attempts: 1, createdAt: "", updatedAt: "" } as const;
    const api = { prepare: async (input: any) => input, create: async (input: any) => { submitted = input; return source; }, query: async () => { throw new Error("unexpected"); }, retry: async () => { throw new Error("must not retry rejected input"); } };
    await retryWorkflowGeneration(f.image, source, "canvas", defaultConfig, api, f.nodes);
    expect(submitted.mode).toBe("image");
    expect(submitted.prompt).toBe(prompt);
    expect(submitted.config.model).toBe(f.image.metadata!.model);
    expect(submitted.config.size).toBe(f.image.metadata!.size);
    expect(submitted.retryOf).toBe(source.id);
    expect(submitted.metadata.nodeId).toBe(f.image.id);
});

test("changed, missing or foreign sources cannot silently replace original asset version", () => {
    const f = fixture();
    expect(() => adjustWorkflowImagePrompt(f.image, f.nodes.filter((node) => node.id !== f.subject.id), "old")).toThrow();
    f.subject.metadata!.content += "changed";
    expect(() => adjustWorkflowImagePrompt(f.image, f.nodes, "old")).toThrow();
    const other = fixture();
    nodeWorkflow(other.subject)!.pipelineId = "another";
    expect(() => adjustWorkflowImagePrompt(other.image, other.nodes, "old")).toThrow();
});

test("style extraction keeps project design without sound and episode notes", () => {
    const f = fixture();
    const style = f.nodes.find((node) => nodeWorkflow(node)?.bibleSection === "style")!;
    style.metadata!.content = "## 正文风格依据\n第三集故事\n## 统一视觉风格\n水彩青绿色，柔和日光\n## 风格提示词\n手绘纸张纹理\n## 声音美学\n铜管配乐";
    // This fixture represents a newly created branch using the same current style version.
    for (const node of f.nodes) {
        const data = nodeWorkflow(node);
        if (data?.sourceSignatures[style.id]) data.sourceSignatures[style.id] = workflowSignature(style);
    }
    nodeWorkflow(f.image)!.assetSheet!.styleSignatures[style.id] = workflowSignature(style);
    const prompt = adjustWorkflowImagePrompt(f.image, f.nodes, "old");
    expect(prompt).toContain("水彩青绿色，柔和日光");
    expect(prompt).toContain("手绘纸张纹理");
    expect(prompt).not.toContain("铜管配乐");
    expect(prompt).not.toContain("第三集故事");
    style.metadata!.content += "changed";
    expect(() => adjustWorkflowImagePrompt(f.image, f.nodes, "old")).toThrow();
});
