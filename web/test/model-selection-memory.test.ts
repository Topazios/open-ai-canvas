import { expect, test } from "bun:test";
import { CONFIG_STORE_KEY, createModelChannel, defaultConfig, normalizeConfigSnapshot, useConfigStore, type ModelCapability } from "../src/stores/use-config-store";
import { setActiveUserScope, scopedStorageKey } from "../src/lib/user-scope";

test("model choices persist per capability and user, including closing without generating", async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const previousConfig = useConfigStore.getState().config;
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
    } } });
    try {
        const capabilities: ModelCapability[] = ["text", "image", "video", "audio"];
        const channel = createModelChannel({ id: "memory", name: "Memory", scope: "system", models: capabilities.flatMap((c) => [`${c}-one`, `${c}-two`]),
            modelCosts: capabilities.flatMap((capability) => ["one", "two"].map((suffix) => ({ model: `${capability}-${suffix}`, capability, billingMode: "fixed_request" as const, unitPriceMicrocredits: 0 }))) });
        const initial = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [channel] } }).config;
        setActiveUserScope("memory-user-a");
        useConfigStore.getState().replaceConfig(initial);
        for (const capability of capabilities) useConfigStore.getState().rememberModel(capability, `memory::${capability}-two`);
        const persisted = JSON.parse(storage.get(scopedStorageKey(CONFIG_STORE_KEY))!).state.config;
        for (const capability of capabilities) expect(persisted[`${capability}Model`]).toBe(`memory::${capability}-two`);
        useConfigStore.getState().rememberModel("text", "memory::video-two");
        useConfigStore.getState().rememberModel("image", "removed-model");
        expect(useConfigStore.getState().config.textModel).toBe("memory::text-two");
        expect(useConfigStore.getState().config.imageModel).toBe("memory::image-two");
        setActiveUserScope("memory-user-b");
        useConfigStore.getState().replaceConfig(initial);
        useConfigStore.getState().rememberModel("text", "memory::text-one");
        setActiveUserScope("memory-user-a");
        await useConfigStore.persist.rehydrate();
        for (const capability of capabilities) expect(useConfigStore.getState().config[`${capability}Model`]).toBe(`memory::${capability}-two`);
        setActiveUserScope("memory-user-b");
        await useConfigStore.persist.rehydrate();
        expect(useConfigStore.getState().config.textModel).toBe("memory::text-one");
    } finally {
        useConfigStore.getState().replaceConfig(previousConfig);
        if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
        else Reflect.deleteProperty(globalThis, "window");
    }
});
