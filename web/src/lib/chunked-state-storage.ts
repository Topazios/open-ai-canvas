import type { StateStorage } from "zustand/middleware";

const CHUNK_MARKER = "\u0000localforage-chunked-v1:";
const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;

type ChunkManifest = {
    id: string;
    count: number;
    length: number;
};

function parseManifest(value: string | null): ChunkManifest | undefined {
    if (!value?.startsWith(CHUNK_MARKER)) return undefined;
    try {
        const parsed = JSON.parse(value.slice(CHUNK_MARKER.length)) as Partial<ChunkManifest>;
        if (typeof parsed.id !== "string" || !parsed.id || !Number.isSafeInteger(parsed.count) || parsed.count! < 1 || !Number.isSafeInteger(parsed.length) || parsed.length! < 0) return undefined;
        return parsed as ChunkManifest;
    } catch {
        return undefined;
    }
}

function chunkKey(name: string, id: string, index: number) {
    return `${name}:__chunked__:${id}:${index}`;
}

function createChunkId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createChunkedStateStorage(storage: StateStorage, options: { chunkSize?: number; createId?: () => string } = {}): StateStorage {
    const chunkSize = Math.max(1, options.chunkSize ?? DEFAULT_CHUNK_SIZE);
    const createId = options.createId ?? createChunkId;

    return {
        async getItem(name) {
            const value = await storage.getItem(name);
            const manifest = parseManifest(value);
            if (!manifest) return value;

            const chunks: string[] = [];
            for (let index = 0; index < manifest.count; index++) {
                const chunk = await storage.getItem(chunkKey(name, manifest.id, index));
                if (chunk === null) throw new Error("本地缓存分块不完整，原始数据未能恢复");
                chunks.push(chunk);
            }
            const restored = chunks.join("");
            if (restored.length !== manifest.length) throw new Error("本地缓存分块长度校验失败，原始数据未能恢复");
            return restored;
        },

        async setItem(name, value) {
            const previous = parseManifest(await storage.getItem(name));
            if (value.length <= chunkSize) {
                await storage.setItem(name, value);
            } else {
                const id = createId();
                const count = Math.ceil(value.length / chunkSize);
                for (let index = 0; index < count; index++) {
                    await storage.setItem(chunkKey(name, id, index), value.slice(index * chunkSize, (index + 1) * chunkSize));
                }
                await storage.setItem(name, `${CHUNK_MARKER}${JSON.stringify({ id, count, length: value.length } satisfies ChunkManifest)}`);
            }

            if (previous) {
                await Promise.all(Array.from({ length: previous.count }, (_, index) => storage.removeItem(chunkKey(name, previous.id, index))));
            }
        },

        async removeItem(name) {
            const previous = parseManifest(await storage.getItem(name));
            await storage.removeItem(name);
            if (previous) await Promise.all(Array.from({ length: previous.count }, (_, index) => storage.removeItem(chunkKey(name, previous.id, index))));
        },
    };
}
