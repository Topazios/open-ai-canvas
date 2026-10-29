import { expect, test } from "bun:test";
import { productionAssetBaseCode, productionAssetCodes } from "../src/lib/production-asset-code";
import { resolveProductionAssetReferences } from "../src/lib/canvas/production-asset-references";
import { bodySourceRecords } from "../src/lib/canvas/workflow-body-context";
import { episodeStoryboardCodes, resolveEpisodeShotAssets, storyboardPreviousFrameSource } from "../src/lib/canvas/workflow-episode-storyboard";
import { createCanvasNode, createStoryboardRow } from "../src/lib/canvas/canvas-project-domain";
import { CanvasNodeType } from "../src/types/canvas";

const project = "D001";
const token = "1234567890abcdef1234567890abcdef";
const characterCode = `CHR-${project}-001`;
const variantCode = `${characterCode}-V01`;
const sceneCode = `SCN-${project}-001`;

function fixture() {
    const character = createCanvasNode(CanvasNodeType.Text, { x: 0, y: 0 }, {
        content: "人物保持低沉声线，雨衣为指定状态。", status: "success",
        shortDrama: { pipelineId: "drama", stage: "story", step: "story.plan", role: "document", sourceNodeIds: [], sourceSignatures: {},
            assetIdentity: { id: "asset-one", code: characterCode, kind: "character" },
            assetProfile: { aliases: [], occurrences: [], variants: [{ code: variantCode, name: "雨衣", description: "带帽雨衣" }], sounds: [], conflicts: [], references: [] } },
    });
    character.title = "未在集纲提及的名字";
    const unrelated = { ...character, id: "unrelated", title: "无关人物", metadata: { ...character.metadata,
        shortDrama: { ...character.metadata!.shortDrama!, assetIdentity: { id: "asset-other", code: "CHR-0002", kind: "character" as const } } } };
    const outline = createCanvasNode(CanvasNodeType.Text, { x: 0, y: 0 }, { content: `## 第 1 集\n@${variantCode} 到达约定地点。`,
        shortDrama: { pipelineId: "drama", stage: "story", step: "story.episodes", role: "document", sourceNodeIds: [], sourceSignatures: {} } });
    const script = createCanvasNode(CanvasNodeType.Script, { x: 0, y: 0 }, {
        shortDrama: { pipelineId: "drama", stage: "storyboard", step: "direction.shots", role: "document", sourceNodeIds: [character.id], sourceSignatures: {} },
    });
    return { character, unrelated, outline, script };
}

test("all asset kinds and variants parse complete project identities and existing numeric codes", () => {
    for (const kind of ["CHR", "SCN", "PRP", "SPC", "AUD"]) {
        const base = `${kind}-${project}-001`;
        const variant = `${base}-V01`;
        expect(productionAssetCodes(`@${variant}，${base} @${variant} CHR-0056-V0001`)).toEqual([variant, base, "CHR-0056-V0001"]);
        expect(productionAssetCodes(`${base} @${variant}`, true)).toEqual([variant]);
        expect(productionAssetBaseCode(variant)).toBe(base);
        expect(productionAssetCodes(`${base}-INVALID ${base}z x${base}`)).toEqual([]);
        expect(episodeStoryboardCodes(`使用 @${variant}`)).toEqual([variant]);
    }
});

test("existing UUID codes and larger sequence numbers remain readable", () => {
    const longCode = `CHR-a1b2c3d4e5f6-${token}`;
    expect(productionAssetCodes(`@${longCode}-V${token} @CHR-D1000-1000-V100`)).toEqual([
        `${longCode}-V${token}`, "CHR-D1000-1000-V100",
    ]);
});

test("body and shot references resolve the exact project asset and variant without loading unrelated assets", () => {
    const f = fixture();
    const resolved = resolveProductionAssetReferences(`参考 @${variantCode}`, [f.character, f.unrelated]);
    expect(resolved.nodes.map(node => node.id)).toEqual([f.character.id]);
    expect(resolved.content).toContain("带帽雨衣");
    const records = bodySourceRecords([f.outline, f.character, f.unrelated], 1, "");
    expect(records.map(record => record.id)).toEqual([f.outline.id, f.character.id]);
    const row = createStoryboardRow(1, { videoMotionPrompt: `@${variantCode} 推门进入`, assetKeys: [] });
    expect(resolveEpisodeShotAssets(f.script, row, [f.character, f.unrelated, f.script]).codes).toEqual([variantCode]);
    expect(() => resolveProductionAssetReferences(`@CHR-ffffffffffff-${token}`, [f.character])).toThrow("不存在");
    expect(() => resolveProductionAssetReferences(`@${characterCode}-V${token}`, [f.character])).toThrow("状态不存在");
});

test("new state and scene identities protect frame inheritance across costume changes and scene cuts", () => {
    const before = createStoryboardRow(1, { id: "before", videoMotionPrompt: `@${characterCode} @${sceneCode}`, assetKeys: [] });
    const same = createStoryboardRow(2, { id: "after", videoMotionPrompt: `@${characterCode} @${sceneCode}`, assetKeys: [] });
    expect(storyboardPreviousFrameSource(same, [before, same])).toBe(before);
    const changed = { ...same, videoMotionPrompt: `@${variantCode} @${sceneCode}` };
    expect(storyboardPreviousFrameSource(changed, [before, changed])).toBeUndefined();
    const cut = { ...same, videoMotionPrompt: `@${characterCode} @SCN-ffffffffffff-${token}` };
    expect(storyboardPreviousFrameSource(cut, [before, cut])).toBeUndefined();
});
