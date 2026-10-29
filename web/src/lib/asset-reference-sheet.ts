import { normalizeImageValue, type ImageCapabilityConfig } from "./model-capabilities";
import { applyProductionRules } from "./production-rules";
import { assetSheetSubjectMaterial } from "./asset-sheet-material";
import { ShortDramaStep, type ShortDramaStepId } from "./short-drama-steps";

export enum AssetSheetKind {
    Character = "character", Environment = "environment", Prop = "prop", Special = "special",
}

export type AssetSheetContract = {
    version: 1 | 2 | 3 | 4;
    kind: AssetSheetKind;
    size: string;
    styleSignatures: Record<string, string>;
    promptFingerprint?: string;
    title?: string;
    code?: string;
    dimensions?: string[];
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
    [AssetSheetKind.Character]: "左侧窄栏从上至下排角色半身肖像、姓名、年龄/身高/体重/三围等已有资料、简短人物简介和关键词。右侧上方占主要面积，四个等宽竖栏依次为正面全身、左侧全身、右侧全身、背面全身；人物完整站立，脚底基线对齐，四视图为同一人、同一年龄、同一固定服装与妆发。身高线必须从脚底基线延伸到头顶最高点，端点贴合头顶与地面，不从颈部或发梢起止；身高数值按档案原值显示，头发、帽子、鞋底和鞋跟不计入净身高，无法判断端点时标注‘示意/待测量’。右侧下方横向分三栏：服装拆解、关键道具、面部及辨识特征细节。",
    [AssetSheetKind.Environment]: "左侧窄栏从上至下排场景等距轴测小图、场景名称、出现集数、空间简介、长宽高/面积等已有尺寸和关键词。右侧上方横向依次为主视角（略宽）、正立面、侧剖面、俯视平面，四个区域清楚标注；这些图必须是同一个世界坐标场景的投影，门窗、墙角、家具、出入口和固定道具的中心坐标、占地尺寸、离墙距离与朝向一致，只允许相机位置、遮挡和可见面改变。右侧下方横向依次为带尺寸线的空间拆解轴测图、带箭头的动线平面图、关键道具展示、材质细节与色板。",
    [AssetSheetKind.Prop]: "左侧窄栏排道具主视图、名称、已有外形尺寸、档案用途和关键词。右侧上方四个等宽视图依次为正面、侧面、背面、三分之四视角；右侧下方展示外表面与材质细节、外部附件或装饰、固定标记和颜色/磨损细节。同一道具的比例、可见外形和材质一致，不虚构内部结构或使用状态。",
    [AssetSheetKind.Special]: "左侧窄栏排资产主视图、名称、用途、触发条件和关键词。右侧上方按资产类型展示四个视图或已定义状态；右侧下方展示构成、材质、纹理或光效细节。只呈现档案中已定义的内容，不补造状态。",
};

export function assetSheetLayoutInstruction(kind: AssetSheetKind, size = "横向") {
    const frame = kind === AssetSheetKind.Character
        ? "左侧资料栏约占整幅宽度 18%；右侧上方四视图约占高度 62%，下方三组拆解与细节约占高度 34%。"
        : kind === AssetSheetKind.Environment
            ? "左侧资料栏约占整幅宽度 17%；右侧上方四视图约占高度 50%，下方空间拆解、动线、道具及材质约占高度 47%。"
            : "左侧资料栏约占整幅宽度 17%；右侧主体上方为四视图，下方为外观附件与表面细节区域。";
    return [
        `只生成一张完整的横向资产设定板，画幅 ${size}。`,
        "版式参考用户提供的设定板：浅暖灰/象牙白纸面底色、完整细灰褐色外框、清晰细分隔线、每个区域顶部有简洁矩形中文标签；左侧资料栏，右侧规整的多区域图文版面，留白克制、信息层级清楚，整体像专业影视美术资产档案。参考图仅用于版式和信息层级，不复制其中人物、场景、道具或文字。具体插画/摄影质感、画面色彩与灯光遵循本项目视觉规范。",
        frame,
        `【区域布局】${views[kind]}`,
        "图像、边框、标题标签和资料文字必须在同一张完整成图里一次性生成；不要只画待裁切的视图原图，不要把图像切块、拼贴、重排或留待程序合成。不同区域之间保留清楚分隔，不互相覆盖。",
        "只写资产档案已有的名称、简短简介、关键词、尺寸和集数。已有物理尺寸需在对应栏位及视图中用简洁尺寸线准确标注；没有依据的数值标为‘待测量’或‘制作估算’，不得伪装成事实。中文只用简短标签，避免长段小字。",
    ].join("\n\n");
}

