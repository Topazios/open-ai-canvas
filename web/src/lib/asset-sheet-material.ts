import type { AssetSheetKind } from "./asset-reference-sheet";

// Titles are the persisted level-two contract from productionRenderDocument.
// Recognize document schemas so unrelated metadata never falls back to full prose.
const documentMetadataFields = new Set([
    "人物身份与剧情功能", "性格特征、行为习惯与矛盾面", "欲望、目标、恐惧与行动动机",
    "人物经历与关键成因", "人物关系与关系弧光", "人物成长与阶段变化",
    "人物声线设计与声音资产引用", "声线音色、质感与辨识点", "音域、音高与共鸣位置",
    "语速、节奏、停顿与重音", "语言、口音与咬字习惯", "配音情绪范围与表演禁区", "可复用配音提示词",
    "环境声源、层次、混响与变化条件", "操作声、材质声与标志音效", "触发、持续、结束与标志声音",
    "人物创作设计与未定事项", "场景创作设计与未定事项", "道具创作设计与未定事项", "特殊资产创作设计与未定事项",
    "角色声音", "环境声音", "道具声音", "标志声音", "声音设计", "冲突与设计说明", "创作设计与未定事项",
    "视觉节奏与声音配合约束", "视觉创作设计与未定事项", "声音与表演约束", "声音美学",
    "参考图、镜头、视频与音频生成顺序", "视频时长、动作、运镜与首尾帧要求", "音频生成、声线引用与同步要求",
    "失败重试、局部修复与替代方案", "生成设计、能力假设与未定事项",
    "服化与情绪状态变体及启用条件", "重大形态、结构或身份变体及启用条件；普通服化与情绪写入正文连续性", "人物外观与声线禁止变化",
    "场景剧情功能与使用场次", "可用机位、遮挡与取景边界", "日夜、天气与陈设状态变体", "场景拓扑或结构重大变化；日夜、天气、光照与普通陈设写入连续性", "空间与陈设禁止变化",
    "道具剧情功能与使用方式", "初始归属、持有人与转移条件", "影视表现方式、外观状态切换与功能限制",
    "握持、佩戴与人物交互规则", "完好、损坏、消耗与修复状态", "道具结构或身份重大变化；普通损坏、消耗、开合与运行写入连续性", "道具形态与功能禁止变化",
    "特殊资产类别与剧情功能", "触发条件、使用者与解除条件", "能力表现、作用对象与范围",
    "能力边界、持续时间与失效条件", "使用代价、副作用与恢复条件", "启动、持续、衰减与失效形态", "特殊资产发生重大形态或结构变化；启动、持续、衰减与失效写入状态连续性", "特殊资产形态与能力禁止项",
    "声音编码、别名、选题依据与预计出场", "声音类别与独立复用目的", "关联人物、场景或道具编码",
    "声音核心设计与听觉辨识特征", "音色、频段、质感与声源构成", "节奏、速度、时长与循环规则",
    "情绪功能、强度与动态范围", "距离、方位、混响与空间层次", "触发、进入、退出与同步时点",
    "音量层级、对白避让与混音边界", "强弱、情绪与场景适配变体", "需要独立复用的全新声源或制作形态；强弱、情绪与场景适配写入声音提示", "声音生成提示词与声线复用要求",
    "声音禁止项与失真限制", "声音跨集复用与变化规则", "声音创作设计与未定事项",
]);

