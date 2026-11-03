import type { AssetSheetKind } from "./asset-reference-sheet";
import { assetSheetDimensions } from "./asset-sheet-dimensions";
import { documentSections } from "./asset-sheet-material";

type Kind = `${AssetSheetKind}`;
type Zone = { name: string; cells: number; sources?: string[] };
type Spec = {
    title: string;
    fields: string[];
    topViews: string;
    zones: Zone[];
    frame: string;
    extra: string;
};

// One fixed specification per category. Wording, order and cell counts are part
// of the contract so every generated sheet carries identical labels.
export const assetSheetSpecs: Record<Kind, Spec> = {
    character: {
        title: "角色资产设定",
        fields: ["编码", "姓名", "年龄", "身高", "体重", "三围", "简介", "关键词"],
        topViews: "正面全身、左侧全身、右侧全身、背面全身",
        zones: [
            { name: "服装拆解", cells: 6, sources: ["固定服装、配饰与材质配色"] },
            { name: "关键道具", cells: 4 },
            { name: "面部及辨识特征", cells: 6, sources: ["年龄感、体型、面部与辨识特征", "发型、妆容与固定细节"] },
        ],
        frame: "左侧资料栏约占整幅宽度 18%；右侧上方四视图约占高度 62%，下方三组拆解与细节约占高度 34%。",
        extra: "左栏顶部为半身肖像。四个全身视图人物完整站立，脚底基线对齐，同一人、同一年龄、同一固定服装与妆发。身高线必须从脚底基线延伸到头顶最高点，端点贴合头顶与地面，不从颈部或发梢起止；身高数值按档案原值显示，头发、帽子、鞋底和鞋跟不计入净身高，无法判断端点时标注‘示意/待测量’。手持道具只在“关键道具”分区独立陈列，四视图为空手。",
    },
    environment: {
        title: "场景资产设定",
        fields: ["编码", "名称", "出现集数", "空间简介", "空间尺寸", "关键词"],
        topViews: "主视角（略宽）、正立面、侧剖面、俯视平面",
        zones: [
            { name: "带尺寸线的空间拆解轴测图", cells: 1, sources: ["空间布局、尺度与固定陈设"] },
            { name: "动线平面图", cells: 1, sources: ["出入口、通道与人物动线"] },
            { name: "关键道具展示", cells: 3 },
            { name: "材质细节与色板", cells: 4, sources: ["建筑材质、表面质感与配色"] },
        ],
        frame: "左侧资料栏约占整幅宽度 17%；右侧上方四视图约占高度 50%，下方空间拆解、动线、道具及材质约占高度 47%。",
        extra: "左栏顶部为场景等距轴测小图。四个视图必须是同一个世界坐标场景的投影，门窗、墙角、家具、出入口和固定道具的中心坐标、占地尺寸、离墙距离与朝向一致，只允许相机位置、遮挡和可见面改变。先建立带原点、X/Y方向和比例尺的主平面图，再由同一套坐标投影生成其余视图；为每件固定物保留唯一编号与锚点，不得为构图移动、缩放、镜像或旋转。",
    },
    prop: {
        title: "道具资产设定",
        fields: ["编号", "名称", "简介", "出现集数", "外形尺寸", "主要材质", "主要配色", "关键词"],
        topViews: "正面、侧面、背面、三分之四视角",
        zones: [
            { name: "外表面与材质细节", cells: 3, sources: ["道具材质、工艺、配色与表面细节"] },
            { name: "外部附件或装饰", cells: 3, sources: ["道具形状、尺寸、比例与辨识特征"] },
            { name: "固定标记与磨损", cells: 3 },
        ],
        frame: "左侧资料栏约占整幅宽度 17%；右侧主体上方为四视图，下方为外观附件与表面细节区域。",
        extra: "左栏顶部为道具主视图小图。多件套道具每个视图按同一顺序、同一比例并排陈列全部部件，单件道具四个视图各画一件；同一道具的比例、可见外形和材质一致，不虚构内部结构或使用状态。下方为外观附件与表面细节区域，只放外表面特写。",
    },
    special: {
        title: "特殊资产设定",
        fields: ["编号", "名称", "用途", "触发条件", "关键词"],
        topViews: "四个视图或已定义状态",
        zones: [
            { name: "构成", cells: 3, sources: ["固定形态、尺度、材质与辨识特征"] },
            { name: "材质与纹理", cells: 3 },
            { name: "光效", cells: 3, sources: ["特效颜色、运动、光照与空间影响"] },
        ],
        frame: "左侧资料栏约占整幅宽度 17%；右侧上方四视图约占高度 55%，下方三组细节约占高度 40%。",
        extra: "左栏顶部为资产主视图小图。右侧上方按资产类型展示四个视图或已定义状态，只呈现档案中已定义的内容，不补造状态。",
    },
};

export const assetSheetStyleSpec = [
    "【固定风格规格】整张设定板统一：纸面底色象牙白 #F4EFE6；完整外框 2px 灰褐 #8A7B6A；分隔线 1px #B9AD9C；",
    "区域标签为位于区域左上角的矩形深灰褐底 #5B4F43 白色黑体字；字段名为灰褐色小号字，字段值为深色常规字；全板只用一种无衬线黑体；",
    "所有视图格使用同一中性浅灰纯色底 #E9E6E0，同一柔和左上 45° 主光、中性白平衡、5500K 色温，视图内不加场景背景与戏剧光影；",
    "人物和道具视图用正交式平视镜头无透视畸变；各格留白与边距一致。画面质感与色彩的其余部分遵循本项目视觉规范。",
].join("");

