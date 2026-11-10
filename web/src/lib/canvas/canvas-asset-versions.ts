import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { isPlanPlaceholder } from "./plan-placeholder";

export function assetDocumentIdentity(node: CanvasNodeData) {
    const data = node.metadata?.shortDrama;
    if (node.type !== CanvasNodeType.Text || !data?.assetIdentity?.id || data.assetKey === "$summary") return;
    return `${data.pipelineId}:${data.step}:${data.assetIdentity.id}`;
}

/** A selection affects presentation and future references, never an existing media source. */
export function currentAssetMemberIds(nodes: CanvasNodeData[]) {
    const selected = new Map<string, CanvasNodeData>();
    const aliases = new Map<string, string | null>();
    const members: { node: CanvasNodeData; scope: string; id?: string; key?: string; slot?: string }[] = [];
    for (const node of nodes) {
        const data = node.metadata?.shortDrama;
        const eligible = node.type === CanvasNodeType.Text && data?.assetKey !== "$summary";
        const id = eligible ? data?.assetIdentity?.id : undefined;
        const key = eligible && (id || data?.planAsset) ? data?.planAsset?.key || data?.assetKey : undefined;
        const scope = id || key ? JSON.stringify([node.parentId || "", data?.pipelineId || "", data?.step || ""]) : "";
        members.push({ node, scope, id, key });
        if (!id || !key) continue;
        const alias = `${scope}:key:${key}`;
        if (!aliases.has(alias)) aliases.set(alias, id);
        else if (aliases.get(alias) !== id) aliases.set(alias, null);
    }
    const rank = (node: CanvasNodeData) => node.metadata?.shortDrama?.assetAdopted === true ? 2 : node.metadata?.shortDrama?.assetAdopted === false ? 0 : 1;
    for (const member of members) {
        const { node, scope, id, key } = member;
        const linked = id || (key ? aliases.get(`${scope}:key:${key}`) : undefined);
        member.slot = linked ? `${scope}:id:${linked}` : key ? `${scope}:key:${key}` : undefined;
        if (!member.slot) continue;
        const prior = selected.get(member.slot);
        if (!prior) { selected.set(member.slot, node); continue; }
        // A recovery placeholder describes work, not another visible version of
        // a dossier that is already available. Keep the finished card in its slot.
        const pending = isPlanPlaceholder(node), priorPending = isPlanPlaceholder(prior);
        const version = node.metadata?.shortDrama?.assetVersion ?? 1, priorVersion = prior.metadata?.shortDrama?.assetVersion ?? 1;
        const newer = version > priorVersion || (version === priorVersion && node.id > prior.id);
        const preferred = rank(node) > rank(prior) || (rank(node) === rank(prior) && newer);
        if (pending !== priorPending ? !pending : preferred) selected.set(member.slot, node);
    }
    return new Set(members.filter(member => !member.slot || selected.get(member.slot) === member.node).map(member => member.node.id));
}

export function currentAssetDocumentIds(nodes: CanvasNodeData[]) {
    const ids = currentAssetMemberIds(nodes);
    return new Set(nodes.filter(node => assetDocumentIdentity(node) && ids.has(node.id)).map(node => node.id));
}

export function currentAssetMembers(nodes: CanvasNodeData[]) {
    const ids = currentAssetMemberIds(nodes);
    return nodes.filter(node => ids.has(node.id));
}

export function assetVersionStats(nodes: CanvasNodeData[]) {
    const documents = nodes.filter(node => Boolean(assetDocumentIdentity(node)));
    const current = currentAssetMembers(documents);
    return { current, versions: documents.length, assets: current.length,
        completed: current.filter(node => Boolean(node.metadata?.content?.trim()) && node.metadata?.status === "success").length };
}
