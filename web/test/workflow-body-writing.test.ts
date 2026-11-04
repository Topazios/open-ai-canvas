import { expect, test } from "bun:test";
import { bodyWritingPrompt, bodyWritingRequirement, bodyWritingSpec } from "../src/lib/canvas/workflow-body-writing";
import { defaultShortDramaSettings, DramaDuration, DramaLanguage } from "../src/lib/short-drama-settings";
import { workflowBodyBatch } from "../src/lib/canvas/workflow-text-batch";

test("body runtime comes from project settings and supports legacy minute ranges", () => {
    expect(bodyWritingSpec("1–2")).toMatchObject({ version: 2, minSeconds: 60, maxSeconds: 120, targetSeconds: 90 });
    expect(bodyWritingSpec("30-60秒")).toMatchObject({ minSeconds: 30, maxSeconds: 60, targetSeconds: 45 });
    expect(bodyWritingSpec("1.5")).toMatchObject({ targetSeconds: 90 });
    expect(bodyWritingSpec("wrong", { ...defaultShortDramaSettings(), duration: DramaDuration.Short })).toMatchObject({ minSeconds: 60, maxSeconds: 120 });
    for (const value of ["", "wrong", "2-1", "0", "1-10000"]) expect(() => bodyWritingSpec(value)).toThrow("时长无效");
});

test("body contract asks for complete novel prose and leaves filming detail to storyboards", () => {
    const prompt = bodyWritingPrompt(bodyWritingSpec("1-2"));
    expect(prompt).toContain("60–120 秒");
    expect(prompt).toContain("约 90 秒");
    expect(prompt).toContain("675–1050 字");
    expect(prompt).toContain("小说正文写作要求");
    expect(prompt).toContain("完整小说正文");
    expect(prompt).toContain("神态、语气、身体反应、心理变化");
    expect(prompt).toContain("道具的拿取、使用、交接、放置、损坏和前后状态");
    expect(prompt).toContain("由后续场次与分镜阶段完成");
    expect(prompt).toContain("不写镜号、景别、机位、构图参数");
    expect(prompt).not.toContain("节拍时长：N秒");
    expect(prompt).toContain("集纲的150–250字限制不适用于正文");
    expect(prompt).toContain("下游实测");
    expect(prompt).toContain("关键对白写完整交锋过程");
    expect(prompt).toContain("不将每个动作切成镜头式短句");
    expect(prompt).not.toContain("通常每段5–20秒");
    expect(prompt).toContain("局面变化");
    expect(bodyWritingRequirement).toContain("完整、连贯、细节充分的小说式正文");
    expect(bodyWritingRequirement).toContain("不是剧情摘要、场次剧本或分镜表");
    expect(bodyWritingRequirement).toContain("真实交锋");
    const settings = { ...defaultShortDramaSettings(), language: DramaLanguage.English, duration: DramaDuration.Short };
    expect(bodyWritingPrompt(bodyWritingSpec("1", settings))).toContain("270–420 词");
});

test("even small body requests receive durable quality control without asset extraction", () => {
    const spec = bodyWritingSpec("1-2");
    const sources = [{ step: "story.episodes", title: "集纲", content: "本集冲突" }, { step: "story.plan", title: "本集角色", content: "人物口吻" }];
    expect(workflowBodyBatch(sources, 100, spec)).toMatchObject({ version: 4, bodyWriting: spec, units: [{ label: expect.stringContaining("本集角色"), text: expect.stringContaining("人物口吻") }], context: [{ label: expect.stringContaining("集纲"), text: expect.stringContaining("本集冲突") }] });
    expect(workflowBodyBatch(sources, 100)).toBeUndefined();
});
