// 媒体时长探测工具：上传前通过 <video>/<audio> 元数据读取真实时长（毫秒）。
// 结果随上传 meta 传给后端，供资源摘要和时间线片段使用；这里不负责验证完整播放能力。

const PROBE_TIMEOUT_MS = 8000;

function isProbeable(file: File): boolean {
    return /^video\//.test(file.type) || /^audio\//.test(file.type);
}

/**
 * 返回可确认的媒体时长；非音视频、浏览器不支持解码、元数据错误或超时都返回 undefined。
 * 这是上传附加信息而不是写入前置条件，调用方必须允许缺少时长，但不能编造默认时长。
 */
export async function probeMediaDurationMs(file: File): Promise<number | undefined> {
    if (!isProbeable(file)) return undefined;
    const url = URL.createObjectURL(file);
    try {
        return await probeMediaUrlDurationMs(url, /^video\//.test(file.type) ? "video" : "audio");
    } finally {
        URL.revokeObjectURL(url);
    }
}

/** 远端采用素材只读取元数据；调用方退出时停止加载，不拥有或回收传入 URL。 */
export async function probeMediaUrlDurationMs(url: string, kind: "video" | "audio", signal?: AbortSignal): Promise<number | undefined> {
    if (signal?.aborted) return undefined;
    const el: HTMLVideoElement | HTMLAudioElement = kind === "video"
        ? document.createElement("video")
        : document.createElement("audio");
    let timeoutId: number | undefined;
    let onAbort: (() => void) | undefined;
    el.preload = "metadata";
    // 某些浏览器只有在静音时才允许视频元素主动加载元数据；这里只禁止声音，不触发自动播放。
    el.muted = true;
    try {
        const durationMs = await new Promise<number>((resolve, reject) => {
            onAbort = () => resolve(0);
            signal?.addEventListener("abort", onAbort, { once: true });
            timeoutId = window.setTimeout(() => reject(new Error("媒体元数据读取超时")), PROBE_TIMEOUT_MS);
            el.onloadedmetadata = () => {
                const durationSeconds = el.duration;
                resolve(Number.isFinite(durationSeconds) && durationSeconds > 0 ? Math.round(durationSeconds * 1000) : 0);
            };
            el.onerror = () => resolve(0);
            el.src = url;
        });
        return durationMs > 0 ? durationMs : undefined;
    } catch {
        return undefined;
    } finally {
        if (timeoutId !== undefined) window.clearTimeout(timeoutId);
        el.onloadedmetadata = null;
        el.onerror = null;
        el.removeAttribute("src");
        el.load();
        if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
}
