import { expect, test } from "bun:test";
import { storyDevelopmentStages } from "../src/lib/canvas/canvas-story-development";
import { episodeOutlineContext } from "../src/lib/canvas/workflow-body-context";
import { shortDramaSteps, ShortDramaStep } from "../src/lib/short-drama-steps";
import { productionAssetCodes } from "../src/lib/production-asset-code";

const fields = ["开场承接与目标", "冲突与关键行动", "结果与情绪变化", "伏笔与回收", "集尾与下集承接", "资产与连续性"];

test("episode generation entry points require the same six fields in order", () => {
    const stage = storyDevelopmentStages.find(stage => stage.id === "episodes")!;
    const step = shortDramaSteps.find(step => step.id === ShortDramaStep.Episodes)!;
    for (const requirement of [stage.requirement, step.requirement]) {
        let previous = -1;
        for (const field of fields) {
            const index = requirement.indexOf(field);
            expect(index).toBeGreaterThan(previous);
            previous = index;
        }
    }
    expect(stage.requirement).toContain("由程序统一排版");
    expect(stage.requirement).not.toContain("不要输出多个文件、节点创建指令或逐集 JSON 数组");
});

test("fixed-format episodes retain their boundaries and asset lookup for prose writing", () => {
    const episode = (number: number) => `## 第 ${number} 集｜选择\n\n${fields.map(field => `**${field}：** 第${number}集的内容；CHR-001、SCN-001、PRP-001。`).join("\n\n")}`;
    const document = `# 全剧集纲\n\n${[1, 2, 3, 4].map(episode).join("\n\n")}`;
    const result = episodeOutlineContext(document, 2);
    expect(result.current).toBe(episode(2));
    expect(result.context).toContain(episode(1));
    expect(result.context).toContain(episode(3));
    expect(result.context).not.toContain(episode(4));
    expect(productionAssetCodes(result.current)).toEqual(expect.arrayContaining(["CHR-001", "SCN-001", "PRP-001"]));
});
