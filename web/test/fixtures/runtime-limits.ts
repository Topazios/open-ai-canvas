import { useUserStore, type RuntimeConcurrency } from "../../src/stores/use-user-store";

export function installRuntimeLimits(concurrency: Partial<RuntimeConcurrency> = {}, activeTaskLimit = 5) {
    useUserStore.getState().setRuntimeLimits({
        activeTaskLimit, resourceUploadMB: 50,
        concurrency: { image: 5, text: 3, agent: 2, video: 2, audio: 2, other: 2, channel: 5, customRelay: 5, imagePreparation: 4, resourceDownload: 16, upload: 4, mediaRecovery: 2, agentSessions: 2, ...concurrency },
    });
}
