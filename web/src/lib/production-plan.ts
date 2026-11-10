import { productionContinuityInstruction } from "./production-continuity";

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
    Generation = "generation",
    Assets = "assets",
    Validation = "validation",
}
export const productionPlanPhaseLabels: Record<ProductionPlanPhase, string> = {
    [ProductionPlanPhase.Input]: "读取选题",
    [ProductionPlanPhase.Story]: "故事总纲与世界规则",
    [ProductionPlanPhase.Inventory]: "资产清单与编码",
    [ProductionPlanPhase.Standards]: "视觉与导演规范",
    [ProductionPlanPhase.Generation]: "生成与一致性规范",
    [ProductionPlanPhase.Assets]: "逐项资产档案",
    [ProductionPlanPhase.Validation]: "完整性校验",
};
export const productionPlanSections = [
    { key: ProductionPlanSection.Story, label: "故事总纲与世界规则" },
    { key: ProductionPlanSection.Visual, label: "视觉与美术规范" },
    { key: ProductionPlanSection.Direction, label: "导演与视听规范" },
    { key: ProductionPlanSection.Generation, label: "生成与一致性规范" },
] as const;
export const storyPlanInstruction = "本次仅生成并保存故事总纲与世界规则，完成后结束本步骤。结局遵循全局设置与用户要求；按项目参数为每集建立规划骨架，覆盖剧情任务、开场承接、目标阻力、关键行动、因果结果与代价、信息/关系/情绪变化、人物与资产状态、集尾收束和下集承接，内容体量符合项目时长。不以固定悬念、反转或节奏模板替代题材适配。规划骨架不代表正文已完成。仅使用本次选题与全局设置，区分来源事实和创作设计。资产清单、美术、导演、生成规范与资产档案由用户后续分别启动；本次不执行这些任务，不启动纠正、修正或问题分析调用。";
export const productionAssetKinds = [
    { kind: PlannedAssetKind.Character, prefix: "CHR", label: "人物" },
    { kind: PlannedAssetKind.Environment, prefix: "SCN", label: "场景" },
    { kind: PlannedAssetKind.Prop, prefix: "PRP", label: "道具" },
    { kind: PlannedAssetKind.Special, prefix: "SPC", label: "特殊资产" },
    { kind: PlannedAssetKind.Sound, prefix: "AUD", label: "声音" },
] as const;
export type ProductionAssetIdentity = { id: string; code: string; kind: `${PlannedAssetKind}` };
export const unifiedProductionPlanInstruction = "按当前制作模板完成总纲：主线与结局只交代一次，单元走向承接人物选择和因果；每集只写事件、结果变化、伏笔衔接，不代写完整分集大纲或正文。不套固定悬念和反转模板。先登记人物、场景、道具、特殊资产及声音五类主要身份，再按单元补必要配角、群体、空间、操作物件和声音；名称、别名、简介、用途和计划范围逐项明确，不按数量凑数。同一主体跨单元复用，不同归属或重大形态需在名称中区分；普通服装、表情、天气和损毁状态写连续性，独立重大形态关联基础身份。总表由登记和分集引用汇总，不再提取一遍总纲。独立视觉效果用SPC，个人声线回指CHR，独立复用声音用AUD并关联声源。总纲完成后停止；用户启动其他规范或资产时只执行所选范围。资产容器先创建，再准备清单和档案占位，按真正设计前置并发执行；普通归属不构成等待依赖。资产缺少原文规格时补充合理制作设定并注明来源，不留未知、待定。保存前核对任务主体与正文姓名、编码一致，提示词用 @编码 引用。普通重试复用完成稿，主动新版保留旧稿；旧媒体引用不随当前采用版本变化。" + productionContinuityInstruction;

export type PlannedAsset = {
    key: string;
    kind: `${PlannedAssetKind}`;
    name: string;
    /** Category-local importance rank; 1 is the primary asset. */
    priority?: number;
    episodes: number[];
    purpose?: string;
    plannedRange?: string;
    dependsOn?: string[];
    subjectKeys?: string[];
    parentKey?: string;
    quantity?: number;
    aliases?: string[];
    coreFacts?: string;
    variants?: string;
    origin?: string;
    usage?: { range: string; purpose: string }[];
    baseKey?: string;
    stateName?: string;
    indexContent?: string;
};

export const productionPlanInstruction = `${unifiedProductionPlanInstruction}\n资产清单覆盖配角、群演类别和画外音人物。后续用户手动启动的资产阶段，每项资产按系统提供的固定字段模板完整填写，不合并、不遗漏字段，不适用字段注明实体理由。人物包含身份关系、欲望恐惧、外貌服化、行为和声线；场景包含布局尺度、坐标出入口、固定陈设、动线、日夜与环境声；道具包含尺寸重量、持握交互、结构、归属交接和状态链；声音包含独立声源、用途、声音特征与使用边界。特殊资产仅登记需独立制作复用且无普通实体可承载的视觉效果，明确触发条件、载体、空间范围和消散状态，不重复登记已有主体。能力规则写入总纲，人物形态归人物，天气和空间结构归场景，有形器物和界面载体归道具。资产别名、同款数量、组成归属、重大形态与文稿修订分别记录；有明确别名证据才复用同一主体，不因相同职业、功能或外观就合并。同一人物正脸只有一个身份基准，其他视图必须是同一主体。重大形态需要独立参考图时作为同kind的独立资产，填写baseKey和stateName；普通服装、情绪、污损、日夜、持物、开合和运行只写连续性状态。关联声源、人物、空间或道具用subjectKeys，确实需要先完成设计才填写dependsOn，不能把归属与摆放关系变成生成依赖。缺少规格时按时代、身份和剧情补齐制作设定，不反复使用没有正文依据代替设计，也不冒充原文事实。各类资产与公共文稿分别分组，每项保存独立节点。四份公共文稿内补齐规则、连续性、视听执行和交接验收，不增加重复节点。方案完成后停止，资产由用户后续启动。`;

export const plannedAssetReuseInstruction = "沿用制作方案资产的稳定编号、身份、性格、声音、外观和空间规则；正文负责剧情扩写与资产应用，不能重新设计同名资产。集纲逐集列出实际使用的资产编号和状态变化。正文明确引用所用编号，新增资产或超出预计出场范围的应用单列补充说明。后续资产拆分在方案设定基础上核对正文实际出场、变化和新增项，保留原编号，区分计划、正文证据与设计建议。" + productionContinuityInstruction;
