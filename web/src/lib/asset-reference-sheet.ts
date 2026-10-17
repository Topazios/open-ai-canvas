import { normalizeImageValue, type ImageCapabilityConfig } from "./model-capabilities";
import { applyProductionRules } from "./production-rules";
import { assetSheetSubjectMaterial } from "./asset-sheet-material";
import { ShortDramaStep, type ShortDramaStepId } from "./short-drama-steps";

export enum AssetSheetKind {
    Character = "character", Environment = "environment", Prop = "prop", Special = "special",
}

export type AssetSheetContract = {
    version: 1;
    kind: AssetSheetKind;
    size: string;
    styleSignatures: Record<string, string>;
    promptFingerprint?: string;
};

export function assetSheetKind(step: ShortDramaStepId): AssetSheetKind | undefined {
    return ({
        [ShortDramaStep.CharacterReferences]: AssetSheetKind.Character,
        [ShortDramaStep.EnvironmentReferences]: AssetSheetKind.Environment,
        [ShortDramaStep.PropReferences]: AssetSheetKind.Prop,
        [ShortDramaStep.SpecialReferences]: AssetSheetKind.Special,
    } as Partial<Record<ShortDramaStepId, AssetSheetKind>>)[step];
}

export function assetReferenceStep(step: ShortDramaStepId): ShortDramaStepId | undefined {
    if (assetSheetKind(step)) return step;
    return ({
        [ShortDramaStep.Characters]: ShortDramaStep.CharacterReferences,
        [ShortDramaStep.Environments]: ShortDramaStep.EnvironmentReferences,
        [ShortDramaStep.Props]: ShortDramaStep.PropReferences,
        [ShortDramaStep.Special]: ShortDramaStep.SpecialReferences,
    } as Partial<Record<ShortDramaStepId, ShortDramaStepId>>)[step];
}

export function assetSheetRatio(size: string) {
    const match = size.trim().match(/^(\d+)\s*[x:×]\s*(\d+)$/i);
    if (!match) return 0;
    const [width, height] = match.slice(1).map(Number);
    return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0 ? width / height : 0;
}

function customSheetSize(size: string, parameter: ImageCapabilityConfig["size"]["parameter"]) {
    const [width, height] = size.split(/[x:×]/i).map(Number);
    let a = width, b = height;
    while (b) [a, b] = [b, a % b];
    const w = width / a, h = height / a;
    if (parameter === "aspect_ratio") return `${w}:${h}`;
    if (/[x×]/i.test(size)) return size;
    const unit = Math.ceil(1024 / (h * 64)) * 64;
    return `${w * unit}x${h * unit}`;
}

// Prefer declared model sizes; do not send a reference PNG's dimensions blindly.
export function assetSheetImageSettings(profile: ImageCapabilityConfig, values: Parameters<typeof normalizeImageValue>[1], lockedSize?: string) {
    const target = lockedSize ? assetSheetRatio(lockedSize) : 16 / 9;
    if (target <= 1) throw new Error("已有设定板画幅无效，请检查图片规格");
    const sizes = [...new Set([
        ...profile.size.values,
        ...(profile.size.presets || []).map((preset) => profile.size.parameter === "aspect_ratio" ? preset.ratio : preset.size),
    ])].filter((size) => assetSheetRatio(size) > 1);
    if (profile.size.allowCustom && !sizes.some((size) => Math.abs(assetSheetRatio(size) / target - 1) < 0.025)) {
        sizes.push(customSheetSize(lockedSize || "16:9", profile.size.parameter));
    }
    const size = sizes.sort((a, b) => Math.abs(assetSheetRatio(a) - target) - Math.abs(assetSheetRatio(b) - target))[0];
    if (profile.size.parameter === "none" || !size || (lockedSize && Math.abs(assetSheetRatio(size) / target - 1) >= 0.025)) {
        throw new Error(lockedSize ? `当前模型不支持已有设定板画幅（${lockedSize}），请选择支持同一横向画幅的生图模型` : "当前模型不支持横向设定板，请选择支持横向画幅的生图模型");
    }
    return normalizeImageValue(profile, { ...values, size, count: "1", transparentBackground: "false" });
}

const views: Record<AssetSheetKind, string> = {
    [AssetSheetKind.Character]: "从左到右：正面全身、左侧全身、右侧全身、背面全身；同一基准年龄、服装和妆发，统一身高比例与脚底基线。下方独立陈列服装及随身物件，展示脸部、发型、衣料或饰品的2至4处细节。",
    [AssetSheetKind.Environment]: "从左到右：主视角全景、正立面、侧剖面、俯视平面布局；同一空间、同一时间天气，门窗、通道与陈设位置对应。下方展示材质和光源的2至4处细节。",
    [AssetSheetKind.Prop]: "从左到右：正面、侧面、背面、三分之四视角；同一道具保持形状、比例和材质一致。下方展示表面纹理、磨损和标记的2至4处细节，不虚构内部结构。",
    [AssetSheetKind.Special]: "按实际类型排列四格：实体为正面/侧面/背面/三分之四视角，界面为整体/构成/局部/应用，特效为已定义的基准/触发/持续/消退状态。下方展示材质、纹理或光效细节，未定义状态不补造。",
};

const characterPoseRules = [
    "【人物基准姿态与肢体】四视图采用同一空手中性站姿，双臂自然垂落；原设定的体态、肢体差异和必要辅助器具保留。手持道具独立陈列。若本次补充要求明确指定持物，仅使用这一种姿态并统一左右手分工。",
    "正常双臂人物每个全身视图只有两条手臂、两只手，手腕与前臂连接正确；侧面和背面允许自然遮挡，不补多余肢体。细节限于各自分格。",
].join("\n");

export function assetSheetPrompt(input: { kind: AssetSheetKind; size: string; title: string; content: string; style: string; projectSettings?: string; references?: string; instruction?: string; visualOnly?: boolean }) {
    const exteriorProp = input.kind === AssetSheetKind.Prop && /枪械|步枪|手枪|猎枪|枪支|firearm|rifle|pistol/i.test(input.title);
    return applyProductionRules([
        "生成一张完整的资产设定板图片，不输出文字报告。以下使用统一设定板模板 v1。",
        input.projectSettings || "",
        "本模板的版式规则优先于材料中的旧版式要求；画风遵循本项目视觉设定。",
        `【统一版式】横向画幅 ${input.size}，一个资产的同一基准版本。浅中性不透明底板，四周留白约3%，细分隔线，等宽间距。左侧占18%为资料栏，右侧占82%为图像区。`,
        "左栏依次放主体缩略图、名称、简短身份或用途、三个视觉关键词；右上65%为四个等宽视图，右下35%为外观与材质细节。中文短标签清晰，无水印。",
        `【分类视图】${views[input.kind]}`,
        exteriorProp ? "影视美术道具仅展示不具备发射功能的模型外观，不提供内部结构、拆装或制造细节。" : "",
        input.visualOnly ? "本次仅表现静态外观与表面材质，保留真实名称和身份。" : "",
        `【资产事实与提示词】\n名称：${input.title}\n${assetSheetSubjectMaterial(input.content, input.kind)}`,
        input.references ? `【明确引用的其他资产】\n${input.references}` : "",
        "【本项目统一制作规范】\n" + input.style,
        input.instruction?.trim() ? `【本资产补充细节】\n${input.instruction.trim()}` : "",
        input.kind === AssetSheetKind.Character ? characterPoseRules : "",
        "统一各视图的身份、结构、配色和光照，主体完整，分格不重叠；说明文字不绘入画面。",
    ].filter(Boolean).join("\n\n"), "assets", "image");
}
