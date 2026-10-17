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
]);

const visualFields: Record<AssetSheetKind, string[]> = {
    character: ["年龄感、体型、面部与辨识特征", "固定服装、配饰与材质配色", "发型、妆容与固定细节"],
    environment: ["地理位置、时代与建筑类型", "空间布局、尺度与固定陈设", "出入口、通道与人物动线", "相邻空间、方位与视线关系", "建筑材质、表面质感与配色", "固定光源、日夜与天气光照"],
    prop: ["道具形状、尺寸、比例与辨识特征", "道具材质、工艺、配色与表面细节"],
    special: ["固定形态、尺度、材质与辨识特征", "特效颜色、运动、光照与空间影响"],
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
    const result = visualMaterial(content, [...visualFields[kind], ...legacyDesignFields, ...customVisualFields]);
    if (!result.trim()) throw new Error("资产档案缺少可用于生图的外观设计，请补充外观、服化或空间材质信息");
    return result;
}

export function assetSheetStyleMaterial(content: string, kind?: AssetSheetKind) {
    return visualMaterial(content, [...styleFields, ...(kind ? [categoryStyleFields[kind]] : Object.values(categoryStyleFields))]);
}
