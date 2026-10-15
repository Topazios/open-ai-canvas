import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { productionRuleCatalog } from "../src/lib/production-rules.generated";
import { applyProductionRules, productionRuleBlock, type ProductionRuleMode } from "../src/lib/production-rules";
import { shortDramaSteps } from "../src/lib/short-drama-steps";
import { shortDramaStages } from "../src/lib/short-drama-stages";
import { buildStoryDevelopmentPrompt, createStoryDevelopmentChain, saveStoryDevelopmentNode } from "../src/lib/canvas/canvas-story-development";
import { AssetSheetKind, assetSheetPrompt } from "../src/lib/asset-reference-sheet";
import { runBackendGenerationTask } from "../src/services/api/generation-task";
import { createModelChannel, defaultConfig, encodeChannelModel } from "../src/stores/use-config-store";
import { defaultModelCapabilityConfig } from "../src/lib/model-capabilities";

test("generated frontend rules match the embedded backend catalog and cover every stage and step", () => {
    const shared = JSON.parse(readFileSync(new URL("../../backend/internal/productionrules/rules.json", import.meta.url), "utf8"));
    expect(productionRuleCatalog).toEqual(shared);
    expect(Object.keys(shared.stages).sort()).toEqual(shortDramaStages.map((stage) => stage.key).sort());
    for (const step of shortDramaSteps) expect(productionRuleBlock(step.stage, "text")).toContain(shared.stages[step.stage][0]);
});

test("normalization preserves content, remains idempotent and never contaminates speech", () => {
    const original = "说话人：林澄\n这段对白必须逐字保留。\n";
    for (const { key } of shortDramaStages) {
        for (const mode of ["text", "image", "video", "audio"] as ProductionRuleMode[]) {
            const normalized = applyProductionRules(original, key, mode);
            expect(applyProductionRules(normalized, key, mode)).toBe(normalized);
            if (mode === "audio") expect(normalized).toBe(original);
            else {
                expect(normalized.endsWith(original)).toBe(true);
                expect(normalized.split("【制作执行规范 v")).toHaveLength(2);
            }
        }
    }
});

test("story generation and revision preserve structured output and user material with the rules", () => {
    let { nodes } = createStoryDevelopmentChain({ x: 0, y: 0 });
    nodes[0].metadata!.storyDevelopment!.brief = { genre: "悬疑", style: "水彩", premise: "相机记录时间", audience: "", episodeCount: 2, minutesPerEpisode: "2", topicCount: 3 };
    for (const original of nodes) nodes = saveStoryDevelopmentNode(nodes, original, original.title!, `${original.title}原文`, original.metadata!.storyDevelopment!);
    for (const node of nodes) {
        const data = node.metadata!.storyDevelopment!;
        const prompt = buildStoryDevelopmentPrompt(data, nodes, "保留草稿", "延续伏笔", data.stage === "topic");
        expect(prompt.startsWith(productionRuleBlock("story", "text"))).toBe(true);
        expect(prompt).toContain("保留草稿"); expect(prompt).toContain("延续伏笔");
        if (data.stage === "topic") {
            expect(prompt).toContain('仅返回 JSON：{"topics":');
            expect(prompt).toContain("一次生成 3 个");
        } else expect(prompt).toContain("仅输出修订后的完整正文");
    }
});

test("ordinary props also avoid instructions to invent internals and keep project design", () => {
    const prompt = assetSheetPrompt({ kind: AssetSheetKind.Prop, size: "16:9", title: "旧相机", content: "铜色磨损机身，绿色背带", style: "水彩线描" });
    expect(prompt.startsWith(productionRuleBlock("assets", "image"))).toBe(true);
    expect(prompt).toContain("铜色磨损机身，绿色背带"); expect(prompt).toContain("水彩线描");
    expect(prompt).not.toContain("可拆附件"); expect(prompt).not.toContain("材质/磨损/机关");
    expect(prompt).toContain("外观与材质细节");
});

test("known image limits reject the complete prompt before any task submission", async () => {
    const profile = defaultModelCapabilityConfig("openai-image", "fixture");
    profile.image!.references.promptMaxChars = 6;
    const channel = createModelChannel({ id: "rules-fixture", name: "Fixture", baseUrl: "https://fixture.invalid", apiKey: "test-only", interfaceType: "openai-image", models: ["fixture"],
        modelCosts: [{ model: "fixture", capability: "image", protocol: "openai-image", capabilityConfig: profile, billingMode: "fixed_request", unitPriceMicrocredits: 1 }] });
    const config = { ...defaultConfig, channels: [channel], model: encodeChannelModel(channel.id, "fixture"), systemPrompt: "镜头" };
    let submitted = 0;
    const dependencies = { createId: () => "test-id", createTask: async () => { submitted++; throw new Error("should not submit"); }, waitTask: async () => { throw new Error("should not wait"); } };
    for (const prompt of ["主体画", applyProductionRules("画面", "assets", "image")]) {
        await expect(runBackendGenerationTask({ mode: "image", prompt, config }, dependencies)).rejects.toThrow("提示词最多 6 个字符");
    }
    expect(submitted).toBe(0);
});
