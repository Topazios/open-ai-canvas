import { expect, test } from "bun:test";
import { sharedWorkflowTextBatch, splitWorkflowText, workflowTextBatch, WORKFLOW_UNIT_LIMIT } from "../src/lib/canvas/workflow-text-batch";

test("long scene/paragraph and Unicode splits preserve every source character", () => {
    for (const text of ["正文\n".repeat(24000), "人".repeat(19999) + "🎬".repeat(50000), "长".repeat(80001)]) {
        const units = splitWorkflowText(text);
        expect(units.join("")).toBe(text);
        expect(units.every((unit) => unit.length <= WORKFLOW_UNIT_LIMIT && unit.isWellFormed())).toBe(true);
    }
    expect(() => splitWorkflowText("a", 0)).toThrow();
});

test("asset categories share identical prose units and separate production constraints even for short inputs", () => {
    const sources = [
        { id: "plan", step: "story.plan", content: "计划拍12集" },
        { id: "body-1", step: "story.body", episodeNumber: 1, content: "甲进入房间。" },
        { id: "body-2", step: "story.body", episodeNumber: 2, content: "甲拿起钥匙。" },
        { id: "style", step: "assets.style", content: "采用黑白画风" },
    ];
    const characters = sharedWorkflowTextBatch(sources, "pipeline", "characters")!;
    const scenes = sharedWorkflowTextBatch(sources, "pipeline", "environments")!;
    expect(characters.version).toBe(2);
    expect(characters.units).toEqual(scenes.units);
    expect(characters.units).toHaveLength(2);
    expect(JSON.stringify(characters.units)).not.toContain("黑白");
    expect(JSON.stringify(characters.units)).not.toContain("12集");
    expect(sharedWorkflowTextBatch(sources, "pipeline", "unknown")).toBeUndefined();
    expect(() => sharedWorkflowTextBatch(sources.filter((source) => source.step !== "story.body"), "pipeline", "props")).toThrow("正文");
    const edited = sharedWorkflowTextBatch(sources.map((source) => source.id === "body-2" ? { ...source, content: "甲放下钥匙。" } : source), "pipeline", "characters")!;
    expect(edited.units[0]).toEqual(characters.units[0]);
    expect(edited.units[1]).not.toEqual(characters.units[1]);
});
test("small inputs stay single-call; long projects retain every episode and reference", () => {
    expect(workflowTextBatch([{ title: "短稿", content: "正文" }])).toBeUndefined();
    const sources = Array.from({ length: 12 }, (_, index) => ({ id: `body-${index}`, episodeNumber: index + 1, content: `开始${index}\n${"剧情\n".repeat(3500)}结束${index}`, asset: { evidence: `依据${index}` } }));
    const batch = workflowTextBatch(sources)!;
    expect(batch.version).toBe(1);
    sources.forEach((source) => {
        const units = batch.units.filter((unit) => unit.label.startsWith(`第 ${source.episodeNumber} 集 ·`));
        expect(units.map((unit) => unit.text).join("")).toContain(source.content);
        expect(units[0].text).toContain(source.asset.evidence);
    });
});
