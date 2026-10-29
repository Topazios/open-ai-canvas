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
    { kind: PlannedAssetKind.Sound, prefix: "AUD", label: "声音" },
] as const;
export type ProductionAssetIdentity = { id: string; code: string; kind: `${PlannedAssetKind}` };
export const unifiedProductionPlanInstruction = "制作方案严格按顺序完成：1. 故事总纲与世界规则，结局遵循全局设置与用户要求；按项目参数为每集建立一行规划骨架，覆盖剧情任务、开场承接、目标阻力、关键行动、因果结果与代价、信息/关系/情绪变化、人物与资产状态、集尾收束、下集承接及符合项目时长的内容覆盖；不以固定悬念、反转或节奏模板替代题材适配；2. 全剧资产清单与系统编码，登记名称、剧情功能及计划篇章或集段，精确出场集数未定时不编造；逐章节和逐集核对配角群体、画外人物、必要空间器物及状态，记录原文证据、登记归属或不单建理由，完成清单后再进入后续阶段；3. 视觉与美术规范、导演与视听规范并行完成；4. 根据总纲、清单、美术与导演规范完成生成与一致性规范，先定义执行和验收规则，不等待尚未制作的资产档案；5. 校验公共文稿、固定字段完整性、编码引用和跨文稿连续性，完成制作方案并停止。逐集骨架是规划与覆盖检查，不代表正文已完成，也不替代对人物动机、剧情因果和题材兑现的语义审读。方案阶段仅登记资产总表，不创建资产分组或独立资产档案。只有方案全部完成且用户手动点击生成资产后，才按清单并发制作人物、场景、道具与独立声音资产档案，有设计依赖的资产等待对应前置档案。提示词用 @编码 引用；只有需要独立参考图或独立资产码的重大形态、结构、身份变化才登记为变体，疲惫、受伤、污渍、湿润、开关灯、日夜天气、持物、开合、运行、位置和普通换装写入正文与连续性。个人声线以CHR编码回指人物档案；仅独立复用的声音才登记AUD，参数和试听沿用所属档案及实际媒体。资产总表、造型转换表和声音总表收纳于现有公共规范与资产档案，不另建重复节点。四份共用文稿各保存一份，无需额外确认。" + productionContinuityInstruction;

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
    baseKey?: string;
    stateName?: string;
    indexContent?: string;
};

export const productionPlanInstruction = `${unifiedProductionPlanInstruction}\n资产清单覆盖配角、群演类别和画外音人物。后续用户手动启动的资产阶段，每项资产按系统提供的固定字段模板完整填写，不合并、不遗漏字段，不适用字段注明理由。人物必须包含性格、欲望恐惧、关系弧光、外貌服化与声音（音色、音域、语速、口音、表演边界、配音提示词）；场景包含布局、出入口、材质、日夜与环境声；道具包含用途、归属交接与状态链；独立声音资产包含用途、声音特征与使用边界。不单列特殊资产：能力和变身归人物，空间转换与天气归场景，界面符号与器物归道具；无实体世界机制写入总纲，效果表现写入视觉规范。重大形态、结构或身份变化如果需要独立参考图，应在总清单作为同 kind 的独立资产，填写 baseKey 和 stateName；资产档案不再把此类重大形态登记到共用主体的 variants。疲惫、受伤、污渍、湿润、光照、日夜天气、持物、开合、运行、位置和普通服装切换只写正文、continuity 或镜头状态。无某类资产时说明理由，不为凑数虚构。手动启动资产阶段后，系统将人物、场景、道具、声音与公共方案文稿分别分组；每项保存独立文本节点，不因单文件长度省略内容。四份公共文稿内补齐规则表、连续性状态账、视听执行单、下游交接与验收表，不增加规范节点。方案完成后停止，不自动制作资产。区分已定选题信息和创作设计，预计出场不冒充正文证据，文稿不代表媒体已生成。`;

export const plannedAssetReuseInstruction = "沿用制作方案资产的稳定编号、身份、性格、声音、外观和空间规则；正文负责剧情扩写与资产应用，不能重新设计同名资产。集纲逐集列出实际使用的资产编号和状态变化。正文明确引用所用编号，新增资产或超出预计出场范围的应用单列补充说明。后续资产拆分在方案设定基础上核对正文实际出场、变化和新增项，保留原编号，区分计划、正文证据与设计建议。" + productionContinuityInstruction;
