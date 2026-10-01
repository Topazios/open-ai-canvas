import { describe, expect, test } from "bun:test";

import { inferCategory, parseTextAssetBatch, parseTextAssetBatchModelJson } from "../src/lib/canvas/text-asset-batch";

describe("parseTextAssetBatch", () => {
    test("extracts individual characters and scenes under Markdown sections", () => {
        const items = parseTextAssetBatch(`# 《取景器里多出一个人》资产提取总表

> 说明：同一身份已合并别名，不作为独立人物处理。

## 角色
### 林晚
身份：摄影师
外貌：黑色短发，深色外套

### 周齐
身份：同事
外貌：戴圆框眼镜

## 场景
### 老公寓走廊
空间：狭长的楼道，水泥墙面
光线：昏暗的顶灯

### 摄影棚
空间：白色背景与拍摄灯具`);

        expect(items).toHaveLength(4);
        expect(items.map(({ category, title }) => [category, title])).toEqual([
            ["character", "林晚"],
            ["character", "周齐"],
            ["environment", "老公寓走廊"],
            ["environment", "摄影棚"],
        ]);
        expect(items[2].prompt).toContain("水泥墙面");
        expect(items[2].prompt).toContain("昏暗的顶灯");
        expect(items.every((item) => !item.prompt.includes("同一身份"))).toBe(true);
    });

    test("supports bold numbered assets and scene labels", () => {
        const items = parseTextAssetBatch(`## 人物资产
- **1. 苏禾**：成年女性，红色围巾
- **2. 陈默**：戴眼镜的青年

## 场景资产
- **1. 雨夜天台**：城市高楼的露台
- **2. 地下车库**：混凝土立柱和冷色灯`);

        expect(items.map(({ category, title }) => [category, title])).toEqual([
            ["character", "苏禾"],
            ["character", "陈默"],
            ["environment", "雨夜天台"],
            ["environment", "地下车库"],
        ]);
    });

    test("keeps details inside the asset and prioritizes its section", () => {
        const items = parseTextAssetBatch(`# 资产表
## 角色
### 林晚
#### 外貌
短发，白色衬衫
**身份**：负责场景设计，熟悉建筑和室内空间
#### 生图提示词
同一张人物参考图中保持发型与服装。
## 场景
### 摄影棚
#### 光线
顶部柔光箱，墙面浅灰`);
        expect(items).toHaveLength(2);
        expect(items.map((item) => item.category)).toEqual(["character", "environment"]);
        expect(items[0].prompt).toContain("负责场景设计");
        expect(items[1].prompt).toContain("顶部柔光箱");
    });

    test("uses paragraph fallback for unstructured text", () => {
        const items = parseTextAssetBatch("角色：一名穿蓝色外套的年轻导演，黑发，手持摄影机。\n\n场景：夜晚的旧影院，银幕破旧，过道有暖色壁灯。");
        expect(items).toHaveLength(2);
        expect(items.map((item) => item.category)).toEqual(["character", "environment"]);
    });

    test("supports direct role and scene labels", () => {
        const items = parseTextAssetBatch("- 角色：苏禾，红色围巾\n- 场景：雨夜天台，城市高楼");
        expect(items.map(({ category, title }) => [category, title])).toEqual([
            ["character", "苏禾"],
            ["environment", "雨夜天台"],
        ]);
    });

    test("returns no items for empty text", () => {
        expect(parseTextAssetBatch("  \n")).toEqual([]);
        expect(inferCategory("室内场景")).toBe("environment");
    });

    test("parses model JSON in a code block and keeps review evidence", () => {
        const result = parseTextAssetBatchModelJson(`\`\`\`json
        {
          "sourceCount": 8,
          "mergedCount": 5,
          "items": [
            {
              "category": "character",
              "name": "林晚",
              "aliases": ["小林"],
              "summary": "摄影师，黑色短发",
              "visualPrompt": "成年女性摄影师，黑色短发，深色外套，角色设定参考图",
              "sheetType": "character_sheet",
              "sheetPrompt": "完整角色信息型设定板，左侧信息栏，右侧正面/侧面/背面四视图，服装拆解和关键道具",
              "negativePrompt": "四视图不是同一人，额外人物，文字乱码",
              "views": ["正面全身", "左侧面全身", "右侧面全身", "背面全身"],
              "decomposition": ["服装拆解", "关键道具"],
              "props": ["黑色胶片相机"],
              "materials": [],
              "sourceEvidence": "第三场：林晚拿起相机"
            },
            {
              "category": "environment",
              "name": "老公寓走廊",
              "summary": "狭长水泥楼道",
              "visualPrompt": "狭长的老公寓走廊，水泥墙面，昏暗顶灯，场景设定参考图",
              "sheetType": "scene_sheet",
              "sheetPrompt": "完整场景信息型设定板，左侧信息栏，右侧主视角/正立面/侧剖面/俯视平面，空间拆解和动线",
              "negativePrompt": "空间边界变化，额外房间",
              "views": ["主视角", "正立面", "侧剖面", "俯视平面"],
              "decomposition": ["空间拆解", "动线"],
              "props": [],
              "materials": ["水泥墙面"],
              "sourceEvidence": "第一场：老公寓走廊"
            }
          ]
        }
        \`\`\``);

        expect(result?.items).toHaveLength(2);
        expect(result?.items[0].aliases).toEqual(["小林"]);
        expect(result?.items[0].prompt).toContain("完整角色信息型设定板");
        expect(result?.items[0].sheetType).toBe("character_sheet");
        expect(result?.items[0].views).toEqual(["正面全身", "左侧面全身", "右侧面全身", "背面全身"]);
        expect(result?.items[0].negativePrompt).toContain("四视图不是同一人");
        expect(result?.items[1].sourceEvidence).toContain("老公寓走廊");
        expect(result?.items[1].sheetType).toBe("scene_sheet");
        expect(result?.items[1].materials).toEqual(["水泥墙面"]);
        expect(result?.mergedCount).toBe(5);
    });

    test("deduplicates model items and caps the review list", () => {
        const items = Array.from({ length: 65 }, (_, index) => ({
            category: "character",
            name: index < 2 ? "林晚" : `角色${index}`,
            visualPrompt: "角色参考图",
        }));
        const result = parseTextAssetBatchModelJson(JSON.stringify({ items }));
        expect(result?.items).toHaveLength(60);
        expect(result?.items.filter((item) => item.title === "林晚")).toHaveLength(1);
    });

    test("accepts a valid empty analysis result", () => {
        const result = parseTextAssetBatchModelJson(JSON.stringify({ sourceCount: 0, mergedCount: 0, items: [] }));
        expect(result).toEqual({ items: [], sourceCount: 0, mergedCount: 0 });
    });

    test("normalizes invalid counts without rejecting valid items", () => {
        const result = parseTextAssetBatchModelJson(JSON.stringify({
            sourceCount: "8",
            mergedCount: -1,
            items: [{ category: "character", name: "林晚", visualPrompt: "黑色短发的摄影师角色参考图" }],
        }));
        expect(result?.items).toHaveLength(1);
        expect(result?.sourceCount).toBe(1);
        expect(result?.mergedCount).toBe(0);
    });

});
