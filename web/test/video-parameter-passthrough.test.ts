import { expect, test } from "bun:test";
import { defaultModelCapabilityConfig, normalizeVideoValue } from "../src/lib/model-capabilities";
import { modelCompatibilityError, modelPromptLengthError, modelGroupReferenceLimits, resolveCompatibleModel, resolveModelVideoBooleanOptions } from "../src/lib/model-selection";
import { buildGenerationConfig } from "../src/lib/canvas/canvas-project-generation";
import { defaultConfig, type AiConfig } from "../src/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

test("video submission preserves explicit parameters despite restrictive channel metadata", () => {
    const capabilityConfig = defaultModelCapabilityConfig();
    const profile = capabilityConfig.video!;
    profile.duration = { selection: "enum", values: [5, 10], default: 5 };
    profile.resolutions = ["480p"];
    profile.ratios = ["16:9"];
    profile.references.maxImages = 1;
    profile.references.maxAudios = 0;
    profile.operations = ["text_to_video"];
    const model = "channel::omni-fast";
    const config: AiConfig = { ...defaultConfig, model, videoModel: model, videoModels: [model], channels: [{
        id: "channel", name: "test", apiFormat: "openai", apiKey: "test", baseUrl: "https://example.com",
        models: ["omni-fast"], modelCosts: [{ model: "omni-fast", capability: "video", billingMode: "per_second", unitPriceMicrocredits: 1, capabilityConfig }],
    }] };
    const requirements = { capability: "video" as const, videoSeconds: "24", videoOperation: "reference_to_video", input: {textCount: 1, imageCount: 8, videoCount: 2, audioCount: 2, characterCount: 0} };
    expect(modelCompatibilityError(config, model, requirements)).toBe("");
    expect(resolveCompatibleModel(config, model, requirements)).toBe(model);
    expect(modelPromptLengthError(config, model, "video", "x".repeat(10000))).toBe("");
    expect(modelGroupReferenceLimits(config, model, "video")?.maxImages).toBe(Infinity);
    const node = { id: "video", type: CanvasNodeType.Video, title: "video", position: {x: 0,y: 0}, width: 100,height: 100,
        metadata: { model, generationMode: "video", seconds: "24", size: "21:9", vquality: "1080p", generateAudio: "true", watermark: "true" } } as CanvasNodeData;
    const result = buildGenerationConfig(config, node, "video", requirements);
    expect(result).toMatchObject({ model, videoSeconds:"24",size:"21:9",vquality:"1080p",videoGenerateAudio:"true",videoWatermark:"true" });
    expect(normalizeVideoValue(profile,{seconds:"24",ratio:"21:9",resolution:"custom"})).toEqual({seconds:"24",ratio:"21:9",resolution:"custom"});
    expect(resolveModelVideoBooleanOptions(config,model,{videoGenerateAudio:"true",videoWatermark:"true"})).toEqual({videoGenerateAudio:"true",videoWatermark:"true"});
});
