export enum ShortDramaStage {
    Story = "story", Assets = "assets", Storyboard = "storyboard", Voice = "voice",
    Video = "video", Edit = "edit", Review = "review", Delivery = "delivery",
}
export type ShortDramaStageId = `${ShortDramaStage}`;

export const shortDramaStages: Array<{ key: ShortDramaStageId; label: string; shortLabel: string }> = [
    { key: "story", label: "剧情与章节", shortLabel: "剧情" },
    { key: "assets", label: "资产拆分", shortLabel: "资产" },
    { key: "storyboard", label: "分镜脚本", shortLabel: "分镜" },
    { key: "voice", label: "配音与声音", shortLabel: "配音" },
    { key: "video", label: "视频生成", shortLabel: "视频" },
    { key: "edit", label: "剪辑与后期", shortLabel: "剪辑" },
    { key: "review", label: "成片质检", shortLabel: "质检" },
    { key: "delivery", label: "导出交付", shortLabel: "交付" },
];
