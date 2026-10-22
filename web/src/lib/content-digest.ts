export async function sha256Hex(bytes: Uint8Array<ArrayBuffer> | ArrayBuffer): Promise<string> {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const digest = globalThis.crypto?.subtle
        ? new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", data))
        : (await import("@noble/hashes/sha256")).sha256(data);
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
