import { MAX_CANVAS_PAYLOAD_BYTES } from "./generation-contract.generated";
import { ApiError } from "@/services/api/request";

// Count UTF-8 without allocating a second buffer the size of the document.
export function canvasPayloadBytes(json: string) {
    let bytes = 0;
    for (let index = 0; index < json.length; index++) {
        const code = json.charCodeAt(index);
        if (code < 0x80) bytes++;
        else if (code < 0x800) bytes += 2;
        else if (code >= 0xd800 && code <= 0xdbff && json.charCodeAt(index + 1) >= 0xdc00 && json.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index++; }
        else bytes += 3;
        if (bytes > MAX_CANVAS_PAYLOAD_BYTES) throw new ApiError("画布数据超过 100MiB 保存上限；本地内容已保留，未覆盖云端", { status: 413, reason: "canvas_payload_too_large", retryable: false });
    }
    return bytes;
}
