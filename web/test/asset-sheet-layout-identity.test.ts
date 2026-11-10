import { expect, test } from "bun:test";
import { AssetSheetKind, assetSheetPrompt } from "@/lib/asset-reference-sheet";
import { assetSheetSpecs, assetSheetTemplateInstruction } from "@/lib/asset-sheet-template";
import { productionRuleBlock } from "@/lib/production-rules";

test("every character sheet explicitly names its unique portrait and same-person views", () => {
    for (const [code, title] of [["CHR-001", "甲"], ["CHR-002", "乙"]]) {
        const prompt = assetSheetPrompt({ kind: AssetSheetKind.Character, size: "16:9", title, code, content: "四十岁，眉眼温和，灰衣。", style: "项目画风" });
        expect(prompt).toContain(`紧邻标注“${code} · ${title}”`);
        expect(prompt).toContain("唯一正脸基准");
        expect(prompt).toContain("同一角色四视图，脸部以左侧为准");
        expect(prompt).toContain("同一人在同一阶段的正、左、右、背面");
        expect(prompt).toContain("不得替代唯一肖像");
    }
});

test("all sheet categories cap detail capacity and preserve uncompressed subjects", () => {
    for (const kind of Object.values(AssetSheetKind)) {
        const spec = assetSheetSpecs[kind];
        const instruction = assetSheetTemplateInstruction(kind, "1536x1024");
        expect(spec.zones.reduce((sum, zone) => sum + zone.cells, 0)).toBeLessThanOrEqual(7);
        expect(Math.max(...spec.zones.map((zone) => zone.cells))).toBeLessThanOrEqual(3);
        expect(instruction).toContain("原始长宽比等比缩小");
        expect(instruction).toContain("每区内部最多 2 列");
        expect(instruction).toContain("放不下先减少次要细节");
        expect(instruction).toContain("格数是容量上限");
    }
    expect(assetSheetTemplateInstruction(AssetSheetKind.Environment, "16:9")).toContain("2 列、2 行");
});

test("natural character details do not request a second face strip or isolated skin panels", () => {
    const spec = assetSheetSpecs.character;
    expect(spec.zones.map((zone) => zone.name)).toEqual(["服装拆解", "关键道具", "妆发与配饰"]);
    expect(spec.zones.find((zone) => zone.name === "妆发与配饰")?.sources).not.toContain("年龄感、体型、面部与辨识特征");
    const content = "六十岁，眼角自然纹理，保留左眉旧缺口。";
    const prompt = assetSheetPrompt({ kind: AssetSheetKind.Character, size: "16:9", title: "甲", content, style: "项目画风", instruction: "旧版式：下方画六格人脸及眼部细节" });
    expect(prompt).toContain(content);
    expect(prompt).toContain("在完整脸上自然呈现");
    expect(prompt).toContain("禁止下方重复画正脸");
    expect(prompt.indexOf("【自然外观展示边界】")).toBeGreaterThan(prompt.indexOf("旧版式："));
    expect(prompt).toContain("此展示边界优先于");
});

test("downstream frame and video prompts interpret a sheet as one identity", () => {
    for (const [stage, mode] of [["storyboard", "image"], ["storyboard", "video"], ["video", "video"]] as const) {
        const block = productionRuleBlock(stage, mode);
        expect(block).toContain("唯一正脸基准");
        expect(block).toContain("未标标签的旧设定板使用左侧完整肖像");
        expect(block).toContain("任何视角、转身或切镜均从该唯一身份推导");
        expect(block).toContain("不把五官切片当身份参考");
    }
    expect(productionRuleBlock("story", "text")).not.toContain("唯一正脸基准");
});
