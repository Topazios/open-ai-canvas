import { describe, expect, test } from "bun:test";
import { AssetSheetKind, assetSheetPrompt } from "@/lib/asset-reference-sheet";

describe("asset background survives visual projection", () => {
    const samples = [
        {
            kind: AssetSheetKind.Character,
            content: "## 人物身份与剧情功能\n受薪修复师，管理工作室但无产权。\n## 人物经历与关键成因\n完整往事不应塞入图像。\n## 固定服装、配饰与材质配色\n工作服为单位配发的灰蓝棉布，袖口经常摩擦形成浅色磨痕；私服整洁合身。\n## 语言、口音与咬字习惯\n配音专用措辞不应塞入图像。",
            visible: "工作服为单位配发的灰蓝棉布，袖口经常摩擦形成浅色磨痕；私服整洁合身。",
        },
        {
            kind: AssetSheetKind.Environment,
            content: "## 场景剧情功能与使用场次\n访客暂住，不拥有房屋。\n## 建筑材质、表面质感与配色\n单位出资的公共修复室，钢架工作台有修补漆面，储物柜标出公用分区。",
            visible: "单位出资的公共修复室，钢架工作台有修补漆面，储物柜标出公用分区。",
        },
        {
            kind: AssetSheetKind.Prop,
            content: "## 初始归属、持有人与转移条件\n传家赠物，持有人收入有限。\n## 道具材质、工艺、配色与表面细节\n传家赠物为黄铜外壳，长期保养呈柔和光泽，不能按持有人收入改成塑料。",
            visible: "传家赠物为黄铜外壳，长期保养呈柔和光泽，不能按持有人收入改成塑料。",
        },
    ];

    test.each(samples)("$kind keeps visible consequences without importing the biography", ({ kind, content, visible }) => {
        const prompt = assetSheetPrompt({ kind, title: "测试资产", size: "16:9", content, style: "项目既定风格" });
        expect(prompt).toContain(visible);
        expect(prompt).toContain("使用者不等于所有者");
        expect(prompt).toContain("只呈现这些依据对应的可见设计");
        expect(prompt).not.toContain("完整往事不应塞入图像");
        expect(prompt).not.toContain("配音专用措辞不应塞入图像");
    });
});
