import type { CanvasNodeData } from "@/types/canvas";
import { ShortDramaStep as S, type ShortDramaStepId } from "../short-drama-steps";

export const workflowAssetKind: Partial<Record<ShortDramaStepId, string>> = {
    [S.Characters]: "character", [S.Environments]: "environment", [S.Props]: "prop", [S.Special]: "special", [S.Voices]: "sound",
};

export function workflowSourceMatches(node: CanvasNodeData | undefined, required: ShortDramaStepId, nodes: CanvasNodeData[]) {
    const data = node?.metadata?.shortDrama;
    const step = data?.step || (node?.metadata?.storyDevelopment ? `story.${node.metadata.storyDevelopment.stage}` : undefined);
    if (step === required && !data?.planGroup) return true;
    if (!data || data.role !== "collection") return false;
    if (required === S.Bible) return data.step === S.Plan && (data.planVersion ?? 0) >= 2 && !data.planGroup;
    const kind = workflowAssetKind[required];
    const groupIds = new Set([node!.id, ...Object.values(data.planGroups || {})]);
    return Boolean(kind && (data.step === S.Plan || data.step === S.Reconcile) && nodes.some((member) =>
        groupIds.has(member.parentId || "") && (data.sourceNodeIds.includes(member.id) || Boolean(nodes.find((group) => group.id === member.parentId)?.metadata?.shortDrama?.sourceNodeIds.includes(member.id))) &&
        (member.metadata?.shortDrama?.assetIdentity?.kind || member.metadata?.shortDrama?.planAsset?.kind) === kind));
}
