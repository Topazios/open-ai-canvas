import { createContext, createElement, useContext, useMemo, type ReactNode } from "react";

import type { CanvasNodeData } from "@/types/canvas";
import { recordCanvasRender } from "@/lib/canvas/canvas-performance-diagnostics";

// 扩展节点经 Context 读取直接上游。主画布按节点提供稳定的派生数组，
// 版本预览仍可提供整个快照的读取函数；业务状态不存入这个 Context。
// 无 Provider 时静默降级为「没有上游」，节点自行显示空状态而不是崩。
export type CanvasNodeGraphContextValue = {
    getUpstreamNodes?: (nodeId: string) => CanvasNodeData[];
};

export const CanvasNodeGraphContext = createContext<CanvasNodeGraphContextValue>({});
const EMPTY_UPSTREAM: CanvasNodeData[] = [];

export function CanvasNodeGraphScope({ nodeId, upstreamNodes = EMPTY_UPSTREAM, children }: { nodeId: string; upstreamNodes?: CanvasNodeData[]; children: ReactNode }) {
    const value = useMemo<CanvasNodeGraphContextValue>(() => ({
        getUpstreamNodes: (id) => id === nodeId ? upstreamNodes : EMPTY_UPSTREAM,
    }), [nodeId, upstreamNodes]);
    return createElement(CanvasNodeGraphContext.Provider, { value }, children);
}

/** 取该节点的直接上游素材节点；无 Provider 或无上游时返回空数组。 */
export function useUpstreamNodes(nodeId: string) {
    recordCanvasRender("upstream", nodeId);
    const { getUpstreamNodes } = useContext(CanvasNodeGraphContext);
    return getUpstreamNodes?.(nodeId) ?? EMPTY_UPSTREAM;
}
