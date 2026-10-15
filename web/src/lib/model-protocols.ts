export type ModelProtocol = string;
export enum ProtocolContract {
    ChatCompletions = "chat-completions",
    Responses = "responses",
    Messages = "messages",
    GenerateContent = "generate-content",
    ImageGenerations = "image-generations",
    Videos = "videos",
    Speech = "speech",
    AudioTasks = "audio-tasks",
    Workflow = "workflow",
    Custom = "custom",
}
export type ModelProtocolConfig = { policy: "auto" | "fixed"; supported: string[] };
export type ProtocolCapability = "text" | "image" | "video" | "audio";
export type ModelProtocolWorkflow = { id: string; label: string; providerId: string; capability: ProtocolCapability; parameters: Array<{ name: string; type: string; required?: boolean; description?: string; values?: string[]; mapping?: string }>; defaults?: Record<string, string | number | boolean> };
export type ModelProtocolDefinition = { value: ModelProtocol; label: string; vendor?: string; capability: ProtocolCapability; create: string; contentType: string; poll?: string; media: string; enabled?: boolean; baseUrl?: string; workflows?: ModelProtocolWorkflow[]; contract?: ProtocolContract; contractLabel?: string; agentSupported?: boolean };

const contractDefaults: Partial<Record<ProtocolContract, string>> = {
    [ProtocolContract.ChatCompletions]: "chat-completion",
    [ProtocolContract.Responses]: "openai-response",
    [ProtocolContract.Messages]: "claude-api",
    [ProtocolContract.GenerateContent]: "gemini-generate-content",
    [ProtocolContract.ImageGenerations]: "openai-image",
    [ProtocolContract.Videos]: "newapi",
    [ProtocolContract.Speech]: "openai-audio",
    [ProtocolContract.AudioTasks]: "async-audio",
};

export function protocolContract(item: ModelProtocolDefinition): ProtocolContract {
    if (item.contract) return item.contract;
    return (Object.entries(contractDefaults).find(([, id]) => item.value === id)?.[0] as ProtocolContract | undefined) || ProtocolContract.Custom;
}

export function protocolEndpoint(create: string) {
    return create.replace(/^(POST|GET|PUT|DELETE)\s+/u, "").replace(/^\/v\d+(?:beta\d*)?(?=\/)/u, "");
}

export function protocolContractLabel(item: ModelProtocolDefinition) {
    const contract = protocolContract(item);
    const labels: Record<ProtocolContract, string> = {
        [ProtocolContract.ChatCompletions]: "Chat Completions",
        [ProtocolContract.Responses]: "Responses",
        [ProtocolContract.Messages]: "Messages",
        [ProtocolContract.GenerateContent]: "Generate Content",
        [ProtocolContract.ImageGenerations]: "Images Generations",
        [ProtocolContract.Videos]: "Videos",
        [ProtocolContract.Speech]: "Audio Speech",
        [ProtocolContract.AudioTasks]: "Audio Tasks",
        [ProtocolContract.Workflow]: "Workflow",
        [ProtocolContract.Custom]: "扩展协议",
    };
    return labels[contract];
}

/** Group only declared contracts; keep the selected adapter and its extensions. */
export function groupedModelProtocols(protocols: ModelProtocolDefinition[], selected?: string) {
    const groups = new Map<string, ModelProtocolDefinition[]>();
    for (const item of protocols.filter((entry) => entry.enabled !== false)) {
        const contract = protocolContract(item);
        const key = `${item.capability}:${contract}`;
        groups.set(key, [...(groups.get(key) || []), item]);
    }
    return Array.from(groups.values()).map((adapters) => {
        const contract = protocolContract(adapters[0]);
        const current = adapters.find((item) => item.value === selected)
            || adapters.find((item) => item.value === contractDefaults[contract]) || adapters[0];
        return { ...current, label: protocolContractLabel(current), adapters };
    });
}

export function protocolGroups(protocols: ModelProtocolDefinition[]) {
    return (["text", "image", "video", "audio"] as ProtocolCapability[]).map((capability) => ({ label: { text: "文本", image: "图片", video: "视频", audio: "音频" }[capability], options: groupedModelProtocols(protocols.filter((item) => item.capability === capability)).map((item) => ({ label: `${item.label} · ${protocolEndpoint(item.create)}`, value: item.value })) }));
}
export function modelProtocolDefinition(value: string | undefined, definitions: ModelProtocolDefinition[] = []) { return definitions.find((item) => item.value === value); }
export function modelProtocolLabel(value: string | undefined, definitions: ModelProtocolDefinition[] = []) { const item = modelProtocolDefinition(value, definitions); return item ? protocolContractLabel(item) : (value || "未安装协议"); }
export function modelProtocolCapability(value: string | undefined, definitions: ModelProtocolDefinition[] = []) { return modelProtocolDefinition(value, definitions)?.capability; }
export function isVolcengineArkImageProtocol(protocol?: string) {
    return protocol === "volcengine-ark-image" || protocol === "volcengine-ark-agent-plan-image";
}

export function isVolcengineArkVideoProtocol(protocol?: string) {
    return protocol === "volcengine-ark-video" || protocol === "volcengine-ark-agent-plan-video";
}

export function modelProtocolSupportsTokenBilling(capability?: string, _protocol?: string) {
    return capability === "text" || capability === "video";
}

export function protocolForModelCatalog(_endpointTypes: string[] = []): ModelProtocol | undefined {
    // A provider catalog cannot invent a protocol ID. The channel's selected
    // plugin or an explicit model configuration must supply it.
    return undefined;
}
export function modelProtocolSummary(value: string | undefined, definitions: ModelProtocolDefinition[] = []) { const protocol = modelProtocolDefinition(value, definitions); return protocol ? [protocol.create, protocol.contentType, protocol.poll, protocol.media].filter(Boolean).join(" · ") : "当前协议未安装或尚未选择。"; }
export function normalizeModelProtocol(value: unknown): ModelProtocol | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