const visualFields: Record<AssetSheetKind, string[]> = {
    character: ["年龄感、体型、面部与辨识特征", "固定服装、配饰与材质配色", "发型、妆容与固定细节"],
    environment: ["地理位置、时代与建筑类型", "空间布局、尺度与固定陈设", "空间与陈设禁止变化", "出入口、通道与人物动线", "相邻空间、方位与视线关系", "建筑材质、表面质感与配色", "固定光源、日夜与天气光照"],
    prop: ["道具形状、尺寸、比例与辨识特征", "道具材质、工艺、配色与表面细节", "道具形态与功能禁止变化"],
    special: ["固定形态、尺度、材质与辨识特征", "特殊资产形态与能力禁止项", "特效颜色、运动、光照与空间影响"],
};
const legacyDocumentMetadataFields = new Set([
    "身份与正文依据", "资产身份与预计出场", "人物编码、别名、选题依据与预计出场", "场景编码、别名、选题依据与预计出场",
    "道具编码、别名、选题依据与预计出场", "特殊资产编码、别名、选题依据与预计出场",
    "生成提示词", "制作描述与提示词", "人物参考图生成提示词", "场景参考图生成提示词", "道具参考图生成提示词", "特殊资产生成提示词",
    "跨集连续性", "跨集应用规则", "人物跨集不变项与变化条件", "场景跨集固定项与状态衔接", "道具位置、归属与状态连续性", "特殊资产规则与状态连续性",
]);

const customVisualFields = ["外观", "外貌", "服装", "妆发", "材质", "配色", "空间布局", "光照", "补充外观约束", "用户新增外观约束", "用户补充"];
const legacyDesignFields = ["固定特征与制作设计", "性格功能与固定设定"];
const styleFields = ["整体视觉风格与媒介质感", "主辅色、角色色与禁用色", "光源方向、光比与日夜照明", "统一视觉风格", "风格提示词", "视觉与美术规范", "美术与服化道"];
const categoryStyleFields: Record<AssetSheetKind, string> = {
    character: "人物比例、服装与妆发规范", environment: "场景建筑、空间与陈设规范",
    prop: "道具尺度、材质与工艺规范", special: "状态变化与效果表现规范",
};
const documentMarkers = new Set([
    ...documentMetadataFields, ...legacyDocumentMetadataFields, ...Object.values(visualFields).flat(),
    ...legacyDesignFields, ...styleFields, ...Object.values(categoryStyleFields),
    "图像画幅、构图与清晰度要求", "生成依据与交付约束", "姿态、动作、表情与表演边界",
    "选题与项目约束", "正文风格依据", "视觉依据与项目约束", "视觉禁止项与负面提示词", "共用视觉生成提示词",
]);

