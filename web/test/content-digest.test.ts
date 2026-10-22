import { describe, expect, test } from "bun:test";
import { sha256Hex } from "../src/lib/content-digest";

describe("content digest", () => {
    test("HTTP LAN hashing matches native SHA-256 and preserves idempotency keys", async () => {
        const nativeCrypto = globalThis.crypto;
        const cases = ["", "abc", "人物、场景、分镜", "生成素材".repeat(10_000)];
        const expected = await Promise.all(cases.map((value) => sha256Hex(new TextEncoder().encode(value))));
        try {
            Object.defineProperty(globalThis, "crypto", { configurable: true, value: { getRandomValues: nativeCrypto.getRandomValues.bind(nativeCrypto) } });
            expect(globalThis.crypto.subtle).toBeUndefined();
            for (const [index, value] of cases.entries()) {
                expect(await sha256Hex(new TextEncoder().encode(value))).toBe(expected[index]);
            }
            expect(await sha256Hex(new ArrayBuffer(0))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        } finally {
            Object.defineProperty(globalThis, "crypto", { configurable: true, value: nativeCrypto });
        }
    });
});
