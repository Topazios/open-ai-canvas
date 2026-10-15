export enum ProductionBibleSection {
    Settings = "settings",
    StoryContinuity = "story_continuity",
    Style = "style",
    ArtDirection = "art_direction",
    Cinematography = "cinematography",
    Performance = "performance",
    Sound = "sound",
    Generation = "generation",
}

export const productionBibleSections = [
    { key: ProductionBibleSection.Settings, label: "世界观与规则", step: "assets.settings", scope: "时代地域、世界规则、能力边界、组织和术语" },
    { key: ProductionBibleSection.StoryContinuity, label: "人物关系与时间线", step: "assets.settings", scope: "人物身份别名、关系、事件顺序、空间关系与不可变事实" },
    { key: ProductionBibleSection.Style, label: "全局视觉风格", step: "assets.style", scope: "画风、色彩、光影、质感和视觉母题" },
    { key: ProductionBibleSection.ArtDirection, label: "美术与服化道", step: "assets.style", scope: "建筑空间、服装妆发、道具材质和标志符号的共用基准，不代替逐资产条目" },
    { key: ProductionBibleSection.Cinematography, label: "摄影与剪辑", step: "assets.style", scope: "构图、景别、轴线、镜头运动、节奏和转场，不提前编造镜头表" },
    { key: ProductionBibleSection.Performance, label: "表演与配音", step: "assets.style", scope: "表演尺度、对白节奏、声线一致性、口音和情绪边界，具体人物声线仍放人物资产" },
    { key: ProductionBibleSection.Sound, label: "音乐与环境声音", step: "assets.style", scope: "配乐母题、环境声层次、标志音效、声音空间及混音原则" },
    { key: ProductionBibleSection.Generation, label: "生成与一致性约束", step: "assets.style", scope: "共用正负提示词、参考资产规则、跨集不变项和质量检查，不虚构模型参数或已完成的媒体" },
] as const;

export const productionBibleKeys = productionBibleSections.map((section) => section.key);
export const legacyProductionBibleKeys = [ProductionBibleSection.Settings, ProductionBibleSection.Style];
export const productionBibleInstruction = productionBibleSections.map((section) => `${section.key}（${section.label}）：${section.scope}`).join("；");
export function productionBibleSection(key: unknown) {
    return productionBibleSections.find((section) => section.key === key);
}
