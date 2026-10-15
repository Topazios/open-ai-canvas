import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { shortDramaStages } from "../src/lib/short-drama-stages";

const workflow = readFileSync(new URL("../src/pages/projects/detail/workflow-shared.tsx", import.meta.url), "utf8");
const workflowPage = readFileSync(new URL("../src/pages/projects/detail/workflow.tsx", import.meta.url), "utf8");
const editor = readFileSync(new URL("../src/pages/projects/detail/editor.tsx", import.meta.url), "utf8");
const workflowStages = readFileSync(new URL("../src/pages/projects/detail/workflow-stage-views.tsx", import.meta.url), "utf8");
const editorExport = readFileSync(new URL("../src/lib/plugins/builtin/editor/editor-export.tsx", import.meta.url), "utf8");
const deliveryStore = readFileSync(new URL("../src/services/short-drama-delivery-store.ts", import.meta.url), "utf8");
const deliveryStage = readFileSync(new URL("../src/pages/projects/detail/workflow-stage-views.tsx", import.meta.url), "utf8");
const shotDependencies = readFileSync(new URL("../src/lib/timeline/shot-dependencies.ts", import.meta.url), "utf8");
const overview = readFileSync(new URL("../src/pages/projects/detail/overview.tsx", import.meta.url), "utf8");
const workflowShared = readFileSync(new URL("../src/pages/projects/detail/workflow-shared.tsx", import.meta.url), "utf8");
const router = readFileSync(new URL("../src/router.tsx", import.meta.url), "utf8");

test("short drama workflow exposes the eight planned stages while retaining previz compatibility", () => {
    for (const key of ["story", "assets", "storyboard", "voice", "video", "edit", "review", "delivery"]) {
        expect(shortDramaStages.some((stage) => stage.key === key)).toBe(true);
    }
    expect(workflow).toContain("export const workflowStages = shortDramaStages");
    expect(workflow).toContain('if (stage === "previz") return "previz"');
    expect(workflowPage).toContain("activeStage === \"voice\"");
    expect(workflowPage).toContain("activeStage === \"review\"");
    expect(workflowStages).toContain("台词、旁白与声音设计");
    expect(workflowStages).toContain("角色声线与试听");
    expect(workflowStages).toContain("音画对齐与混音");
    expect(workflowStages).toContain("parseVoiceTiming");
    expect(workflowStages).toContain("项目画风与视觉规范");
    expect(workflowStages).toContain("剧本提取候选与归并");
    expect(workflowStages).toContain("角色版本与声音画像");
    expect(workflowStages).toContain("资产版本与一致性确认");
    expect(workflowStages).toContain("制作设置");
    expect(workflowStages).toContain("原稿导入与章节结构");
    expect(workflowStages).toContain("剧情开发");
    expect(workflowStages).toContain("分集 / 场次脚本");
    expect(workflowStages).toContain("剧本审核");
    for (const key of [
        "story.setup", "story.import", "story.develop", "story.script", "story.approve",
        "assets.style", "assets.extract", "assets.characters", "assets.environments", "assets.approve",
        "voice.dialogue", "voice.casting", "voice.recording", "voice.timing",
    ]) {
        expect(workflowStages).toContain(`data-task-key={task.id}`);
        expect(workflowStages).toContain(`id: "${key}"`);
    }
});

test("current-unit editor route and audio artifact sync remain part of the existing editor", () => {
    expect(router).toContain('path: "/projects/:projectId/editor/:unitId"');
    expect(editor).toContain("const timelineScope = unitId ? `${projectId}:unit:${unitId}` : projectId;");
    expect(editor).toContain('"video", "audio", "delivery"');
    expect(editor).toContain('label: "当前集镜头"');
    expect(editor).toContain("<EditorShotAssembly detail={detail} unitId={unitId} assets={assets} store={store}");
    expect(editor).toContain("await loadProjectEditorTimeline(projectId, unitId, scope)");
    expect(editor).toContain("时间线读取失败：");
});

test("rendered timeline results remain recoverable in review and delivery stages", () => {
    expect(editorExport).toContain("onDeliveryRender");
    expect(editorExport).toContain("await onDeliveryRender");
    expect(deliveryStore).toContain("recordLocalDeliveryRender");
    expect(deliveryStore).toContain("addLocalDeliveryIssue");
    expect(workflowStages).toContain("loadLocalDeliverySnapshot");
    expect(workflowStages).toContain("标记审片通过");
    expect(workflowStages).toContain("下载已核验成片");
    expect(workflowStages).toContain("下载待复核成片");
    expect(workflowStages).toContain("currentTimelineFingerprint");
    expect(editor).toContain("result, timeline, scope");
    expect(deliveryStore).toContain("canVerifyLocalDelivery");
    expect(deliveryStore).toContain("shotDependencyFingerprint");
    expect(deliveryStage).toContain("assessShotTimelineDependencies");
    expect(editor).toContain("shotDependencyFingerprint({ projectId, unitId");
    expect(shotDependencies).toContain("已改选视频，但时间线仍引用旧版本");
    expect(deliveryStage).toContain("readyShotCount: readyVideos.length");
    expect(deliveryStage).toContain("staleArtifactCount: stale");
    expect(deliveryStage).toContain('shots.length === 0 ? "当前集还没有镜头"');
    expect(overview).toContain('metric: metrics.shotCount > 0 && metrics.readyVideoCount === metrics.shotCount && metrics.staleArtifactCount === 0 ? "待质检确认"');
    expect(overview).toContain('description: "所有镜头视频已就绪，先完成质检再确认交付。"');
    expect(overview).toContain('href: reviewHref');
    expect(overview).toContain('complete: metrics.unitCount > 0 && metrics.unitsWithoutText === 0');
    expect(overview).toContain('complete: metrics.assetCount > 0 && metrics.pendingCandidateCount === 0');
    expect(overview).toContain('complete: metrics.shotCount > 0 && metrics.readyStoryboardCount === metrics.shotCount');
    expect(overview).toContain('metrics.staleArtifactCount === 0');
    expect(workflowShared).toContain('const skipped = step?.status === "skipped";');
    expect(workflowShared).toContain('className="size-3" /> : index + 1');
    expect(workflowShared).toContain('title={skipped ? "此阶段已跳过" : undefined}');
});