const characterPoseRules = [
    "【人物基准姿态与肢体】四视图采用同一空手中性站姿，双臂自然垂落；原设定的体态、肢体差异和必要辅助器具保留。手持道具独立陈列。若本次补充要求明确指定持物，仅使用这一种姿态并统一左右手分工。",
    "正常双臂人物每个全身视图只有两条手臂、两只手，手腕与前臂连接正确；侧面和背面允许自然遮挡，不补多余肢体。细节限于各自分格。",
].join("\n");

export function assetSheetPrompt(input: { kind: AssetSheetKind; size: string; title: string; content: string; style: string; projectSettings?: string; references?: string; instruction?: string; visualOnly?: boolean }) {
    return applyProductionRules([
        "生成完整资产设定板 v4。",
        input.projectSettings || "",
        "本次完整设定板版式优先于资产材料中的旧版式说明；画面主体风格遵循本项目视觉规范。",
        assetSheetLayoutInstruction(input.kind, input.size),
        "【跨视图尺寸基准】将档案明确的物理尺寸作为唯一标尺。人物共用身高、体重和三围；净身高测量端点固定为赤足脚底基线到头顶最高点，不能把发型、帽子、鞋底或鞋跟加进身高。场景统一长宽净高、面积及门窗/墙角坐标；道具统一长宽高/直径并以人物身高或手掌作比例参照。同一实体各视角只改变投影与遮挡，禁止改变真实尺寸、比例、结构和锚点位置。缺少的数值必须明确标为‘待测量’或‘制作估算’，所有视图共用同一组数值。",
        input.kind === AssetSheetKind.Character ? "【人物身份与脸部基准】左侧半身肖像是唯一高分辨率脸部身份基准。四视图只沿用同一张脸的骨骼比例、眼鼻口相对位置、发际线、耳形、肤色、年龄感和不对称辨识点；四视图中的小脸是服装/体态校对用的低优先级示意，不得被当作第二个角色或与肖像平均融合。不要为了排版重新设计、镜像复制或模糊改变脸部；若小脸无法清晰表现，保持简化轮廓并在栏位标注‘脸部以左侧肖像为准’。" : "",
        input.kind === AssetSheetKind.Environment ? "【场景固定布局基准】先建立一张带原点、X/Y方向和比例尺的主平面图，再由同一套坐标投影生成主视角、立面、剖面和轴测图。为每件固定物保留唯一编号、中心点/锚点、占地长宽、离墙距离和世界朝向；不得为了构图移动、缩放、镜像、旋转或重新摆放。标注‘总高’与‘屋脊相对檐口的起升高度’时分开书写，禁止把两者相加后重复标注。" : "",
        input.visualOnly ? "本次仅表现静态外观与表面材质，保留真实名称和身份。" : "",
        `【资产事实与提示词】\n名称：${input.title}\n${assetSheetSubjectMaterial(input.content, input.kind)}`,
        input.references ? `【明确引用的其他资产】\n${input.references}` : "",
        "【本项目统一制作规范】\n" + input.style,
        input.instruction?.trim() ? `【本资产补充细节】\n${input.instruction.trim()}` : "",
        input.kind === AssetSheetKind.Character ? characterPoseRules : "",
        "【本次画面范围】仅表现当前资产的静态外观设定；资料中的剧情事件、操作步骤与其他资产只作背景，不转成动作演示或新增画面主体。保留真实名称、身份、时代、外部轮廓、材质和配色。",
        input.kind === AssetSheetKind.Prop ? "【道具展示边界】四视图与细节区统一展示同一件静态资产，附件独立陈列，细节区只放外表面特写。尺寸线用于整体外形长宽高、外径和摆放比例校对，不生成内部剖视、加工公差、制造改装过程或操作教程。涉及武器或危险物件时，准确保留历史或虚构题材中的名称、身份与时代，只呈现静态外观、表面材质、装饰及必要外形尺寸；不展示操作、发射、伤害效果、弹药或内部机构，也不把真实物件虚称为无功能模型。此边界优先于材料中的旧拆解或操作版式要求，不改写资产档案事实。" : "",
        "所有区域须直接绘制在同一张完整设定板中，输出完整成图而非原始视图素材。统一各视图身份、结构、配色和光照；不要遗漏资料栏、分类标题、尺寸线、动线图或材质信息。",
    ].filter(Boolean).join("\n\n"), "assets", "image");
}
