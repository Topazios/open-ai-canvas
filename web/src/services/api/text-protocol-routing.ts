import { modelCapabilityConfigFor } from "@/lib/model-capabilities";
import { resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";

// These older synchronous entry points send a wire-specific body to the relay.
// Background jobs resolve the same declaration authoritatively on the server.
export function resolveTextRequestConfig(config: AiConfig) {
    const model = config.model || config.textModel;
    const resolved = resolveModelRequestConfig(config, model);
    const policy = modelCapabilityConfigFor(config, model).protocols;
    if (policy?.policy === "auto" && policy.supported.includes("openai-response")) {
        return { ...resolved, interfaceType: "openai-response", apiFormat: "openai" as const };
    }
    return resolved;
}
