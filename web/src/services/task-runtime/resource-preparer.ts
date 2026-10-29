import { isArkPlanBaseUrl } from "@/lib/seedance-video";
import { getMediaBlob } from "@/services/file-storage";
import { getImageBlob } from "@/services/image-storage";
import { resourceIdFromStorageKey, resourceStorageKey, uploadResourceFile } from "@/services/api/resources";
import { resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

// 资源准备器：提交前把页面态引用（Data URL、blob:、本地存储 key）统一转成后端可信资源引用。
// 这是构造器之外唯一允许产生副作用（上传）的环节，构造器本身必须保持纯函数。

export type PreparedGenerationReferences = {
    referenceImages: ReferenceImage[];
    referenceVideos: ReferenceVideo[];
    referenceAudios: ReferenceAudio[];
    mask?: ReferenceImage;
};

export type GenerationReferenceInput = {
    config: AiConfig;
    mode: "text" | "image" | "video" | "audio";
    referenceImages?: ReferenceImage[];
    referenceVideos?: ReferenceVideo[];
    referenceAudios?: ReferenceAudio[];
    mask?: ReferenceImage;
};

export async function prepareGenerationReferences({
    config,
    mode,
    referenceImages = [],
    referenceVideos = [],
    referenceAudios = [],
    mask,
}: GenerationReferenceInput): Promise<PreparedGenerationReferences> {
    // asset:// 仅视频生成可用；Agent Plan Seedream 与 Seedance 共用 /api/plan/v3，不能按 BaseURL 误判。
    const preferArkAssetUrl = mode === "video" && usesArkVideoAssetReference(config);
    const preparedImages = await Promise.all(referenceImages.map((image) => prepareBackendImageReference(image, preferArkAssetUrl)));
    const preparedVideos = await Promise.all(referenceVideos.map(prepareBackendMediaReference));
    const preparedAudios = await Promise.all(referenceAudios.map(prepareBackendMediaReference));
    const preparedMask = mask ? await prepareBackendImageReference(mask, false) : undefined;
    return { referenceImages: preparedImages, referenceVideos: preparedVideos, referenceAudios: preparedAudios, mask: preparedMask };
}

// 与后端 isArkPrivateAssetVideoConfig 对齐：方舟视频渠道允许参考图直接 asset:// 引用，
// 跳过可信素材上传同步（适合已录入方舟素材 ID 的素材，例如被授权的真人像素材）。
function usesArkVideoAssetReference(config: AiConfig) {
    const interfaceType = resolveModelRequestConfig(config, config.model).interfaceType;
    if (interfaceType === "volcengine-ark-video" || interfaceType === "volcengine-ark-agent-plan-video") return true;
    if (interfaceType === "volcengine-ark-image" || interfaceType === "volcengine-ark-agent-plan-image") return false;
    return isArkPlanBaseUrl(config.baseUrl || "");
}

async function prepareBackendMediaReference<T extends ReferenceVideo | ReferenceAudio>(media: T): Promise<T> {
    if (resourceIdFromStorageKey(media.storageKey)) return backendMediaReference(media, { storageKey: media.storageKey } as Partial<T>);
    const url = media.url || "";
    if (/^https?:\/\//i.test(url)) return backendMediaReference(media, { url } as Partial<T>);
    let blob: Blob | null = null;
    if (media.storageKey) blob = await getMediaBlob(media.storageKey);
    if (!blob && (url.startsWith("blob:") || url.startsWith("data:"))) blob = await (await fetch(url)).blob();
    if (!blob) throw new Error("参考媒体尚未保存，请重新上传后再生成");
    try {
        const kind: "video" | "audio" | "file" = blob.type.startsWith("video/") ? "video" : blob.type.startsWith("audio/") ? "audio" : "file";
        const resource = await uploadResourceFile(blob, kind, { fileName: media.name, width: "width" in media ? media.width : undefined, height: "height" in media ? media.height : undefined, durationMs: media.durationMs });
        return backendMediaReference(media, { storageKey: resourceStorageKey(resource.id), type: resource.mimeType || media.type || blob.type } as Partial<T>);
    } catch (error) {
        throw new Error(error instanceof Error ? `参考媒体上传失败：${error.message}` : "参考媒体上传失败");
    }
}

async function prepareBackendImageReference(image: ReferenceImage, preferArkAssetUrl = false) {
    if (preferArkAssetUrl && image.arkAssetId) return backendImageReference(image, { url: `asset://${image.arkAssetId}` });
    if (resourceIdFromStorageKey(image.storageKey)) return backendImageReference(image, { storageKey: image.storageKey });
    const sourceUrl = image.url || image.dataUrl;
    if (/^https?:\/\//i.test(sourceUrl)) return backendImageReference(image, { url: sourceUrl });
    const blob = image.storageKey ? await getImageBlob(image.storageKey) : sourceUrl ? await (await fetch(sourceUrl)).blob() : null;
    if (!blob) throw new Error("参考图片尚未保存，请重新上传后再生成");
    try {
        const resource = await uploadResourceFile(blob, "image", { fileName: image.name });
        return backendImageReference(image, { storageKey: resourceStorageKey(resource.id), type: resource.mimeType || image.type || blob.type });
    } catch (error) {
        throw new Error(error instanceof Error ? `参考图片上传失败：${error.message}` : "参考图片上传失败");
    }
}

// 任务输入只允许后端协议字段，避免把 previewUrl 等页面态 Data URL 带入强校验写路径。
function backendImageReference(image: ReferenceImage, override: Partial<ReferenceImage>): ReferenceImage {
    return {
        id: image.id,
        name: image.name,
        type: override.type || image.type,
        dataUrl: "",
        url: override.url,
        storageKey: override.storageKey,
        ...(image.bytes ? { bytes: image.bytes } : {}),
        ...(image.width ? { width: image.width } : {}),
        ...(image.height ? { height: image.height } : {}),
    };
}

function backendMediaReference<T extends ReferenceVideo | ReferenceAudio>(media: T, override: Partial<T>): T {
    return {
        id: media.id,
        name: media.name,
        type: override.type || media.type,
        url: override.url || "",
        storageKey: override.storageKey,
        ...("bytes" in media && media.bytes ? { bytes: media.bytes } : {}),
        ...("width" in media && media.width ? { width: media.width } : {}),
        ...("height" in media && media.height ? { height: media.height } : {}),
        ...(media.durationMs ? { durationMs: media.durationMs } : {}),
    } as T;
}