export function assetSheetTemplateInstruction(kind: Kind, size: string) {
    const spec = assetSheetSpecs[kind];
    const cells = spec.zones.map((zone) => zone.cells > 1 ? `${zone.name}（${zone.cells} 格）` : zone.name).join("、");
    return [
        `【固定标题条】设定板顶部左上固定一条矩形标题条，文案只能是“${spec.title}”，不加项目名、集数或其他副标题，位置与大小在所有设定板中一致。`,
        `【固定资料栏】左栏从上到下依次为主图、${spec.fields.map((field) => `“${field}”`).join("、")}，字段名文案和顺序固定，每个字段一行“字段名：字段值”；资产档案没有该值时写“待定”，尺寸类写“待测量”。资料栏不增删字段、不改名。`,
        `【固定右上视图】右侧上方四个等宽视图格，依次为${spec.topViews}，每格顶部有居中小标签。`,
        `【固定右下分区】右侧下方分区自左至右固定为：${cells}；分区名称即标签文案，每个分区内的格子大小一致，一格一图，图下一行不超过 8 字的说明。`,
        `【画幅与留白】整幅为 ${size} 横向，标题条、边框、标签和图像都完整位于画幅内，四边保留约 2% 留白，不裁切、不出血、不拉伸变形。${spec.frame}`,
        spec.extra,
        assetSheetStyleSpec,
        kind === "environment" ? "【尺寸标注规则】总高、檐口高、屋脊高各自只标一次，分别书写，不相加、不重复；尺寸线与数字放在物体外侧并引出，不压在家具或墙体上；轴测图的标注全部放在图外侧；所有视图共用同一组数值，缺少依据的写‘待测量’。" : "【尺寸标注规则】尺寸线放在物体外侧，不遮挡主体；所有视图共用同一组数值，缺少依据的写‘待测量’。",
    ].join("\n\n");
}

function clean(text: string, limit: number) {
    const plain = text.replace(/^#+\s.*$/gm, "").replace(/[*`>#|-]/g, " ").replace(/\s+/g, " ").trim();
    return plain.length > limit ? `${plain.slice(0, limit)}…` : plain;
}

function labelled(content: string, labels: string[]) {
    const match = new RegExp(`(?:${labels.join("|")})\\s*[:：]\\s*([^；;。\\n]{1,40})`, "u").exec(content.replace(/[*]/g, ""));
    return match?.[1].trim() || "";
}

function dimension(dims: string[], pattern: RegExp) {
    const found = dims.find((item) => pattern.test(item));
    return found ? found.replace(/^[^0-9约]+/u, "").trim() : "";
}

function sectionText(sections: { title: string; lines: string[] }[], titles: string[]) {
    return titles.map((title) => sections.find((section) => section.title === title)?.lines.slice(1).join("\n") || "").filter(Boolean).join("\n");
}

// Maps archive sections to fixed field positions. Unstructured content keeps its
// original text in the prompt, so this table only adds values it can find.
export function assetSheetFieldTable(input: { content: string; kind: Kind; title: string; code?: string }) {
    const { content, kind } = input;
    const spec = assetSheetSpecs[kind];
    const sections = documentSections(content);
    const dims = assetSheetDimensions(content, kind as AssetSheetKind);
    const keywords = "由档案外观提炼 3 至 5 个短词";
    const episodes = labelled(content, ["出现集数", "预计出场", "集数"]) || "待定";
    const appearance = clean(sectionText(sections, kind === "character" ? ["年龄感、体型、面部与辨识特征"] : kind === "environment" ? ["空间布局、尺度与固定陈设", "地理位置、时代与建筑类型"] : kind === "prop" ? ["道具形状、尺寸、比例与辨识特征"] : ["固定形态、尺度、材质与辨识特征"]), 60);
    const values: Record<string, string> = {
        编码: input.code || "待定", 编号: input.code || "待定", 姓名: input.title, 名称: input.title, 出现集数: episodes, 关键词: keywords,
        年龄: labelled(content, ["年龄感", "年龄"]) || "待定",
        身高: dimension(dims, /^(?:身高|height)/iu) || "待测量",
        体重: dimension(dims, /^(?:体重|weight)/iu) || "待测量",
        三围: dimension(dims, /^(?:三围|胸围|腰围|臀围|肩宽)/u) || "待测量",
        简介: appearance || "待定", 空间简介: appearance || "待定",
        空间尺寸: dims.join("、") || "待测量", 外形尺寸: dims.join("、") || "待测量",
        主要材质: labelled(content, ["主要材质", "材质"]) || "待定", 主要配色: labelled(content, ["主要配色", "配色", "颜色"]) || "待定",
        用途: labelled(content, ["用途", "剧情功能"]) || "待定", 触发条件: labelled(content, ["触发条件"]) || "待定",
    };
    const rows = spec.fields.map((field) => `${field}：${values[field] || "待定"}`);
    const zones = spec.zones.map((zone) => {
        const text = clean(sectionText(sections, zone.sources || []), 160);
        return text ? `${zone.name}：${text}` : "";
    }).filter(Boolean);
    return [
        "【字段表】资料栏按下列位置逐行填写，字段名与顺序不可改动：",
        ...rows,
        ...(zones.length ? ["【分区内容】右下各分区的内容来源如下，分区名称与格数不变：", ...zones] : []),
    ].join("\n");
}