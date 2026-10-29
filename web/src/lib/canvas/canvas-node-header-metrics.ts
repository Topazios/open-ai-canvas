export const NODE_EXTERNAL_HEADER_MIN_SCALE = 0.35;
export const GROUPED_HEADER_MIN_SCALE = 0.5;
export const HEADER_META_MIN_SCREEN_WIDTH = 120;

/**
 * 节点外部标题的显示参数。
 * 分组子节点的标题随画布一起缩小（k = min(1, scale)），避免在小比例下盖住分组状态行和上一排节点。
 */
export function groupedHeaderMetrics({ scale, nodeWidth, grouped }: { scale: number; nodeWidth: number; grouped: boolean }) {
    if (!grouped) return { visible: scale >= NODE_EXTERNAL_HEADER_MIN_SCALE, k: 1, showMeta: true };
    return {
        visible: scale >= GROUPED_HEADER_MIN_SCALE,
        k: Math.min(1, Math.max(scale, 0.05)),
        showMeta: nodeWidth * scale >= HEADER_META_MIN_SCREEN_WIDTH,
    };
}

/** 节点底部操作栏的显示方式：窄时只留图标，更窄时不显示。 */
export function nodeActionBarMode(screenWidth: number): "full" | "compact" | "hidden" {
    if (screenWidth < 120) return "hidden";
    return screenWidth < 200 ? "compact" : "full";
}

/** 分组状态行按钮在屏幕宽度不足时只显示图标。 */
export function groupStatusButtonsCompact(screenWidth: number) {
    return screenWidth < 360;
}
