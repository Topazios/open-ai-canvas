import { parseVirtualDocument } from "./virtual-document";

globalThis.onmessage = (event: MessageEvent<string>) => {
    try {
        globalThis.postMessage({ blocks: parseVirtualDocument(event.data) });
    } catch {
        globalThis.postMessage({ error: "文稿解析失败，可切换到编辑模式查看原文。" });
    }
};
