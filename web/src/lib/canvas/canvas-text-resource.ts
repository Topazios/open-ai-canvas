import { getResourceBlob, resourceFileUrl, resourceIdFromStorageKey } from "@/services/api/resources";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export function remapImportedNodeResource(node: CanvasNodeData, mapped?: { storageKey: string; url: string; textContent?: string }): CanvasNodeData {
    const isMedia = node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio;
    const isDeadBlob = (value?: string) => typeof value === "string" && value.startsWith("blob:");
    const oldKey = node.metadata?.storageKey;
    const storageKey = mapped?.storageKey || (oldKey && !isDeadBlob(oldKey) ? oldKey : undefined);
    const oldResourceId = resourceIdFromStorageKey(oldKey);
    const corruptedText = node.type === CanvasNodeType.Text && oldResourceId && node.metadata?.content === resourceFileUrl(oldResourceId);
    const content = corruptedText && mapped?.textContent !== undefined ? mapped.textContent : node.metadata?.content;
    return {
        ...node,
        metadata: {
            ...node.metadata,
            ...(storageKey !== undefined ? { storageKey } : {}),
            content: isMedia && mapped ? mapped.url : isDeadBlob(content) ? "" : content,
            previewContent: isMedia && mapped ? mapped.url : isDeadBlob(node.metadata?.previewContent) ? "" : node.metadata?.previewContent,
            ...(corruptedText && node.metadata?.prompt === node.metadata?.content && mapped?.textContent !== undefined ? { prompt: mapped.textContent } : {}),
        },
    };
}

export async function restoreCanvasTextResources(
    project: CanvasProject,
    readText: (storageKey: string) => Promise<string> = async (storageKey) => {
        const blob = await getResourceBlob(storageKey);
        if (!blob) throw new Error("文本资源不存在");
        return blob.text();
    },
): Promise<CanvasProject> {
    const cache = new Map<string, Promise<string>>();
    const nodes = await Promise.all(
        project.nodes.map(async (node) => {
            const storageKey = node.metadata?.storageKey;
            const resourceId = resourceIdFromStorageKey(storageKey);
            if (node.type !== CanvasNodeType.Text || !storageKey || !resourceId || node.metadata?.content !== resourceFileUrl(resourceId)) return node;
            try {
                let content = cache.get(storageKey);
                if (!content) {
                    content = readText(storageKey);
                    cache.set(storageKey, content);
                }
                const restored = await content;
                return { ...node, metadata: { ...node.metadata, content: restored, prompt: node.metadata.prompt === node.metadata.content ? restored : node.metadata.prompt } };
            } catch (error) {
                console.warn(`文本节点「${node.title}」恢复失败`, error);
                return node;
            }
        }),
    );
    return nodes.some((node, index) => node !== project.nodes[index]) ? { ...project, nodes } : project;
}
