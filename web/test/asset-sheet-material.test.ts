import { expect, test } from "bun:test";
import { AssetSheetKind, assetSheetPrompt } from "@/lib/asset-reference-sheet";
import { assetSheetSubjectMaterial, assetSheetStyleMaterial } from "@/lib/asset-sheet-material";
import { createWorkflowImages, workflowImageSubjects } from "@/lib/canvas/canvas-workflow-images";
import { adjustWorkflowImagePrompt } from "@/lib/canvas/canvas-image-prompt-adjustment";
import { nodeWorkflow, workflowSignature } from "@/lib/canvas/canvas-short-drama-workflow";
import { ShortDramaStep } from "@/lib/short-drama-steps";
import { defaultShortDramaSettings } from "@/lib/short-drama-settings";
import { applyProductionRules, productionRuleBlock } from "@/lib/production-rules";
import { workflowImageFixture } from "./fixtures/workflow-image-project";

const character = [
    "## 人物编码、别名、选题依据与预计出场\n@CHR-0001，阿青，成年女性。",
    "## 人物关系与关系弧光\n多集关系发展不应带入生图。",
    "## 年龄感、体型、面部与辨识特征\n三十岁，方脸，左眉缺口。",
    "## 固定服装、配饰与材质配色\n墨绿棉布长外套，银色搭扣。",
    "## 发型、妆容与固定细节\n深棕短发，保留自然皮肤纹理。",
    "## 姿态、动作、表情与表演边界\n先双手持机，又伸手递出资料的剧情表演。",
    "## 服化与情绪状态变体及启用条件\n雨天加同色防雨罩，不换身份。",
    "## 声线音色、质感与辨识点\n不可带入的低频沙哑声线。",
    "## 可复用配音提示词\n不可带入的配音台词。",
    "## 人物参考图生成提示词\n原始单幅肖像模板。",
    "## 人物外观与声线禁止变化\n不得镜像左眉缺口，不得换成年龄较小的人物。",
    "## 人物跨集不变项与变化条件\n身份与服化状态保持一致。",
].join("\n\n");
const style = "## 整体视觉风格与媒介质感\n二维水彩，纸面纹理。\n\n## 主辅色、角色色与禁用色\n低饱和青绿，禁止荧光紫。\n\n## 光源方向、光比与日夜照明\n左上柔光。\n\n## 视觉节奏与声音配合约束\n不应送往生图的管弦音乐。\n\n## 视觉禁止项与负面提示词\n禁止写实摄影质感。";

test("fixed character schema selects visual fields without narrative, alternate states or broad prohibitions", () => {
    const result = assetSheetSubjectMaterial(character, AssetSheetKind.Character);
    for (const value of ["三十岁", "左眉缺口", "墨绿棉布长外套", "深棕短发"]) expect(result).toContain(value);
    for (const value of ["多集关系发展", "不可带入的低频", "不可带入的配音", "又伸手递出资料的剧情表演", "雨天加同色防雨罩", "不得换成年龄较小", "身份与服化状态保持一致", "原始单幅肖像模板"]) expect(result).not.toContain(value);
});

test("character sheets use one pose per view, isolate props and preserve authored physical differences", () => {
    const content = character.replace("三十岁，方脸，左眉缺口。", "三十岁，方脸，左眉缺口，左前臂使用义肢。") + "\n\n## 用户补充\n轮椅为必要辅助器具。";
    for (const visualOnly of [false, true]) {
        const prompt = assetSheetPrompt({ kind: AssetSheetKind.Character, size: "1824x1024", title: "阿青", content, style: "水彩", visualOnly });
        expect(prompt).toContain("同一空手中性站姿");
        expect(prompt).toContain("手持道具独立陈列");
        expect(prompt).toContain("每个全身视图只有两条手臂、两只手");
        expect(prompt).toContain("侧面和背面允许自然遮挡");
        expect(prompt).toContain("原设定的体态、肢体差异和必要辅助器具保留");
        expect(prompt).toContain("左前臂使用义肢");
        expect(prompt).toContain("轮椅为必要辅助器具");
        expect(prompt).not.toContain("又伸手递出资料的剧情表演");
        expect(prompt.indexOf("【人物基准姿态与肢体】")).toBeGreaterThan(prompt.indexOf("【本项目统一制作规范】"));
    }
    const customPose = assetSheetPrompt({ kind: AssetSheetKind.Character, size: "1824x1024", title: "阿青", content, style: "水彩", instruction: "右手持一支笔，左手自然垂落" });
    expect(customPose).toContain("右手持一支笔，左手自然垂落");
    expect(customPose).toContain("若本次补充要求明确指定持物");
    expect(customPose).toContain("仅使用这一种姿态");
});

test("character anatomy instructions do not change scene, prop or special sheet contracts", () => {
    for (const kind of [AssetSheetKind.Environment, AssetSheetKind.Prop, AssetSheetKind.Special]) {
        const prompt = assetSheetPrompt({ kind, size: "1824x1024", title: "测试资产", content: "固定形态及材质", style: "水彩" });
        expect(prompt).not.toContain("【人物基准姿态与肢体】");
        expect(prompt).not.toContain("两条手臂、两只手");
    }
});

test("scene, prop and existing special materials retain their visual constraints", () => {
    for (const [kind, heading, sound] of [
        [AssetSheetKind.Environment, "空间布局、尺度与固定陈设", "环境声源、层次、混响与变化条件"],
        [AssetSheetKind.Prop, "道具形状、尺寸、比例与辨识特征", "操作声、材质声与标志音效"],
        [AssetSheetKind.Special, "固定形态、尺度、材质与辨识特征", "触发、持续、结束与标志声音"],
    ] as const) {
        const result = assetSheetSubjectMaterial(`## ${heading}\n不可丢失的视觉设计\n## ${sound}\n无关音轨`, kind);
        expect(result).toContain("不可丢失的视觉设计");
        expect(result).not.toContain("无关音轨");
    }
});

