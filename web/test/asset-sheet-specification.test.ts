import { expect, test } from "bun:test";
import { AssetSheetKind, assetSheetPrompt } from "@/lib/asset-reference-sheet";
import { assetSheetDimensions, assetSpecificationValue } from "@/lib/asset-sheet-dimensions";
import { assetSheetFieldTable } from "@/lib/asset-sheet-template";

const character = "## 年龄感、体型、面部与辨识特征\n制作设定（非实测）。\n| 字段 | 值 |\n| --- | --- |\n| 年龄 | 28岁 |\n| 净身高（制作设定） | 173 cm |\n| 体重 | 62 kg |\n| 肩宽 | 42 cm |\n| 三围 | 不适用：本人物不提供围度表 |\n\n## 人物创作设计与未定事项\n原文未给精确身高，以上为制作设定。";

test("table specifications are used in the field panel and do not become unknown", () => {
    const table = assetSheetFieldTable({ content: character, kind: AssetSheetKind.Character, title: "甲", code: "CHR-001" });
    expect(table).toContain("年龄：28岁");
    expect(table).toContain("身高：173 cm");
    expect(table).toContain("体重：62 kg");
    expect(table).toContain("三围：不适用：本人物不提供围度表");
    expect(table).not.toContain("待测量");
    expect(table).not.toContain("三围：42");
});

test("baseline specifications do not borrow numbers from props or later age states", () => {
    const content = character + "\n## 固定服装、配饰与材质配色\n随身人偶身高：80cm\n### 老年变体\n年龄：70岁；身高：168cm";
    expect(assetSheetDimensions(content, AssetSheetKind.Character)).toEqual(["身高：173 cm", "体重：62 kg", "肩宽：42 cm"]);
});

test("all circumferences are required before showing a full measurement set", () => {
    const table = (content: string) => assetSheetFieldTable({ content, kind: AssetSheetKind.Character, title: "乙" });
    expect(table("身高：170cm；肩宽：40cm；胸围：90cm")).toContain("三围：未设定（不作标注）");
    expect(table("胸围：90cm；腰围：70cm；臀围：94cm")).toContain("三围：胸围：90cm、腰围：70cm、臀围：94cm");
    expect(table("三围：90/70/94cm")).toContain("三围：90/70/94cm");
});

test("scene geometry and prop combined measurements retain their units", () => {
    expect(assetSheetDimensions("| 长 | 12 m |\n| 宽 | 8 m |\n| 净高 | 4.2 m |\n| 面积 | 96 m² |", AssetSheetKind.Environment)).toEqual(["长：12 m", "宽：8 m", "高：4.2 m", "面积：96 m²"]);
    expect(assetSheetDimensions("| 长×宽×高 | 12×8×6 cm |", AssetSheetKind.Prop)).toEqual(["长×宽×高：12×8×6 cm"]);
    expect(assetSheetDimensions("| 长宽高 | 10×10×20cm |\n| 直径 | 10cm |", AssetSheetKind.Prop)).toEqual(["直径：10cm", "长×宽×高：10×10×20cm"]);
    expect(assetSpecificationValue("| 身高 |\n| 体重 | 62kg |", ["身高"])).toBe("");
});

test("sheet prompts use authored values and never instruct guessing missing dimensions", () => {
    const prompt = assetSheetPrompt({ content: character, kind: AssetSheetKind.Character, title: "甲", code: "CHR-001", size: "16:9", style: "项目画风" });
    expect(prompt).toContain("身高：173 cm");
    expect(prompt).toContain("制作设定数值与原文已定值均按档案照录");
    expect(prompt).not.toContain("待测量");
});
