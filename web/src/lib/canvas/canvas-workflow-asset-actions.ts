import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { ShortDramaStep as S, type ShortDramaStepId } from "../short-drama-steps";
import { type PlannedAssetKind } from "../production-plan";
import { workflowAssetKind } from "./canvas-production-sources";

const assetActions: Record<`${PlannedAssetKind}`, { label: string; step: ShortDramaStepId; imageStep?: ShortDramaStepId; audioStep?: ShortDramaStepId }> = {
    character: { label: "人物资产", step: S.Characters, imageStep: S.CharacterReferences },
    environment: { label: "场景资产", step: S.Environments, imageStep: S.EnvironmentReferences },
    prop: { label: "道具资产", step: S.Props, imageStep: S.PropReferences },
    sound: { label: "声音资产", step: S.Voices, audioStep: S.VoiceSamples },
    special: { label: "特殊资产", step: S.Special, imageStep: S.SpecialReferences },
};

export function workflowAssetActions(node?: CanvasNodeData) {
    const data = node?.metadata?.shortDrama;
    if (!data || data.mediaKind || data.mediaGroup || data.planSection || data.bibleSection || data.assetGroup?.kind === "bible" || data.assetKey === "$summary") return;
    const kind = data.assetRevisionGroup?.kind || data.planGroup?.kind || data.assetIdentity?.kind || data.planAsset?.kind ||
        ((data.assetKey || data.assetGroup) ? workflowAssetKind[data.step] : undefined);
    if (!kind || !(kind in assetActions) || (node?.type !== CanvasNodeType.Text && node?.type !== CanvasNodeType.Frame)) return;
    return { kind: kind as `${PlannedAssetKind}`, ...assetActions[kind as `${PlannedAssetKind}`] };
}

export function workflowAssetRevisionMembers(anchor: CanvasNodeData, nodes: CanvasNodeData[]) {
    const category = workflowAssetActions(anchor);
    if (!category) throw new Error("请选择具体资产或资产分类容器");
    const data = anchor.metadata!.shortDrama!;
    const members = data.role === "collection" ? data.sourceNodeIds.filter((id) => id !== data.assetGroup?.manifestId).map((id) => {
        const node = nodes.find((entry) => entry.id === id);
        if (!node || node.parentId !== anchor.id || workflowAssetActions(node)?.kind !== category.kind) throw new Error("资产分组成员已删除、移出或类别不一致，请先整理分组");
        return node;
    }) : [anchor];
    if (!members.length) throw new Error("当前分组还没有可重做的资产");
    if (members.some((node) => node.metadata?.shortDrama?.pipelineId !== data.pipelineId || !node.metadata?.content?.trim() || node.metadata?.status === "loading" || node.metadata?.status === "error" || node.metadata?.shortDrama?.assetOutput)) throw new Error("请先完成当前资产内容，再重做另一版");
    return members;
}
