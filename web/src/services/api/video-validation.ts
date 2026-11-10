import { modelCapabilityConfigFor } from "@/lib/model-capabilities";
import { resolveModelRequestConfig } from "@/stores/use-config-store";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import type { ReferenceImage } from "@/types/image";

import type { ResolvedAiConfig } from "./video-contracts";

// Capability metadata must not prevent a video request reaching its provider.
export function assertVideoCapability(
    _profile: NonNullable<ReturnType<typeof modelCapabilityConfigFor>["video"]>,
    _references: ReferenceImage[],
    _videoReferences: ReferenceVideo[],
    _audioReferences: ReferenceAudio[],
    seconds: string,
) {
    if (seconds.trim() && !Number.isInteger(Number(seconds))) throw new Error("视频时长必须是整数秒");
}

export function assertVideoConfig(config: ResolvedAiConfig, model: string) {
    if (!model) throw new Error("请先配置视频模型");
    if (!config.baseUrl.trim()) throw new Error("请先配置 Base URL");
    if (!config.apiKey.trim()) throw new Error("请先配置 API Key");
    if (config.apiFormat === "gemini" && config.interfaceType !== "gemini-veo") throw new Error("当前 Gemini 文本协议不支持视频生成，请为该模型选择 Gemini Veo 协议");
}

export function normalizeVideoSeconds(value: string) {
    const seconds = Math.floor(Number(value) || 6);
    return String(Math.max(1, seconds));
}

export function normalizeVideoSize(value: string) {
    if (value === "auto") return null;
    const size = (value || "1280x720").trim().toLowerCase().replace("×", "x");
    if (/^\d+x\d+$/.test(size)) return size;
    const ratio = size.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
    if (!ratio) return "1280x720";
    const widthRatio = Number(ratio[1]);
    const heightRatio = Number(ratio[2]);
    if (!Number.isFinite(widthRatio) || !Number.isFinite(heightRatio) || widthRatio <= 0 || heightRatio <= 0) return "1280x720";
    const aspect = widthRatio / heightRatio;
    const width = aspect >= 1 ? 1280 : Math.max(256, Math.round((720 * aspect) / 2) * 2);
    const height = aspect >= 1 ? Math.max(256, Math.round((1280 / aspect) / 2) * 2) : 720;
    return `${width}x${height}`;
}

export function normalizeVideoResolution(value: string) {
    if (value === "low") return "480p";
    if (value === "auto" || value === "high" || value === "medium") return "720p";
    if (value.toLowerCase() === "2k") return "1440p";
    if (value.toLowerCase() === "4k") return "2160p";
    const resolution = value.replace(/p$/i, "") || "720";
    return `${resolution}p`;
}

export function isPublicMediaUrl(value: string) {
    return /^https?:\/\//i.test(value || "");
}
