import type { CanvasNodeData } from "@/types/canvas";
import { compactUnsubmittedBodyNodes } from "./canvas-short-drama-workflow";

// The editor already falls back to prompt when no separate composer draft exists.
// Preserve distinct drafts and accepted batch inputs; never-submitted bodies
// can replace repeated materials with their validated versioned references.
export function compactWorkflowNodes(nodes: CanvasNodeData[]): CanvasNodeData[] {
    return compactUnsubmittedBodyNodes(nodes).map((node) => {
        const metadata = node.metadata;
        if (!metadata?.shortDrama || typeof metadata.prompt !== "string" || metadata.composerContent !== metadata.prompt) return node;
        const { composerContent: _duplicate, ...rest } = metadata;
        return { ...node, metadata: rest };
    });
}

export function markWorkflowSubmissionBlocked(nodes: CanvasNodeData[], ids: readonly string[], reason: string): CanvasNodeData[] {
    const affected = new Set(ids);
    return nodes.map((node) => !affected.has(node.id) || node.metadata?.shortDrama?.submission !== "planned" ? node : {
        ...node,
        metadata: { ...node.metadata, status: "error", taskStage: "尚未提交生成", errorDetails: reason },
    });
}
