import { expect, test } from "bun:test";
import { createStoryboardRow } from "@/lib/canvas/canvas-project-domain";
import { applyStoryboardFrameComposition, storyboardFrameBoundaryPrompt, storyboardCompositionRule } from "@/lib/canvas/storyboard-frame-composition";
import { StoryboardFrameKind } from "@/types/canvas";

const camera = "中景，两人腰部以上；甲画左乙画右，同一纵深，主体约占画幅高度六成。固定机位。";
const visual = "【起幅状态】甲坐在画左，手放桌面；乙画右端着杯子。\n【动作过程】乙放下杯子，甲起身。\n【落幅状态】甲已站起，乙双手离开杯子。";
const row = createStoryboardRow(1, { camera, plotDescription: visual, continuityOut: "甲已站起，杯子留在乙侧桌面", videoMotionPrompt: `镜头 SC-001 · 10.0秒\n画面：${visual}\n镜头：${camera}\n对白：不要带入静态图的整段对白\n声音：不要带入静态图的音效\n衔接：甲已站起，杯子留在乙侧桌面` });

test("static endpoints use their own state and camera without future poses, dialogue or duplicated sequences", () => {
    const start = storyboardFrameBoundaryPrompt(row, StoryboardFrameKind.Start);
    const end = storyboardFrameBoundaryPrompt(row, StoryboardFrameKind.End);
    expect(start).toContain("甲坐在画左");
    expect(start).not.toContain("甲已站起");
    expect(end).toContain("甲已站起");
    expect(end).not.toContain("甲坐在画左");
    for (const prompt of [start, end]) {
        expect(prompt).toContain(camera);
        expect(prompt).not.toContain("整段对白");
        expect(prompt).not.toContain("静态图的音效");
        expect(prompt.split(camera)).toHaveLength(2);
        expect(prompt).not.toContain("乙放下杯子，甲起身");
    }
});

test("legacy freeform sequences and manual video edits remain authoritative", () => {
    const legacy = { ...row, videoMotionPrompt: "用户已编辑：俯拍无人桌面，只看杯子。" };
    const prompt = storyboardFrameBoundaryPrompt(legacy, StoryboardFrameKind.Start);
    expect(prompt).toContain(legacy.videoMotionPrompt);
    expect(prompt).not.toContain(camera);
    const prose = { ...row, videoMotionPrompt: "", plotDescription: "甲从门口进入，停在桌边。", camera: "远景，人物只占画幅两成。" };
    expect(storyboardFrameBoundaryPrompt(prose, StoryboardFrameKind.End)).toContain(prose.camera);
});

test("moving camera endpoints only carry their own framing and the shared spatial basis", () => {
    const camera = "【构图基准】甲画左乙画右，不换边。\n【起幅机位】远景，两人全身入画，主体约占画幅高度四成。\n【落幅机位】推至近景，只取甲肩部以上，乙在右侧画外。\n【机位运动】缓慢向甲推进。";
    const source = { ...row, videoMotionPrompt: "", camera };
    const start = storyboardFrameBoundaryPrompt(source, StoryboardFrameKind.Start);
    const end = storyboardFrameBoundaryPrompt(source, StoryboardFrameKind.End);
    expect(start).toContain("两人全身入画");
    expect(start).not.toContain("只取甲肩部以上");
    expect(end).toContain("只取甲肩部以上");
    expect(end).not.toContain("两人全身入画");
    for (const prompt of [start, end]) expect(prompt).toContain("甲画左乙画右，不换边");
});

test("retry upgrades the saved automatic block, preserves custom edits and does not stack rules", () => {
    const frame = { id: "start", kind: StoryboardFrameKind.Start, sourcePromptHash: "hash", timeSeconds: 0, prompt: "旧版整镜头混合动作块" };
    const input = `用户的补充光线\n${frame.prompt}\n保留自定义色调`;
    const prompt = applyStoryboardFrameComposition(input, row, frame);
    expect(prompt).toContain("甲坐在画左");
    expect(prompt).not.toContain(frame.prompt);
    expect(prompt).toContain("保留自定义色调");
    expect(applyStoryboardFrameComposition(prompt, row, frame)).toBe(prompt);
    const custom = applyStoryboardFrameComposition("用户完全重写的构图", row, frame);
    expect(custom).toStartWith("用户完全重写的构图");
    expect(custom).not.toContain("甲坐在画左");
});

test("keyframes keep the requested instant and shot camera without imposing an end pose or fixed anatomy", () => {
    const frame = { id: "key-1", kind: StoryboardFrameKind.Key, sourcePromptHash: "hash", timeSeconds: 4, prompt: "甲刚从座位起身，乙手指离开杯子。" };
    const prompt = applyStoryboardFrameComposition(frame.prompt, row, frame);
    expect(prompt).toContain("第4秒");
    expect(prompt).toContain(camera);
    expect(prompt).not.toContain(row.continuityOut);
    expect(prompt).toContain(storyboardCompositionRule);
    for (const camera of ["极近特写，仅眼睛入画。", "远景，风格化小人占画幅一成。", "俯拍，只有一只拿笔的手入画。", "无人空镜，门口留白。"]) {
        const source = { ...row, camera, videoMotionPrompt: "", plotDescription: "保持该时刻状态" };
        const result = applyStoryboardFrameComposition(storyboardFrameBoundaryPrompt(source, StoryboardFrameKind.End), source, { ...frame, kind: StoryboardFrameKind.End, prompt: "" });
        expect(result).toContain(camera);
        expect(result).toContain("占幅随景别和纵深确定");
        expect(result).not.toContain("必须全身");
    }
});
