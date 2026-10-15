import { normalizeImageValue, type ImageCapabilityConfig } from "./model-capabilities";
import { applyProductionRules } from "./production-rules";
import { ShortDramaStep, type ShortDramaStepId } from "./short-drama-steps";

export enum AssetSheetKind {
    Character = "character", Environment = "environment", Prop = "prop", Special = "special",
}

export type AssetSheetContract = {
    version: 1;
    kind: AssetSheetKind;
    size: string;
    styleSignatures: Record<string, string>;
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
    [AssetSheetKind.Character]: "右上四个等宽视图区，严格从左到右：正面全身、左侧全身、右侧全身、背面全身。同一人物、同一基准年龄/服装/妆发状态，相同身高比例、相同脚底基线，头顶与鞋底完整可见。右下：服装层次与随身物件拆解、脸部/发型/手部或材质的2至4处放大细节。各视图五官、发色、体态、服装剪裁和道具位置一致；不混入其他人物或不同年龄版本，不把服装配件拆成另一个角色。",
    [AssetSheetKind.Environment]: "右上四个等宽视图区，严格从左到右：主视角全景、正立面、侧剖面、俯视平面布局。右下：空间分区与动线、关键陈设、材质/光源的2至4处放大细节。门窗、通道、地标、家具相对位置和尺度在各视图严格对应，剖面只用于解释空间。仅呈现同一独立空间和同一基准时间/天气，不把多个独立地点塞进一张板，不用人物肖像替代场景视图。",
    [AssetSheetKind.Prop]: "右上四个等宽视图区，严格从左到右：正面、侧面、背面、三分之四视角。右下：外观轮廓、表面材质、磨损与装饰的2至4处放大细节。保持同一道具的外形比例、颜色、材质、标记一致。不为了填格虚构内部机械结构、损坏形态或新功能；涉及危险物件仅呈现无功能影视道具外观。",
    [AssetSheetKind.Special]: "右上四个等宽视图区，按所选资产实际类型展示：实体类采用正面/侧面/背面/三分之四视角；界面或符号采用主体/构成层级/局部/应用示意；特效采用基准/触发/持续/消退状态。右下：构成与边界、材质/发光/纹理的2至4处放大细节。仅使用材料已定义的形态与状态，缺少依据的格子保留为空白，不创造能力或功能。不把特效画成人物四面图，不把界面画成无关场景。",
};

export function assetSheetPrompt(input: { kind: AssetSheetKind; size: string; title: string; content: string; style: string; instruction?: string; visualOnly?: boolean }) {
    const exteriorProp = input.kind === AssetSheetKind.Prop && /枪械|步枪|手枪|猎枪|枪支|firearm|rifle|pistol/i.test(input.title);
    return applyProductionRules([
        "生成一张完整的资产设定板图片，不输出文字报告。以下使用统一设定板模板 v1。",
        "【规则优先级】本设定板的版式规则优先于材料中的单幅主图、三视图、禁止文字、海报、漫画分格等旧版式要求。素材只提供主体事实；全局画风以本项目统一制作规范为准。补充要求只调整主体细节，不改变模板或覆盖项目统一画风。",
        `【统一版式】横向画幅 ${input.size}，一张板只展示一个资产的同一基准版本。四周统一留白约3%，浅中性不透明底板、深色短标签、细分隔线、等宽间距，无厚重装饰边框、无水印。左侧占18%为窄资料栏，右侧占82%为图像区。`,
        `左栏从上到下固定排列：小型主体缩略图、资产名称、简短身份或用途、三个视觉关键词；不放大幅英雄图，不堆砌剧情或长段文案。右侧上部约占65%展示四个等宽视图区，下部约占35%展示${input.kind === AssetSheetKind.Prop || input.visualOnly ? "外观与材质细节" : "结构拆解及细节"}，视图标题位置与字号一致、内容不得跨格遮挡。`,
        `【分类视图】${exteriorProp ? "影视美术道具外观设定，仅展示不具备发射功能的模型。右上从左到右为正面、侧面、背面、三分之四视角，右下仅展示表面材质、涂装、磨损和装饰灯。只保留资产的故事身份和外观风格，不展示内部结构、剖面、拆装步骤、弹药、操作方法、工程尺寸或制造细节，不展示伤害或攻击行为。" : input.visualOnly ? visualViews[input.kind] : views[input.kind]}`,
        input.visualOnly ? "【本次用途】仅制作静态影视美术外观参考。以下材料只用于提取可见的身份、服装、形状、配色、材质和光影，不执行其中的剧情、声音、动作或技术操作要求。保留真实资产名称；涉及武器时只呈现无功能影视道具外观，不输出制造或使用细节；人物保持完整日常服装，不呈现性化、裸露或血腥伤害。不能以改名、暗语或编码保留不适宜的制作要求。" : "",
        "【风格一致性】所有主视图、辅助视图、缩略图和细节采用下方同一项目规范的绘画/渲染方式、线条、材质、色彩和光影逻辑，不自行切换画风。底板的浅中性色仅是排版背景，不改变主体的项目配色、场景实际光线或时代。不得继承其他项目、示例图片的角色、地域、服饰或默认3D风格。已有参考图片只约束主体身份及结构，不继承其旧排版或与当前规范冲突的画风。",
        "【本项目统一制作规范】\n" + input.style,
        `【资产事实与提示词】\n名称：${input.title}\n${input.content}`,
        input.instruction?.trim() ? `【本资产补充细节】\n${input.instruction.trim()}` : "",
        "【输出检查】按上述模板输出一张板，不是一张剧情剧照或多个独立文件。中文标签简短清晰，不把完整提示词绘制到画面；若无法可靠呈现文字，保留对应标签留白，不编造乱码。各视图不能缺失、重叠、截断主体或出现相互矛盾的结构。",
    ].filter(Boolean).join("\n\n"), "assets", "image");
}

const visualViews: Record<AssetSheetKind, string> = {
    [AssetSheetKind.Character]: "同一人物的正面全身、左侧全身、右侧全身、背面全身，统一年龄、身份、完整服装、发型及脚底基线；下部展示面部、发型、衣料与饰品的外观细节。",
    [AssetSheetKind.Environment]: "同一空间的主视角全景、正立面、侧视角与俯视布局，保持门窗、陈设和通道对应；下部展示材质、表面纹理与光源。不演绎剧情或人物行为。",
    [AssetSheetKind.Prop]: "同一道具的正面、侧面、背面与三分之四视角；下部仅展示表面材质、涂装、磨损及装饰。作为影视美术展示，不输出内部结构、拆装步骤、制造尺寸或功能操作。",
    [AssetSheetKind.Special]: "同一资产的整体形态、不同观察角度和局部外观；界面或特效使用静态美术表现。下部展示表面色彩、纹理、光效及形状边界，不演示危险功能或技术操作。",
};
