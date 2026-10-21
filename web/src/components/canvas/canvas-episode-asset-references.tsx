import { CanvasNodeType } from "@/types/canvas";
import type { resolveEpisodeShotAssets } from "@/lib/canvas/workflow-episode-storyboard";
import { CanvasStoryboardImageStack, type StoryboardImagePreview } from "./canvas-storyboard-image-stack";

export function CanvasEpisodeAssetReferences({ assets, onPreview }: {
    assets?: ReturnType<typeof resolveEpisodeShotAssets>;
    onPreview: StoryboardImagePreview;
    large?: boolean;
}) {
    const items = assets?.media.filter(image => image.type === CanvasNodeType.Image).map(image => {
            const subjects = assets.nodes.filter(subject => image.metadata?.shortDrama?.mediaSubjectId === subject.id || subject.metadata?.shortDrama?.assetProfile?.references.some(ref => ref.selected && ref.nodeId === image.id));
            const names = subjects.map(subject => subject.metadata?.shortDrama?.planAsset?.name || subject.title).filter(Boolean);
            const codes = subjects.flatMap(subject => {
                const code = subject.metadata?.shortDrama?.assetIdentity?.code;
                return assets.codes.filter(value => value === code || code && value.startsWith(`${code}-V`));
            });
            return { id: image.id, node: { ...image, title: [names.join("、") || image.title || "未命名资产", codes.join("、")].filter(Boolean).join(" · ") }, label: [names.join("、") || image.title || "未命名资产", codes.join("、")].filter(Boolean).join(" · ") };
        }) || [];
    return <div className="canvas-episode-asset-references" aria-label="引用素材">
        {items.length ? <CanvasStoryboardImageStack label="引用素材" items={items} onPreview={onPreview} /> : null}
    </div>;
}
