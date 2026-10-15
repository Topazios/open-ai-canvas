import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import type { NodeGenerationInput } from "@/components/canvas/canvas-node-generation";
import { hasCanvasCustomNodeContent } from "@/lib/canvas/canvas-custom-node-content";
import { getInputSummary } from "@/lib/canvas/canvas-project-domain";
import { isCanvasNodeGenerating } from "@/lib/canvas/canvas-node-task-state";
import { reconcileCanvasArray, sameCanvasShallowValue } from "@/lib/canvas/canvas-render-reconciliation";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { resolveDirectorActiveShot } from "@/lib/canvas/director/director-preview";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import type { DirectorScene } from "@/types/director";

export type CanvasCustomNodeScope = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    mentionReferences: CanvasResourceReference[];
    inputSummary: ReturnType<typeof getInputSummary>;
    directorScene: DirectorScene | null;
    isRunning: boolean;
};
type NodeRenderer = (node: CanvasNodeData) => ReactNode;
type ScopedRenderer = (node: CanvasNodeData, scope: CanvasCustomNodeScope) => ReactNode;
type Options = {
    visibleNodes: CanvasNodeData[];
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    mentionReferencesByNodeId: Map<string, CanvasResourceReference[]>;
    configInputsById: Map<string, NodeGenerationInput[]>;
    directorScenes?: DirectorScene[];
    runningNodeId: string | null;
};
const EMPTY_REFERENCES: CanvasResourceReference[] = [];

// Only render-time dependencies are narrowed. Command handlers still read the latest full graph.
export function buildCanvasCustomNodeScopes(options: Options): Map<string, CanvasCustomNodeScope> {
    const { visibleNodes, nodes, connections, mentionReferencesByNodeId, configInputsById, directorScenes, runningNodeId } = options;
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const nodeOrder = new Map(nodes.map((node, index) => [node.id, index]));
    const incoming = new Map<string, CanvasConnection[]>();
    const outgoing = new Map<string, CanvasConnection[]>();
    for (const connection of connections) {
        const inEdges = incoming.get(connection.toNodeId);
        if (inEdges) inEdges.push(connection); else incoming.set(connection.toNodeId, [connection]);
        const outEdges = outgoing.get(connection.fromNodeId);
        if (outEdges) outEdges.push(connection); else outgoing.set(connection.fromNodeId, [connection]);
    }
    const scopes = new Map<string, CanvasCustomNodeScope>();
    for (const node of visibleNodes) {
        if (!hasCanvasCustomNodeContent(node)) continue;
        const ids = new Set<string>();
        const add = (id?: string) => { if (id) ids.add(id); };
        let edges: CanvasConnection[] = [];
        if (node.type === CanvasNodeType.BatchTable) {
            for (const row of node.metadata?.batchTable?.rows || []) {
                row.inputNodeIds.forEach(add);
                row.textNodeIds?.forEach(add);
                add(row.outputNodeId);
            }
            edges = incoming.get(node.id) || [];
        }
        if (node.type === CanvasNodeType.Script) {
            const videoIds = new Set<string>();
            for (const row of node.metadata?.storyboard?.rows || []) {
                add(row.imageNodeId); add(row.videoNodeId);
                row.assetBindings?.forEach((binding) => add(binding.nodeId));
                if (row.videoNodeId && nodeById.get(row.videoNodeId)?.type === CanvasNodeType.Video) videoIds.add(row.videoNodeId);
            }
            for (const source of [node.id, ...videoIds]) {
                for (const edge of outgoing.get(source) || []) {
                    const target = nodeById.get(edge.toNodeId);
                    if (target?.type === CanvasNodeType.Video && target.metadata?.workflowKind === "final") {
                        add(target.id); edges.push(edge);
                    }
                }
            }
        }
        const directorScene = directorScenes?.find((scene) => scene.id === node.metadata?.directorSceneId) || null;
        if (node.metadata?.directorSceneId) {
            add(node.metadata.directorPreviewNodeId);
            add(resolveDirectorActiveShot(directorScene, node.metadata.directorShotId)?.previewNodeId);
        }
        const relatedNodes = [...ids].map((id) => nodeById.get(id)).filter((item): item is CanvasNodeData => Boolean(item));
        relatedNodes.sort((left, right) => nodeOrder.get(left.id)! - nodeOrder.get(right.id)!);
        scopes.set(node.id, {
            nodes: relatedNodes, connections: edges,
            mentionReferences: node.type === CanvasNodeType.Script ? mentionReferencesByNodeId.get(node.id) || EMPTY_REFERENCES : EMPTY_REFERENCES,
            inputSummary: getInputSummary(configInputsById.get(node.id) || []),
            directorScene, isRunning: isCanvasNodeGenerating(node, runningNodeId),
        });
    }
    return scopes;
}

export function useCanvasScopedNodeRenderers(options: Options, render: ScopedRenderer) {
    const { visibleNodes, nodes, connections, mentionReferencesByNodeId, configInputsById, directorScenes, runningNodeId } = options;
    const previous = useRef(new Map<string, { scope: CanvasCustomNodeScope; render: ScopedRenderer; bound: NodeRenderer }>());
    const cache = useMemo(() => {
        const scopes = buildCanvasCustomNodeScopes({ visibleNodes, nodes, connections, mentionReferencesByNodeId, configInputsById, directorScenes, runningNodeId });
        const result = new Map<string, { scope: CanvasCustomNodeScope; render: ScopedRenderer; bound: NodeRenderer }>();
        for (const [id, fresh] of scopes) {
            const old = previous.current.get(id);
            const scope = {
                ...fresh,
                nodes: reconcileCanvasArray(old?.scope.nodes, fresh.nodes),
                connections: reconcileCanvasArray(old?.scope.connections, fresh.connections),
                inputSummary: old && sameCanvasShallowValue(old.scope.inputSummary, fresh.inputSummary) ? old.scope.inputSummary : fresh.inputSummary,
            };
            result.set(id, old?.render === render && sameCanvasShallowValue(old.scope, scope) ? old : {
                scope, render, bound: (node) => render(node, scope),
            });
        }
        return result;
    }, [visibleNodes, nodes, connections, mentionReferencesByNodeId, configInputsById, directorScenes, runningNodeId, render]);
    useLayoutEffect(() => { previous.current = cache; }, [cache]);
    return useMemo(() => new Map([...cache].map(([id, entry]) => [id, entry.bound])), [cache]);
}
