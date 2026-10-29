import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasStoryboardImageStack } from "@/components/canvas/canvas-storyboard-image-stack";
import { assetSheetShotMaterial } from "@/lib/asset-sheet-material";
import { AssetSheetKind } from "@/lib/asset-reference-sheet";

test("untouched frames are neutral pending generation, only actual failures are red", () => {
    const render = (status: string, error?: string) => renderToStaticMarkup(<CanvasStoryboardImageStack label="首尾帧" items={[{ id: "start", label: "首帧", status, error }]} onPreview={() => {}} />);
    expect(render("待生成")).toContain("待生成 1");
    expect(render("待生成")).toContain('data-failed="false"');
    expect(render("生成中")).toContain("处理中 1");
    expect(render("已暂停")).toContain("已暂停 1");
    expect(render("生成失败", "timeout")).toContain('data-failed="true"');
    expect(render("生成失败", "timeout")).toContain("失败 1");
});

test("selected references keep scale and current space without alternate costumes or narrative", () => {
    const character = "## 年龄感、体型、面部与辨识特征\n身高180cm，成年\n## 固定服装、配饰与材质配色\n日常、婚礼两套服装\n## 人物身份与剧情功能\n无关剧情";
    const selected = assetSheetShotMaterial(character, AssetSheetKind.Character, true);
    expect(selected).toContain("180cm");
    expect(selected).not.toContain("婚礼");
    expect(selected).not.toContain("无关剧情");
    expect(assetSheetShotMaterial(character, AssetSheetKind.Character, false)).toContain("婚礼");
    const scene = "## 空间布局、尺度与固定陈设\n宽8米，桌高80cm\n## 固定光源、日夜与天气光照\n雨夜和白天两种灯光";
    expect(assetSheetShotMaterial(scene, AssetSheetKind.Environment, true)).toContain("80cm");
    expect(assetSheetShotMaterial(scene, AssetSheetKind.Environment, true)).not.toContain("雨夜");
});