test("custom documents, new sections, nested headings and fenced examples are not silently deleted", () => {
    const custom = "手写描述：金属外观和用途";
    expect(assetSheetSubjectMaterial(custom, AssetSheetKind.Prop)).toBe(custom);
    const text = "资产 @CHR-0001\n## 年龄感、体型、面部与辨识特征\n方脸\n### 细节\n左眉缺口\n```text\n## 声音设计\n这是代码中的视觉例子\n```\n## 用户新增外观约束\n不要删除\n## 可复用配音提示词\n应删除";
    const result = assetSheetSubjectMaterial(text, AssetSheetKind.Character);
    for (const value of ["### 细节", "这是代码中的视觉例子", "不要删除"]) expect(result).toContain(value);
    expect(result).not.toContain("应删除");
});

test("styles select medium, colors and lighting without general prohibition or delivery documents", () => {
    const result = assetSheetStyleMaterial(style);
    for (const value of ["二维水彩", "纸面纹理", "青绿", "左上柔光", "禁止荧光紫"]) expect(result).toContain(value);
    expect(result).not.toContain("禁止写实摄影质感");
    expect(result).not.toContain("管弦音乐");
    const generation = assetSheetStyleMaterial("## 图像画幅、构图与清晰度要求\n主体完整\n## 视频时长、动作、运镜与首尾帧要求\n十秒运镜\n## 音频生成、声线引用与同步要求\n配音同步\n## 生成禁止项与负面提示词\n不添加水印");
    expect(generation).toBe("");
    expect(generation).not.toContain("十秒运镜"); expect(generation).not.toContain("配音同步");
});

test("asset kind selects its own art guidance without borrowing another category's design", () => {
    const input = "## 整体视觉风格与媒介质感\n全局水彩\n## 人物比例、服装与妆发规范\n人物服装\n## 场景建筑、空间与陈设规范\n场景建筑\n## 道具尺度、材质与工艺规范\n道具材质";
    for (const [kind, own, unrelated] of [
        [AssetSheetKind.Character, "人物服装", ["场景建筑", "道具材质"]],
        [AssetSheetKind.Environment, "场景建筑", ["人物服装", "道具材质"]],
        [AssetSheetKind.Prop, "道具材质", ["人物服装", "场景建筑"]],
    ] as const) {
        const result = assetSheetStyleMaterial(input, kind);
        expect(result).toContain("全局水彩"); expect(result).toContain(own);
        for (const value of unrelated) expect(result).not.toContain(value);
    }
});

test("global settings and task submission do not prepend a second production rule block", () => {
    const f = workflowImageFixture();
    const subject = workflowImageSubjects(f.request, f.nodes)[0];
    const result = createWorkflowImages({ ...f.request, imageSubjectIds: [subject.id], globalSettings: defaultShortDramaSettings() }, f.nodes, f.connections, { x: 0, y: 0 });
    const prompt = result.created[0].metadata!.prompt!;
    const block = productionRuleBlock("assets", "image");
    expect(prompt).toContain("项目视觉设定");
    expect(prompt.split(block)).toHaveLength(2);
    expect(applyProductionRules(prompt, "assets", "image")).toBe(prompt);
});

test("sheet puts the subject before shared norms and preserves explicitly referenced material", () => {
    const prompt = assetSheetPrompt({ kind: AssetSheetKind.Character, title: "阿青 @CHR-0001", size: "1536x1024", content: character, style: assetSheetStyleMaterial(style), references: "@PRP-0001 银扣的外观", instruction: "基准正面表情平静" });
    expect(prompt.indexOf("名称：阿青")).toBeLessThan(prompt.indexOf("【本项目统一制作规范】"));
    expect(prompt).toContain("@PRP-0001 银扣的外观"); expect(prompt).toContain("基准正面表情平静");
    expect(prompt).not.toContain("不可带入的配音");
});

test("new image creation and automatic adjustment both handle current plan documents without changing source versions", () => {
    const f = workflowImageFixture();
    expect(f.request.step).toBe(ShortDramaStep.CharacterReferences);
    const subject = workflowImageSubjects(f.request, f.nodes)[0];
    subject.metadata!.content = character;
    const visual = f.nodes.find((node) => nodeWorkflow(node)?.bibleSection === "style")!;
    visual.metadata!.content = style;
    for (const node of f.nodes) {
        const data = nodeWorkflow(node);
        if (data?.sourceSignatures[visual.id]) data.sourceSignatures[visual.id] = workflowSignature(visual);
    }
    const before = JSON.stringify(f.nodes);
    const result = createWorkflowImages({ ...f.request, imageSubjectIds: [subject.id] }, f.nodes, f.connections, { x: 0, y: 0 });
    const image = result.created[0];
    for (const prompt of [image.metadata!.prompt!, adjustWorkflowImagePrompt(image, result.nodes, image.metadata!.prompt!)]) {
        expect(prompt).toContain("墨绿棉布长外套"); expect(prompt).toContain("二维水彩");
        expect(prompt).not.toContain("不可带入的配音"); expect(prompt).not.toContain("管弦音乐");
        expect(prompt).not.toContain("又伸手递出资料的剧情表演");
        expect(prompt).toContain("【人物基准姿态与肢体】");
    }
    expect(nodeWorkflow(image)!.sourceSignatures[subject.id]).toBe(workflowSignature(subject));
    expect(JSON.stringify(f.nodes)).toBe(before);
});
