import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EditorShotReplacementPreview } from "../src/pages/projects/detail/editor-shot-replacement-preview";
import { planShotReplacement } from "../src/lib/timeline/shot-replacement";
import type { ShotAssemblyInput } from "../src/lib/timeline/shot-assembly";

function fixture(): ShotAssemblyInput {
    return {
        projectId: "p", unitId: "u",
        shots: [{ id: "s", projectId: "p", unitId: "u", currentRevisionId: "r", title: "替换测试镜头", description: "", position: 1, durationMs: 4000, status: "ready", createdAt: "", updatedAt: "" }],
        artifacts: [{ id: "new", projectId: "p", unitId: "u", shotId: "s", revisionId: "r", resourceId: "new-resource", type: "video", status: "ready", selected: true, version: 2, metadataJson: "{}", createdAt: "", updatedAt: "" }],
        media: { "new-resource": { durationMs: 6000 } },
        timeline: { version: 2, durationMs: 4000, tracks: [{ id: "v", kind: "video", label: "V", order: 0 }], clips: [{ id: "c", kind: "video", nodeId: "old-node", trackId: "v", startMs: 1000, durationMs: 3000, sourceStartMs: 1000, sourceDurationMs: 5000,
            shotSource: { projectId: "p", unitId: "u", shotId: "s", revisionId: "r", artifactId: "old", resourceId: "old-resource" },
            directMedia: { id: "old", kind: "video", title: "old", storageKey: "resource:old-resource" } }] },
    };
}

function render(input: ShotAssemblyInput, busy = false) {
    return renderToStaticMarkup(<EditorShotReplacementPreview plan={planShotReplacement(input, "s")} artifacts={input.artifacts} busy={busy} error={null}
        onClose={() => {}} onRefresh={() => {}} onReplace={() => {}} onLocate={() => {}} />);
}

function confirmationButton(markup: string) {
    return (markup.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) || []).find((button) => button.includes("替换 1 个片段"));
}

test("real replacement component renders source comparison, retained intervals and a single media player", () => {
    const markup = render(fixture());
    expect(markup).toContain("镜头素材替换对照");
    expect(markup).toContain("原素材时长");
    expect(markup).toContain("5.00 秒");
    expect(markup).toContain("6.00 秒");
    expect(markup).toContain("保留源区间");
    expect(markup).toContain("替换 1 个片段");
    expect(markup.match(/<video /g)).toHaveLength(1);
    expect(markup).toContain("new-resource");
    expect(confirmationButton(markup)).not.toMatch(/^<button[^>]*\sdisabled=/);
});

test("a too-short resource displays the correction reason and disables replacement", () => {
    const input = fixture();
    input.media["new-resource"].durationMs = 2000;
    const markup = render(input);
    expect(markup).toContain("需读取到 4.00 秒");
    expect(markup).toContain("新素材仅 2.00 秒");
    expect(confirmationButton(markup)).toMatch(/^<button[^>]*disabled=""/);
});

test("checking or a gesture in progress disables confirmation", () => {
    expect(confirmationButton(render(fixture(), true))).toMatch(/^<button[^>]*disabled=""/);
});
