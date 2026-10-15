import localforage from "localforage";

import { nanoid } from "nanoid";
import { readImageMeta } from "@/lib/image-utils";
import { getActiveUserScope } from "@/lib/user-scope";
import { getResourceAccess, importResourceFromUrl, isResourceUrl, resolveResourceAccessURL, resourceFileUrl, resourceIdFromStorageKey, resourceStorageKey, resourceStorageKeyFromURL, ResourceUploadError, uploadResourceFile } from "@/services/api/resources";
import { getCachedResourceBlob, primeResourceBlobCache } from "@/services/resource-blob-cache";
import { LocalMediaUrlCache } from "@/services/local-media-url-cache";

export type UploadedImage = {
    url: string;
    storageKey: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
    /**
     * true 表示直传失败、文件当前只存在于本机 IndexedDB。
     * 云端数据同步会用同一幂等键重传，但在那之前它不是一份已持久化的服务端资源：
     * `url` 是页面级 objectURL，刷新即失效。UI 不得把这种结果说成"已保存"。
     */
    pendingRemoteUpload?: boolean;
    /** 直传失败原因，仅在 pendingRemoteUpload 为 true 时有值，供 UI 如实告知用户。 */
    remoteUploadError?: string;
};

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "image_files" });
const objectUrls = new LocalMediaUrlCache();

export function clearImageObjectUrls() { objectUrls.clear(); }

export async function uploadImage(input: string | Blob, onProgress?: (uploadedBytes: number, totalBytes: number) => void): Promise<UploadedImage> {
    // 同一个逻辑上传在直传失败后会退回 IndexedDB，并由云端数据同步再次提交。
    // 提前生成本地 key，确保两条路径向后端发送相同的幂等标识。
    const storageKey = `image:${getActiveUserScope()}:${nanoid()}`;
    const generation = objectUrls.generation;
    if (typeof input === "string" && shouldImportRemoteImage(input)) {
        try {
            const resource = await importResourceFromUrl(input, "image", { idempotencyKey: storageKey });
            objectUrls.assertCurrent(generation);
            return {
                url: resource.publicUrl || resourceFileUrl(resource.id),
                storageKey: resourceStorageKey(resource.id),
                width: resource.width || 1024,
                height: resource.height || 1024,
                bytes: resource.size || 0,
                mimeType: resource.mimeType || "image/png",
            };
        } catch (error) {
            objectUrls.assertCurrent(generation);
            if (error instanceof DOMException && error.name === "AbortError") throw error;
            // Keep the browser-side path as a fallback for CORS-enabled HTTPS images.
        }
    }
    let blob: Blob;
    if (typeof input === "string") {
        const response = await fetch(input, { credentials: isResourceUrl(input) ? "include" : "same-origin" });
        if (!response.ok) throw new Error(`读取图片失败（HTTP ${response.status}）`);
        blob = await response.blob();
    } else blob = input;
    objectUrls.assertCurrent(generation);
    const previewUrl = URL.createObjectURL(blob);
    let retainPreviewUrl = false;
    try {
        const meta = await readImageMeta(previewUrl);
        objectUrls.assertCurrent(generation);
        let remoteUploadError = "";
        try {
            const resource = await uploadResourceFile(blob, "image", { width: meta.width, height: meta.height, fileName: input instanceof File ? input.name : undefined, idempotencyKey: storageKey }, onProgress);
            objectUrls.assertCurrent(generation);
            await primeResourceBlobCache(resourceStorageKey(resource.id), blob).catch(() => "");
            objectUrls.assertCurrent(generation);
            return {
                url: resource.publicUrl || resourceFileUrl(resource.id),
                storageKey: resourceStorageKey(resource.id),
                width: resource.width || meta.width,
                height: resource.height || meta.height,
                bytes: resource.size || blob.size,
                mimeType: resource.mimeType || blob.type || meta.mimeType,
            };
        } catch (error) {
            objectUrls.assertCurrent(generation);
            if (error instanceof DOMException && error.name === "AbortError") throw error;
            // 鉴权失效、越权、体积超限这类失败重传也是同样结果，不能退化成"稍后自动同步"。
            if (error instanceof ResourceUploadError && error.permanent) throw error;
            remoteUploadError = error instanceof Error ? error.message : "图片直传失败";
        }
        // 瞬时失败退回本机：文件仍可用，且云端数据同步会用同一幂等键重传。
        await store.setItem(storageKey, blob);
        objectUrls.assertCurrent(generation);
        const url = objectUrls.adopt(storageKey, previewUrl);
        retainPreviewUrl = true;
        return { url, storageKey, width: meta.width, height: meta.height, bytes: blob.size, mimeType: blob.type || meta.mimeType, pendingRemoteUpload: true, remoteUploadError };
    } finally {
        if (!retainPreviewUrl) URL.revokeObjectURL(previewUrl);
    }
}

