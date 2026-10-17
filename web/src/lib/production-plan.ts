export enum PlannedAssetKind {
    Character = "character",
    Environment = "environment",
    Prop = "prop",
    Special = "special",
    Sound = "sound",
}

export enum ProductionPlanSection {
    Story = "story", Inventory = "inventory", Visual = "visual", Direction = "direction", Generation = "generation",
}
export enum ProductionPlanPhase {
    Input = "input",
    Story = "story",
    Inventory = "inventory",
    Standards = "standards",
    Assets = "assets",
    Generation = "generation",
    Validation = "validation",
}
export const productionPlanPhaseLabels: Record<ProductionPlanPhase, string> = {
    [ProductionPlanPhase.Input]: "读取选题",
    [ProductionPlanPhase.Story]: "故事总纲与世界规则",
    [ProductionPlanPhase.Inventory]: "资产清单与编码",
    [ProductionPlanPhase.Standards]: "视觉与导演规范",
    [ProductionPlanPhase.Assets]: "逐项资产档案",
    [ProductionPlanPhase.Generation]: "生成与一致性规范",
    [ProductionPlanPhase.Validation]: "完整性校验",
};
export const productionPlanSections = [
    { key: ProductionPlanSection.Story, label: "故事总纲与世界规则" },
    { key: ProductionPlanSection.Visual, label: "视觉与美术规范" },
    { key: ProductionPlanSection.Direction, label: "导演与视听规范" },
    { key: ProductionPlanSection.Generation, label: "生成与一致性规范" },
] as const;
export const productionAssetKinds = [
    { kind: PlannedAssetKind.Character, prefix: "CHR", label: "人物" },
    { kind: PlannedAssetKind.Environment, prefix: "SCN", label: "场景" },
    { kind: PlannedAssetKind.Prop, prefix: "PRP", label: "道具" },
    { kind: PlannedAssetKind.Sound, prefix: "AUD", label: "声音" },
] as const;
export type ProductionAssetIdentity = { id: string; code: string; kind: `${PlannedAssetKind}` };
export const unifiedProductionPlanInstruction = "制作方案严格按顺序完成：1. 故事总纲与世界规则，结局遵循全局设置与用户要求；2. 全剧资产清单与系统编码，登记名称、剧情功能及计划篇章或集段，精确出场集数未定时不编造，完成清单后再进入后续阶段；3. 视觉与美术规范、导演与视听规范；4. 按清单逐项保存人物、场景、道具与独立声音资产档案，并按设计依赖等待前置档案；5. 基于全部资产档案完成生成与一致性规范；6. 校验清单覆盖、固定字段完整性、编码引用和跨文稿连续性。提示词用 @编码 引用，服装与状态作为变体，个人声线以人物档案为主。四份共用文稿各保存一份，无需额外确认。";

export type PlannedAsset = {
    key: string;
    kind: `${PlannedAssetKind}`;
    name: string;
    episodes: number[];
    purpose?: string;
    plannedRange?: string;
    dependsOn?: string[];
    indexContent?: string;
};

export const productionPlanInstruction = `${unifiedProductionPlanInstruction}\n资产清单覆盖配角、群演类别和画外音人物。每项资产按系统提供的固定字段模板完整填写，不合并、不遗漏字段，不适用字段注明理由。人物必须包含性格、欲望恐惧、关系弧光、外貌服化与声音（音色、音域、语速、口音、表演边界、配音提示词）；场景包含布局、出入口、材质、日夜与环境声；道具包含用途、归属交接与状态链；独立声音资产包含用途、声音特征与使用边界。不单列特殊资产：能力和变身归人物，空间转换与天气归场景，界面符号与器物归道具；无实体世界机制写入总纲，效果表现写入视觉规范。所有资产含状态变体、可复用制作描述、禁止变化和连续性规则。无某类资产时说明理由，不为凑数虚构。系统将公共方案文稿与人物、场景、道具、声音分别分组；每项仍保存独立文本节点，不因单文件长度省略内容。四份公共文稿内补齐规则表、连续性状态账、视听执行单、下游交接与验收表，不增加规范节点。前置成果齐备后由系统并发制作独立文稿，有依赖的资产等待前置档案保存。区分已定选题信息和创作设计，预计出场不冒充正文证据，文稿不代表媒体已生成。`;

export const plannedAssetReuseInstruction = "沿用制作方案资产的稳定编号、身份、性格、声音、外观和空间规则；正文负责剧情扩写与资产应用，不能重新设计同名资产。集纲逐集列出实际使用的资产编号和状态变化。正文明确引用所用编号，新增资产或超出预计出场范围的应用单列补充说明。后续资产拆分在方案设定基础上核对正文实际出场、变化和新增项，保留原编号，区分计划、正文证据与设计建议。";