function documentSections(content: string) {
    const sections: { title: string; lines: string[] }[] = [{ title: "", lines: [] }];
    let fence: { marker: string; length: number } | undefined;
    for (const line of content.split(/\r?\n/)) {
        const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
        if (delimiter) {
            if (!fence) fence = { marker: delimiter[1][0], length: delimiter[1].length };
            else if (delimiter[1][0] === fence.marker && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = undefined;
            sections[sections.length - 1].lines.push(line);
        } else if (!fence && line.startsWith("## ")) {
            sections.push({ title: line.slice(3).trim(), lines: [line] });
        } else sections[sections.length - 1].lines.push(line);
    }
    return sections;
}

function visualMaterial(content: string, fields: readonly string[]) {
    const sections = documentSections(content);
    // Free-form imported prompts have no field boundary to safely project.
    if (!sections.some(({ title }) => documentMarkers.has(title) || fields.includes(title))) return content.trim();
    return sections.filter(({ title }) => fields.includes(title))
        .map(({ lines }) => lines.join("\n").trim()).filter(Boolean).join("\n\n");
}

export function assetSheetSubjectMaterial(content: string, kind: AssetSheetKind) {
    const result = projectVisualMaterial(content, kind, false, true);
    if (!result.trim()) throw new Error("资产档案缺少可用于生图的外观设计，请补充外观、服化或空间材质信息");
    return result;
}

const referenceAppearanceFields = new Set([
    "固定服装、配饰与材质配色", "发型、妆容与固定细节", "固定光源、日夜与天气光照",
    "服装", "妆发", "光照",
]);

// These expressions classify field responsibilities, not facts in prose. In
// particular, a visual sentence mentioning a voice is not an audio field.
function visualFieldResponsibility(title: string, kind: AssetSheetKind, hasReference: boolean): boolean | undefined {
    if (hasReference && referenceAppearanceFields.has(title)) return false;
    if (visualFields[kind].includes(title) || legacyDesignFields.includes(title) || customVisualFields.includes(title)) return true;
    if (documentMarkers.has(title)) return false;
    if (/外观|外貌|体型|面部|辨识|形态|形状|尺寸|尺度|比例|身高|长度|宽度|高度|材质|工艺|配色|纹理|空间|布局|方位|视线|动线|出入口|陈设|物理|^(?:appearance|dimensions?|size|scale|material|layout|spatial)(?:\b|_)/iu.test(title)) return true;
    if (/^(?:声音|音频|音效|声线|音色|配音|口音|咬字|混响|语速|音域|音高|共鸣|语音|台词|对白|旁白|音乐|环境音效|环境音|声源|背景音乐|拟音|人声)(?:(?:设计|说明|档案|规范|要求|引用|参数|提示词|约束|样本|校准|轨道|表现|特征|范围)(?:补充)?)?$|^(?:audio|voice|sound|speech|dialogue|music)(?:[ _-]+(?:design|description|notes?|profile|reference|prompt|requirements?|effects?|instructions?))*$/iu.test(title)) return false;
    if (/^(?:身份|别名|编码|剧情|关系|经历|动机|性格|成长|预计出场|连续性|变体|启用条件|提示词|未定事项|生成顺序)(?:说明|摘要|设定|功能|补充|依据|信息|档案|要求|约束|设计|记录|梗概|概要|历程|变化|介绍)?$/u.test(title)) return false;
    return undefined;
}

function projectVisualMaterial(content: string, kind: AssetSheetKind, hasReference: boolean, preserveHeadings = false) {
    const structured = documentSections(content).some(({ title }) => documentMarkers.has(title));
    const output: string[] = [];
    const headings: { level: number; include: boolean; blocked: boolean }[] = [];
    let include = !structured;
    let fieldInclude = include;
    let fence: { marker: string; length: number } | undefined;
    for (const line of content.split(/\r?\n/)) {
        const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
        if (delimiter) {
            if (include && fieldInclude) output.push(line);
            if (!fence) fence = { marker: delimiter[1][0], length: delimiter[1].length };
            else if (delimiter[1][0] === fence.marker && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = undefined;
            continue;
        }
        if (fence) {
            if (include && fieldInclude) output.push(line);
            continue;
        }
        const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
        if (heading) {
            const level = heading[1].length, title = heading[2].trim();
            while (headings.length && headings[headings.length - 1].level >= level) headings.pop();
            const parent = headings[headings.length - 1];
            const responsibility = visualFieldResponsibility(title, kind, hasReference);
            const blocked = Boolean(parent?.blocked) || responsibility === false;
            // Unknown authored supplements can carry the only physical anchor.
            // Exclude known responsibilities instead of requiring a visual title.
            include = !blocked && (responsibility ?? parent?.include ?? true);
            fieldInclude = include;
            headings.push({ level, include, blocked });
            if (include) output.push(preserveHeadings ? line : `${title}：`);
            continue;
        }
        if (headings[headings.length - 1]?.blocked) continue;
        const clauses: string[] = [];
        for (const clause of line.split(/(?<=[；;。.!?！？])/u)) {
            const label = /^\s*(?:[-*+]\s+|\d+[.)、]\s*)?([^：:\r\n]{1,64})[：:]/u.exec(clause);
            const responsibility = label ? visualFieldResponsibility(label[1].trim(), kind, hasReference) : undefined;
            if (label) fieldInclude = responsibility ?? include;
            if (fieldInclude) clauses.push(clause);
        }
        if (clauses.length) output.push(clauses.join(""));
    }
    return output.join("\n").trim();
}

// Both paths retain complete physical constraints, including custom and legacy
// fields. A selected image only replaces the known costume/lighting sections.
export function assetSheetShotMaterial(content: string, kind: AssetSheetKind, hasReference: boolean) {
    return projectVisualMaterial(content, kind, hasReference);
}

export function assetSheetStyleMaterial(content: string, kind?: AssetSheetKind) {
    return visualMaterial(content, [...styleFields, ...(kind ? [categoryStyleFields[kind]] : Object.values(categoryStyleFields))]);
}
