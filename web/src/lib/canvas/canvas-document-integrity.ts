import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

/** parentId is ownership. Deleting a group differs from explicitly ungrouping it. */
export function canvasOwnedDeletionIds(nodes: CanvasNodeData[], requested: ReadonlySet<string>): Set<string> {
    const children = new Map<string, string[]>();
    const link = (parent: string, child: string) => {
        const ids = children.get(parent);
        if (ids) ids.push(child); else children.set(parent, [child]);
    };
    const byId = new Map(nodes.map(node => [node.id, node]));
    for (const node of nodes) {
        if (node.parentId) link(node.parentId, node.id);
        for (const id of node.metadata?.batchChildIds || []) link(node.id, id);
        for (const binding of [node.metadata?.storyboardFrame, node.metadata?.storyboardFramePlan]) if (binding?.scriptId) link(binding.scriptId, node.id);
        const workflow = node.metadata?.shortDrama;
        if (workflow?.step === "story.plan" && workflow.role === "collection") {
            for (const id of workflow.sourceNodeIds || []) {
                const member = byId.get(id);
                if (member && !member.parentId && member.metadata?.shortDrama?.planSection === "story" && member.metadata.shortDrama.role === "document") link(node.id, id);
            }
        }
    }
    const deleted = new Set(requested);
    const queue = [...deleted];
    for (let index = 0; index < queue.length; index++) for (const id of children.get(queue[index]) || []) {
        if (!deleted.has(id)) { deleted.add(id); queue.push(id); }
    }
    return deleted;
}

/** Only call after assembling a complete snapshot or an entire incremental patch. */
export function cleanCanvasDocument(nodes: CanvasNodeData[], connections: CanvasConnection[], deleted: ReadonlySet<string> = new Set()) {
    const children = new Map<string, string[]>();
    const roots: string[] = [];
    for (const node of nodes) {
        if (!node.parentId) roots.push(node.id);
        else {
            const ids = children.get(node.parentId);
            if (ids) ids.push(node.id); else children.set(node.parentId, [node.id]);
        }
    }
    const reachable = new Set<string>();
    for (let index = 0; index < roots.length; index++) {
        const id = roots[index];
        if (reachable.has(id)) continue;
        reachable.add(id);
        for (const child of children.get(id) || []) roots.push(child);
    }
    const invalid = new Set(deleted);
    for (const node of nodes) if (!reachable.has(node.id)) invalid.add(node.id);
    const removedIds = canvasOwnedDeletionIds(nodes, invalid);
    const live = new Set(nodes.filter(node => !removedIds.has(node.id)).map(node => node.id));
    const filter = (ids: string[] | undefined) => {
        if (!ids) return ids;
        const kept = ids.filter(id => live.has(id));
        return kept.length === ids.length ? ids : kept;
    };
    let changed = false;
    const result = nodes.filter(node => !removedIds.has(node.id)).map(node => {
        const metadata = node.metadata;
        if (!metadata) return node;
        const workflow = metadata.shortDrama;
        const sourceNodeIds = filter(workflow?.sourceNodeIds);
        const batchChildIds = filter(metadata.batchChildIds);
        const primaryImageId = metadata.primaryImageId && !live.has(metadata.primaryImageId) ? undefined : metadata.primaryImageId;
        const storyboard = metadata.storyboard;
        const referenceNodeIds = filter(storyboard?.referenceNodeIds);
        const rows = storyboard?.rows.map(row => {
            const assetBindings = row.assetBindings?.filter(binding => live.has(binding.nodeId));
            const imageNodeId = row.imageNodeId && !live.has(row.imageNodeId) ? undefined : row.imageNodeId;
            const videoNodeId = row.videoNodeId && !live.has(row.videoNodeId) ? undefined : row.videoNodeId;
            if (assetBindings?.length === row.assetBindings?.length && imageNodeId === row.imageNodeId && videoNodeId === row.videoNodeId) return row;
            return { ...row, assetBindings, imageNodeId, videoNodeId };
        });
        const rowsChanged = rows?.some((row, index) => row !== storyboard?.rows[index]);
        if (sourceNodeIds === workflow?.sourceNodeIds && batchChildIds === metadata.batchChildIds && primaryImageId === metadata.primaryImageId && referenceNodeIds === storyboard?.referenceNodeIds && !rowsChanged) return node;
        changed = true;
        return { ...node, metadata: { ...metadata, batchChildIds, primaryImageId,
            ...(workflow ? { shortDrama: { ...workflow, sourceNodeIds: sourceNodeIds! } } : {}),
            ...(storyboard ? { storyboard: { ...storyboard, referenceNodeIds: referenceNodeIds!, rows: rows! } } : {}),
        } };
    });
    const keptConnections = connections.filter(edge => live.has(edge.fromNodeId) && live.has(edge.toNodeId));
    return { nodes: changed || result.length !== nodes.length ? result : nodes,
        connections: keptConnections.length === connections.length ? connections : keptConnections, removedIds };
}
