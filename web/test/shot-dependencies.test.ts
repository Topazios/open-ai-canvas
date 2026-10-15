import { describe, expect, test } from "bun:test";
import { assessShotTimelineDependencies, shotDependencyFingerprint } from "../src/lib/timeline/shot-dependencies";
import { normalizeTimelineProject } from "../src/lib/timeline/timeline-tracks";
import { planShotAssembly } from "../src/lib/timeline/shot-assembly";
import { getEditorCommandRegistry } from "../src/lib/timeline/editor-commands";
import type { ProjectShot, ShotArtifact } from "../src/services/api/projects";

const shot: ProjectShot = { id: "s1", projectId: "p", unitId: "u", currentRevisionId: "rev-1", title: "镜头一", description: "", position: 1, durationMs: 3000, status: "ready", createdAt: "", updatedAt: "" };
const artifact: ShotArtifact = { id: "a1", projectId: "p", unitId: "u", shotId: "s1", revisionId: "rev-1", type: "video", version: 1, resourceId: "r1", status: "ready", selected: true, metadataJson: "{}", createdAt: "", updatedAt: "" };

function assembled() {
    const input = { projectId: "p", unitId: "u", shots: [shot], artifacts: [artifact], media: { r1: { durationMs: 3000 } }, timeline: normalizeTimelineProject(null) };
    const plan = planShotAssembly(input);
    return { ...input, timeline: plan.commands.reduce((state, command) => getEditorCommandRegistry().apply(state, command), input.timeline) };
}

describe("shot source dependencies", () => {
    test("a current adopted source matches the timeline", () => {
        const input = assembled();
        const report = assessShotTimelineDependencies(input);
        expect(report.ok).toBe(true);
        expect(report.blockers).toEqual([]);
        expect(report.currentFingerprint).toBe(shotDependencyFingerprint(input));
    });

    test("changing selected artifact while leaving timeline untouched reports the old source", () => {
        const input = assembled();
        const changed = { ...input, artifacts: [{ ...artifact, id: "a2", resourceId: "r2", version: 2 }] };
        const report = assessShotTimelineDependencies(changed);
        expect(report.ok).toBe(false);
        expect(report.blockers.join(" ")).toContain("改选视频");
        expect(report.currentFingerprint).not.toBe(shotDependencyFingerprint(input));
    });

    test("a changed shot revision, unready candidate and missing timeline clip block confirmation", () => {
        const input = assembled();
        expect(assessShotTimelineDependencies({ ...input, shots: [{ ...shot, currentRevisionId: "rev-2" }] }).blockers.join(" ")).toContain("采用视频已过期");
        expect(assessShotTimelineDependencies({ ...input, artifacts: [{ ...artifact, status: "running" }] }).ok).toBe(false);
        expect(assessShotTimelineDependencies({ ...input, timeline: normalizeTimelineProject(null) }).blockers.join(" ")).toContain("尚未进入");
    });

    test("deleted source clips remain visible as blockers and current shots cannot silently pass", () => {
        const input = assembled();
        const report = assessShotTimelineDependencies({ ...input, shots: [] });
        expect(report.ok).toBe(false);
        expect(report.blockers.join(" ")).toContain("没有可核对");
        expect(report.blockers.join(" ")).toContain("来源镜头已删除");
    });

    test("unrelated projects and units do not affect the dependency fingerprint", () => {
        const input = assembled();
        const expanded = { ...input, shots: [...input.shots, { ...shot, id: "foreign-unit", unitId: "other" }, { ...shot, id: "foreign-project", projectId: "other" }], artifacts: input.artifacts };
        expect(shotDependencyFingerprint(expanded)).toBe(shotDependencyFingerprint(input));
    });
});
