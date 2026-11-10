import type { AssetSheetKind } from "./asset-reference-sheet";
import { assetSheetDimensions, assetSheetSpecificationContent, assetSpecificationValue } from "./asset-sheet-dimensions";
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
    detailColumns: number;
};

// One fixed specification per category. Wording, order and cell counts are part
// of the contract so every generated sheet carries identical labels.
export const assetSheetSpecs: Record<Kind, Spec> = {
    character: {
        title: "角色资产设定",
        fields: ["编码", "姓名", "年龄", "身高", "体重", "三围", "简介", "关键词"],
        topViews: "正面全身、左侧全身、右侧全身、背面全身",
        zones: [
            { name: "服装拆解", cells: 3, sources: ["固定服装、配饰与材质配色"] },
            { name: "关键道具", cells: 2 },
            { name: "妆发与配饰", cells: 2, sources: ["发型、妆容与固定细节"] },
        ],
        detailColumns: 3,
        frame: "左侧资料栏约占整幅宽度 20%；右侧上方四视图约占高度 62%，下方三组拆解与细节约占高度 32%，各区之间留足间隔。",
        extra: "左栏顶部为半身肖像。四个全身视图人物完整站立，脚底基线对齐，同一人、同一年龄、同一固定服装与妆发。身高线必须从脚底基线延伸到头顶最高点，端点贴合头顶与地面，不从颈部或发梢起止；身高数值按档案原值显示，头发、帽子、鞋底和鞋跟不计入净身高，无法判断端点时省略测量线，不另编数值。手持道具只在“关键道具”分区独立陈列，四视图为空手。",
    },
    environment: {
        title: "场景资产设定",
        fields: ["编码", "名称", "出现集数", "空间简介", "空间尺寸", "关键词"],
        topViews: "主视角（略宽）、正立面、侧剖面、俯视平面",
        zones: [
            { name: "带尺寸线的空间拆解轴测图", cells: 1, sources: ["空间布局、尺度与固定陈设"] },
            { name: "动线平面图", cells: 1, sources: ["出入口、通道与人物动线"] },
            { name: "关键道具展示", cells: 2 },
            { name: "材质细节与色板", cells: 2, sources: ["建筑材质、表面质感与配色"] },
        ],
        detailColumns: 2,
        frame: "左侧资料栏约占整幅宽度 17%；右侧上方四视图约占高度 50%，下方空间拆解、动线、道具及材质约占高度 47%。",
        extra: "左栏顶部为场景等距轴测小图。四个视图必须是同一个世界坐标场景的投影，门窗、墙角、家具、出入口和固定道具的中心坐标、占地尺寸、离墙距离与朝向一致，只允许相机位置、遮挡和可见面改变。先建立带原点、X/Y方向和比例尺的主平面图，再由同一套坐标投影生成其余视图；为每件固定物保留唯一编号与锚点，不得为构图移动、缩放、镜像或旋转。",
    },
    prop: {
        title: "道具资产设定",
        fields: ["编号", "名称", "简介", "出现集数", "外形尺寸", "主要材质", "主要配色", "关键词"],
        topViews: "正面、侧面、背面、三分之四视角",
        zones: [
            { name: "外表面与材质细节", cells: 2, sources: ["道具材质、工艺、配色与表面细节"] },
            { name: "外部附件或装饰", cells: 2, sources: ["道具形状、尺寸、比例与辨识特征"] },
            { name: "固定标记与磨损", cells: 2 },
        ],
        detailColumns: 3,
        frame: "左侧资料栏约占整幅宽度 17%；右侧主体上方为四视图，下方为外观附件与表面细节区域。",
        extra: "左栏顶部为道具主视图小图。多件套道具每个视图按同一顺序、同一比例并排陈列全部部件，单件道具四个视图各画一件；同一道具的比例、可见外形和材质一致，不虚构内部结构或使用状态。下方为外观附件与表面细节区域，只放外表面特写。",
    },
    special: {
        title: "特殊资产设定",
        fields: ["编号", "名称", "用途", "触发条件", "关键词"],
        topViews: "四个视图或已定义状态",
        zones: [
            { name: "构成", cells: 2, sources: ["固定形态、尺度、材质与辨识特征"] },
            { name: "材质与纹理", cells: 2 },
            { name: "光效", cells: 2, sources: ["特效颜色、运动、光照与空间影响"] },
        ],
        detailColumns: 3,
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
    const cells = spec.zones.map((zone) => `${zone.name}（最多 ${zone.cells} 格）`).join("、");
    return [
        `【固定标题条】设定板顶部左上固定一条矩形标题条，文案只能是“${spec.title}”，不加项目名、集数或其他副标题，位置与大小在所有设定板中一致。`,
        `【固定资料栏】左栏从上到下依次为主图、${spec.fields.map((field) => `“${field}”`).join("、")}，字段名文案和顺序固定，每个字段一行“字段名：字段值”；只抄录下方字段表和资产规格，制作设定属于已定设计值。确实不适用的照录原因；历史材料缺少的值不临场猜测，不绘制相应测量线。资料栏不增删字段、不改名。`,
        `【固定右上视图】右侧上方四个等宽视图格，依次为${spec.topViews}，每格顶部有居中小标签。`,
        `【固定右下分区】右侧下方采用 ${spec.detailColumns} 列、${Math.ceil(spec.zones.length / spec.detailColumns)} 行等分网格，按从左至右、从上至下排列：${cells}。每区内部最多 2 列，超过 2 格则换为两行，禁止把全部小图挤成一排。格数是容量上限，只展示档案中可用的必要细节，不重复画主体或虚构细节填格；不用的格保留留白。分区名称即标签文案，图下一行不超过 8 字的说明。`,
        `【画幅与留白】整幅为 ${size} 横向，标题条、边框、标签和图像都完整位于画幅内，四边保留约 2% 留白，不裁切、不出血、不拉伸变形。${spec.frame}`,
        "【所有资产的排版约束】先分配边框、标题和图注的独立空间，再把图像按原始长宽比等比缩小放入剩余区域，禁止横向压扁、纵向拉长或强行铺满。相邻分区留清楚间距；每格图像与边框至少留约 5% 内边距。标注放在图像外侧，不越界、不跨栏、不覆盖主体；资料值过长时换行，简介最多三行。内容放不下先减少次要细节，不缩窄主体、不把多项合成一条狭长切片，不把文字缩成不可读的小字。",
        spec.extra,
        assetSheetStyleSpec,
        kind === "environment" ? "【尺寸标注规则】总高、檐口高、屋脊高各自只标一次，分别书写，不相加、不重复；尺寸线与数字放在物体外侧并引出，不压在家具或墙体上；轴测图的标注全部放在图外侧；所有视图共用档案规格和坐标，缺少数值的项目不画测量线。" : "【尺寸标注规则】尺寸线放在物体外侧，不遮挡主体；资料栏与所有视图共用档案同一组数值，制作设定按原值照录，缺少数值的项目不画测量线。",
    ].join("\n\n");
}

function clean(text: string, limit: number) {
    const plain = text.replace(/^#+\s.*$/gm, "").replace(/[*`>#|-]/g, " ").replace(/\s+/g, " ").trim();
    return plain.length > limit ? `${plain.slice(0, limit)}…` : plain;
}

function labelled(content: string, labels: string[]) {
    return assetSpecificationValue(content, labels);
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
    const physical = assetSheetSpecificationContent(content, kind as AssetSheetKind);
    const circumferences = ["胸围", "腰围", "臀围"].map((label) => dims.find((item) => item.startsWith(label)) || "");
    const measurements = dims.find((item) => item.startsWith("三围"))?.replace(/^三围：/u, "")
        || (circumferences.every(Boolean) ? circumferences.join("、") : "")
        || labelled(physical, ["三围"]);
    const keywords = "由档案外观提炼 3 至 5 个短词";
    const episodes = labelled(content, ["出现集数", "预计出场", "集数"]) || "待定";
    const appearance = clean(sectionText(sections, kind === "character" ? ["年龄感、体型、面部与辨识特征"] : kind === "environment" ? ["空间布局、尺度与固定陈设", "地理位置、时代与建筑类型"] : kind === "prop" ? ["道具形状、尺寸、比例与辨识特征"] : ["固定形态、尺度、材质与辨识特征"]), 60);
    const values: Record<string, string> = {
        编码: input.code || "待定", 编号: input.code || "待定", 姓名: input.title, 名称: input.title, 出现集数: episodes, 关键词: keywords,
        年龄: labelled(physical, ["基准年龄", "年龄", "年龄感"]) || "档案未定义（不作标注）",
        身高: dimension(dims, /^(?:身高|height)/iu) || "档案未定义（不作标注）",
        体重: dimension(dims, /^(?:体重|weight)/iu) || labelled(physical, ["体重"]) || "档案未定义（不作标注）",
        三围: measurements || "未设定（不作标注）",
        简介: appearance || "待定", 空间简介: appearance || "待定",
        空间尺寸: dims.join("、") || "档案未定义（不作标注）", 外形尺寸: dims.join("、") || "档案未定义（不作标注）",
        主要材质: labelled(content, ["主要材质", "材质"]) || "待定", 主要配色: labelled(content, ["主要配色", "配色", "颜色"]) || "待定",
        用途: labelled(content, ["用途", "剧情功能"]) || "待定", 触发条件: labelled(content, ["触发条件"]) || "待定",
    };
    const rows = spec.fields.map((field) => `${field}：${values[field] || "待定"}`);
    const zones = spec.zones.map((zone) => {
        const text = clean(sectionText(sections, zone.sources || []), 160);
        return text ? `${zone.name}：${text}` : "";
    }).filter(Boolean);
    return [
        ...(kind === "character" ? [`【角色身份标签】左侧肖像上方必须清晰写“唯一正脸基准”，紧邻标注“${[input.code, input.title].filter(Boolean).join(" · ")}”。右上四视图共用说明“同一角色四视图，脸部以左侧为准”。这四个视图和左侧肖像全部是该编码的同一人；视角变化不创建第二张身份脸。`] : []),
        "【字段表】资料栏按下列位置逐行填写，字段名与顺序不可改动：",
        ...rows,
        ...(zones.length ? ["【分区内容】右下各分区的内容来源如下，分区名称与容量上限遵循模板；只选必要内容，不为填满格子重复绘制：", ...zones] : []),
    ].join("\n");
}