function shouldImportRemoteImage(input: string) {
    return /^https?:\/\//i.test(input) && !isResourceUrl(input);
}

export async function resolveImageUrl(storageKey?: string, fallback = "", options?: { cacheMiss?: boolean }) {
    // Older canvas snapshots may only keep a signed `/api/public/resources/...`
    // URL. Recover its stable resource key before mounting it so an expired
    // signature is never used as the first browser request.
    const resolvedStorageKey = storageKey || resourceStorageKeyFromURL(fallback);
    if (!resolvedStorageKey) return fallback;
    const resourceId = resourceIdFromStorageKey(resolvedStorageKey);
    if (resourceId) {
        // 远程资源展示直接使用 OSS/CDN 授权地址，不把媒体内容读进浏览器 Blob。
        return resolveResourceAccessURL((await getResourceAccess(resolvedStorageKey, "display")).url);
    }
    return (await objectUrls.resolve(resolvedStorageKey, () => store.getItem<Blob>(resolvedStorageKey))) || fallback;
}

export async function getImageBlob(storageKey: string) {
    if (resourceIdFromStorageKey(storageKey)) return getCachedResourceBlob(storageKey);
    return store.getItem<Blob>(storageKey);
}

export async function setImageBlob(storageKey: string, blob: Blob) {
    if (resourceIdFromStorageKey(storageKey)) return primeResourceBlobCache(storageKey, blob);
    return objectUrls.write(storageKey, blob, () => store.setItem(storageKey, blob));
}

export async function imageToDataUrl(image: { url?: string; dataUrl?: string; storageKey?: string; name?: string; type?: string; mimeType?: string }) {
    if (image.storageKey) {
        const blob = await getImageBlob(image.storageKey);
        if (blob) return blobToDataUrl(await normalizeImageBlob(blob, image.name || image.url));
    }
    const url = image.dataUrl || (await resolveImageUrl(image.storageKey, image.url || ""));
    if (!url) return url;
    if (url.startsWith("data:image/")) return url;
    if (url.startsWith("data:")) return blobToDataUrl(await normalizeImageBlob(await (await fetch(url)).blob(), image.name));
    const blob = await (await fetch(url, { credentials: isResourceUrl(url) ? "include" : "same-origin" })).blob();
    return blobToDataUrl(await normalizeImageBlob(blob, image.name || url));
}

export async function deleteStoredImages(keys: Iterable<string>) {
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            if (resourceIdFromStorageKey(key)) return;
            await objectUrls.remove(key, () => store.removeItem(key));
        }),
    );
}

export async function cleanupUnusedImages(usedData: unknown, scope = getActiveUserScope()) {
    const usedKeys = collectImageStorageKeys(usedData);
    const currentPrefixes = [`image:${scope}:`, `generation-image:${scope}:`];
    const unused: string[] = [];
    await store.iterate((_value, key) => {
        if (currentPrefixes.some((prefix) => key.startsWith(prefix)) && !usedKeys.has(key)) unused.push(key);
    });
    await deleteStoredImages(unused);
}

export function collectImageStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && (value.storageKey.startsWith("image:") || value.storageKey.startsWith("generation-image:") || resourceIdFromStorageKey(value.storageKey))) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectImageStorageKeys(child, keys)) : collectImageStorageKeys(item, keys)));
    return keys;
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("读取图片失败"));
        reader.readAsDataURL(blob);
    });
}

async function normalizeImageBlob(blob: Blob, sourceName = "") {
    if (blob.type.startsWith("image/")) return blob;
    const bytes = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
    const mimeType = detectImageMimeType(bytes) || imageMimeTypeFromName(sourceName);
    if (!mimeType) throw new Error("无法识别参考图片格式，请重新上传 PNG、JPEG、WebP 或 GIF 图片");
    return blob.slice(0, blob.size, mimeType);
}

function detectImageMimeType(bytes: Uint8Array) {
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (bytes.length >= 6 && String.fromCharCode(...bytes.slice(0, 6)).startsWith("GIF8")) return "image/gif";
    if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
    if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
    return "";
}

function imageMimeTypeFromName(value: string) {
    const path = value.toLowerCase().split(/[?#]/)[0];
    if (path.endsWith(".png")) return "image/png";
    if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
    if (path.endsWith(".webp")) return "image/webp";
    if (path.endsWith(".gif")) return "image/gif";
    if (path.endsWith(".bmp")) return "image/bmp";
    return "";
}
