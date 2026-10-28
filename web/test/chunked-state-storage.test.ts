import { expect, test } from "bun:test";
import { createChunkedStateStorage } from "../src/lib/chunked-state-storage";
import type { StateStorage } from "zustand/middleware";

function memoryStorage() {
    const values = new Map<string, string>();
    const storage: StateStorage = {
        getItem: async (name) => values.get(name) ?? null,
        setItem: async (name, value) => { values.set(name, value); },
        removeItem: async (name) => { values.delete(name); },
    };
    return { storage, values };
}

test("large state values round-trip through bounded chunks and replace older chunks", async () => {
    const { storage, values } = memoryStorage();
    let nextId = 0;
    const chunked = createChunkedStateStorage(storage, { chunkSize: 8, createId: () => `id-${++nextId}` });
    const original = JSON.stringify({ text: "画布🙂".repeat(20) });

    await chunked.setItem("canvas", original);
    expect(await chunked.getItem("canvas")).toBe(original);
    expect([...values.entries()].filter(([key]) => key.includes(":__chunked__:")).every(([, value]) => value.length <= 8)).toBe(true);

    await chunked.setItem("canvas", "tiny");
    expect(await chunked.getItem("canvas")).toBe("tiny");
    expect([...values.keys()].some((key) => key.includes(":__chunked__:"))).toBe(false);
});

test("failed chunk writes leave the previous value readable", async () => {
    const { storage, values } = memoryStorage();
    const chunked = createChunkedStateStorage(storage, { chunkSize: 4, createId: () => "stable" });
    await chunked.setItem("assets", "old value");
    const failing: StateStorage = {
        ...storage,
        setItem: async (name, value) => {
            if (name.includes(":__chunked__:")) throw new Error("quota");
            values.set(name, value);
        },
    };
    const failingChunked = createChunkedStateStorage(failing, { chunkSize: 4, createId: () => "new" });

    await expect(failingChunked.setItem("assets", "replacement larger than one chunk")).rejects.toThrow("quota");
    expect(await chunked.getItem("assets")).toBe("old value");
});

test("removing a chunked value removes its chunks", async () => {
    const { storage, values } = memoryStorage();
    const chunked = createChunkedStateStorage(storage, { chunkSize: 3, createId: () => "remove-me" });
    await chunked.setItem("draft", "a long draft");
    await chunked.removeItem("draft");

    expect(await chunked.getItem("draft")).toBeNull();
    expect([...values.keys()].some((key) => key.includes(":__chunked__:"))).toBe(false);
});
