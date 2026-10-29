import { describe, expect, test } from "bun:test";

import { prepareBackendGenerationTask } from "../src/services/api/generation-task";
import { createModelChannel, defaultConfig, encodeChannelModel } from "../src/stores/use-config-store";

// 拆分 generation-task.ts 前后，同一输入必须得到完全相同的后端任务载荷。
function channelImageConfig() {
    const channel = createModelChannel({
        id: "baseline-image",
        name: "Baseline Image",
        baseUrl: "https://image.example.com/v1",
        apiKey: "fake-key",
        interfaceType: "openai-image",
        models: ["image-model"],
        modelCosts: [{
            model: "image-model",
            capability: "image",
            protocol: "openai-image",
            billingMode: "fixed_request",
            unitPriceMicrocredits: 1,
            defaultOptions: { style: "vivid" },
        }],
    });
    const model = encodeChannelModel(channel.id, "image-model");
    return { ...defaultConfig, channels: [channel], model, baseUrl: channel.baseUrl, interfaceType: channel.interfaceType, size: "1024x1024", quality: "high", count: "2" };
}

function logicalImageConfig() {
    const channel = createModelChannel({
        id: "baseline-logical",
        name: "Baseline Logical",
        baseUrl: "https://logical.example.com/v1",
        apiKey: "fake-key",
        interfaceType: "openai-image",
        models: ["logical-image"],
        modelCosts: [{
            model: "logical-image",
            capability: "image",
            protocol: "openai-image",
            billingMode: "fixed_request",
            unitPriceMicrocredits: 1,
            logicalModelId: "lm-image-1",
            logicalCapabilitySpec: { version: 1, capability: "image", options: { size: { values: ["1024x1024"] }, count: { min: 1, max: 4 } } },
        }],
    });
    const model = encodeChannelModel(channel.id, "logical-image");
    return { ...defaultConfig, channels: [channel], model, baseUrl: channel.baseUrl, interfaceType: channel.interfaceType, size: "1024x1024", quality: "auto", count: "1" };
}

const reference = {
    id: "ref-1",
    name: "ref.png",
    type: "image/png",
    dataUrl: "data:image/png;base64,AAAA",
    url: "https://cdn.example.com/ref.png",
    storageKey: "resource:res-1",
    width: 640,
    height: 480,
};

describe("legacy generation task payload baseline", () => {
    test("channel image task", async () => {
        const input = await prepareBackendGenerationTask({
            projectId: "project-1",
            mode: "image",
            prompt: "draw a cat",
            config: channelImageConfig(),
            referenceImages: [reference],
            metadata: { sourceNodeId: "node-1" },
            clientOperationId: "op-1",
            retryOf: "task-0",
            attemptGroupId: "group-1",
        });
        expect(input).toMatchSnapshot();
    });

    test("logical image task", async () => {
        const input = await prepareBackendGenerationTask({
            mode: "image",
            prompt: "draw a dog",
            config: logicalImageConfig(),
            metadata: { sourceNodeId: "node-2" },
        });
        expect(input.logicalModelId).toBe("lm-image-1");
        expect(input).toMatchSnapshot();
    });

    test("channel routing overrides logical model", async () => {
        const input = await prepareBackendGenerationTask({
            mode: "image",
            prompt: "draw a bird",
            config: logicalImageConfig(),
            modelRouting: "channel",
        });
        expect(input.logicalModelId).toBeUndefined();
        expect(input).toMatchSnapshot();
    });

    test("text task options", async () => {
        const input = await prepareBackendGenerationTask({
            mode: "text",
            prompt: "hello",
            config: channelImageConfig(),
            textHistory: [{ role: "user", content: "hi" }],
            maxOutputTokens: 256,
            streamText: false,
            structuredOutput: { name: "out", schema: { type: "object" } },
        });
        expect(input).toMatchSnapshot();
    });
});
