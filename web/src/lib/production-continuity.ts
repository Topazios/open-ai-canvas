// Entity identity, appearance state and document revision have separate lifetimes.
export enum AssetStateSource {
    Script = "script",
    Design = "design",
}

export const assetStateSourceOptions = [
    { value: AssetStateSource.Script, label: "故事明确" },
    { value: AssetStateSource.Design, label: "制作设计补充" },
];

export type ProductionAssetVariant = {
    code?: string;
    name: string;
    description: string;
    source?: AssetStateSource;
    basis?: string;
    trigger?: string;
    previousState?: string;
    scope?: string;
    recovery?: string;
};

export const assetStateTextFields = ["basis", "trigger", "previousState", "scope", "recovery"] as const;
export const assetStateFieldLabels: Record<typeof assetStateTextFields[number], string> = {
    basis: "来源依据", trigger: "触发事件", previousState: "前置状态", scope: "生效范围", recovery: "结束或恢复条件",
};

export function assetVariantMaterial(variant: ProductionAssetVariant) {
    return [variant.code ? `@${variant.code}` : "", variant.name, variant.description,
        variant.source ? `来源：${assetStateSourceOptions.find(option => option.value === variant.source)?.label}` : "",
        ...assetStateTextFields.map(key => variant[key]?.trim() ? `${assetStateFieldLabels[key]}：${variant[key]}` : ""),
    ].filter(Boolean).join("；");
}

export function validateAssetVariant(variant: ProductionAssetVariant) {
    if (!variant.name.trim() || !variant.description.trim()) throw new Error("状态变体需填写名称和外观变化");
    if (!isMajorAssetVariant(variant)) throw new Error("只有形态、结构或身份发生重大变化且需要独立参考图的状态才能登记为变体；普通服装、伤势、污渍、情绪、光照等写入资产连续性");
    if (variant.source === undefined) return;
    if (!Object.values(AssetStateSource).includes(variant.source)) throw new Error("状态来源无效");
    for (const key of assetStateTextFields) if (!variant[key]?.trim()) throw new Error(`状态“${variant.name}”缺少${assetStateFieldLabels[key]}`);
}

const majorAssetVariantPattern = /变身|变形|兽化|机械化|赛博化|非人形|物种变化|物种转换|身份转换|年龄阶段变化|显著老化|返老还童|体型突变|巨人化|缩小化|结构重构|拓扑重构|完全重构|结构完全改变|形态完全改变|建筑完全改变|场景完全改变|transformation|werewolf|mecha|可独立参考图/iu;

export function isMajorAssetVariant(variant: Pick<ProductionAssetVariant, "name" | "description">) {
    return majorAssetVariantPattern.test(`${variant.name} ${variant.description}`);
}

export const productionContinuityInstruction = "实体编号、状态变体编号和文稿修订版独立管理。变体只用于资产本身发生重大形态、结构或身份变化，且变化后需要独立参考图、独立制作约束或独立资产码才能稳定复用；变身、兽化、机械化、显著年龄或体型形态变化，以及场景拓扑或道具结构完全改变，可以登记为变体。疲惫、情绪、普通受伤、包扎、血迹、灰尘、污渍、湿润、轻微破损、普通换装、持物、开合、运行、位置、日夜、天气、开关灯和光照变化，都写入资产正文、continuity、镜头起止状态、动作/表演描述或提示词，不创建V编码；没有形态级变化时 variants 必须为空。集纲和正文以已登记的 @资产编号落实这些普通连续性状态；尚未分配的重大形态变体用基础码加状态名规划，不编造V编号。人物关系先登记 REL-编号、主体、客体、关系类型、方向、规范称呼、来源和适用范围；按已登记的同一主体、客体、关系及方向核对，保留双方原文证据与适用范围。简称、语言差异、对白称呼及其他人物用词不单独构成冲突，关键词只作待核候选；无法确定关系双方或语义时标明待核，不凭词面改事实，有证据的冲突在原节点诊断。重大形态变化须有故事事件或明确制作设计依据、前态、触发、后态、生效范围及结束/恢复条件；日常、工作、礼仪、旅行等活动切换只记录连续性，不强制安排换衣镜头。不可逆变化不能在切镜或跨集后自动恢复，同一事件的发生集次保持唯一，时间收支须可核算。场景固定尺寸、布局、门窗与地标，道具固定物理尺寸及相对人物的尺度；景别和视角只改变透视投影与遮挡，不改变物理世界。人物声线以CHR编码回指人物档案，不强制另建AUD；独立复用声音才以已登记AUD引用。声音只有变成需要独立复用的全新声源或制作形态时才登记变体，情绪、音量、语速和场景适配写入表演或声音提示。关联主体与设计依赖分开声明，声音指令不得进入生图请求，声音制作不以图像参考为前置。无需人工确认，完成即可供后续使用；修改只影响后续新任务，保留旧结果与来源版本。";
