import { describe, expect, test } from "bun:test";
import { groupedModelProtocols, protocolEndpoint, ProtocolContract, type ModelProtocolDefinition } from "../src/lib/model-protocols";
import { normalizeModelCapabilityConfig, defaultModelCapabilityConfig } from "../src/lib/model-capabilities";

const definitions: ModelProtocolDefinition[] = [
    { value: "kimi-chat", label: "Kimi", contract: ProtocolContract.ChatCompletions, capability: "text", create: "POST /v1/chat/completions", contentType: "application/json", media: "" },
    { value: "chat-completion", label: "OpenAI", contract: ProtocolContract.ChatCompletions, capability: "text", create: "POST /chat/completions", contentType: "application/json", media: "" },
    { value: "openai-response", label: "OpenAI Responses", contract: ProtocolContract.Responses, capability: "text", create: "POST /responses", contentType: "application/json", media: "" },
];

describe("protocol contracts", () => {
    test("groups vendor implementations by contract and defaults to canonical adapter", () => {
        const groups = groupedModelProtocols(definitions);
        expect(groups.map((item) => item.label)).toEqual(["Chat Completions", "Responses"]);
        expect(groups[0].value).toBe("chat-completion");
        expect(groups[0].adapters.map((item) => item.value)).toEqual(["kimi-chat", "chat-completion"]);
    });
    test("keeps selected adapter, custom extensions and modality separate", () => {
        const groups = groupedModelProtocols([...definitions, { ...definitions[0], value: "custom", label: "My adapter", contract: ProtocolContract.Custom }, { ...definitions[0], value: "image", capability: "image" }], "kimi-chat");
        expect(groups[0].value).toBe("kimi-chat");
        expect(groups.find((item) => item.value === "custom")?.adapters[0].label).toBe("My adapter");
        expect(groups).toHaveLength(4);
    });
    test("does not resurrect disabled adapters", () => {
        const groups = groupedModelProtocols(definitions.map((item) => ({ ...item, enabled: item.value !== "chat-completion" })));
        expect(groups[0].value).toBe("kimi-chat");
    });
    test("removes only conventional version from display", () => {
        expect(protocolEndpoint("POST /v1/chat/completions")).toBe("/chat/completions");
        expect(protocolEndpoint("POST /v2/videos")).toBe("/videos");
        expect(protocolEndpoint("POST /api/custom/v2/tasks")).toBe("/api/custom/v2/tasks");
    });
    test("capability edits keep explicit support instead of guessing Responses", () => {
        const original = defaultModelCapabilityConfig("chat-completion");
        expect(normalizeModelCapabilityConfig(original).protocols).toBeUndefined();
        const protocols = { policy: "auto" as const, supported: ["chat-completion", "openai-response"] };
        expect(normalizeModelCapabilityConfig({ ...original, protocols }).protocols).toEqual(protocols);
    });
});
