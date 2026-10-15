import { getActiveUserScope } from "@/lib/user-scope";
import { localForageStorageForScope } from "@/lib/localforage-storage";
import type { TimelineProject } from "@/types/timeline";
import type { TimelineRenderResult } from "@/services/api/timeline-tasks";
import { loadProjectEditorTimeline, withProjectEditorStorageLock } from "@/services/project-editor-timeline";
import { captureDeliveryIssuePosition, isDeliveryIssuePosition, type DeliveryIssuePosition } from "@/lib/timeline/review-position";

export type DeliveryIssueSeverity = "blocker" | "major" | "minor";

export type DeliveryIssue = {
    id: string;
    severity: DeliveryIssueSeverity;
    note: string;
    createdAt: string;
    resolvedAt?: string;
    position?: DeliveryIssuePosition;
};

export type LocalDeliveryRecord = {
    projectId: string;
    unitId: string;
    resourceId: string;
    fileName?: string;
    size?: number;
    durationMs?: number;
    subtitleSrt?: string;
    timelineFingerprint: string;
    shotDependencyFingerprint?: string;
    renderedAt: string;
    updatedAt: string;
    reviewStatus: "pending" | "verified";
    issues: DeliveryIssue[];
};

export type DeliveryReadiness = { readyShotCount: number; totalShotCount: number; staleArtifactCount: number; currentTimelineFingerprint: string | null; currentShotDependencyFingerprint?: string | null };
export type DeliveryRecordVersion = Pick<LocalDeliveryRecord, "resourceId" | "timelineFingerprint" | "updatedAt">;

export function isLocalDeliveryCurrent(record: LocalDeliveryRecord | null | undefined, currentTimelineFingerprint: string | null) {
    return Boolean(record && currentTimelineFingerprint && record.timelineFingerprint === currentTimelineFingerprint);
}

export function canVerifyLocalDelivery(
    record: LocalDeliveryRecord | null | undefined,
    input: DeliveryReadiness,
) {
    return Boolean(
        record?.resourceId &&
        isLocalDeliveryCurrent(record, input.currentTimelineFingerprint) &&
        (input.currentShotDependencyFingerprint === undefined || (Boolean(input.currentShotDependencyFingerprint) && record.shotDependencyFingerprint === input.currentShotDependencyFingerprint)) &&
        input.totalShotCount > 0 &&
        input.readyShotCount === input.totalShotCount &&
        input.staleArtifactCount === 0 &&
        record.issues.every((issue) => Boolean(issue.resolvedAt)),
    );
}

const DELIVERY_KEY = "short-drama-delivery";

function storageKey(projectId: string, unitId: string) {
    return `${DELIVERY_KEY}:${projectId}:unit:${unitId}`;
}

export function timelineFingerprint(project: TimelineProject) {
    return JSON.stringify({ version: project.version, tracks: project.tracks, clips: project.clips, durationMs: project.durationMs });
}

export function buildLocalDeliveryRecord(input: { projectId: string; unitId: string; timeline: TimelineProject; result: TimelineRenderResult; shotDependencyFingerprint?: string; previous?: LocalDeliveryRecord | null; now?: string }): LocalDeliveryRecord {
    const now = input.now || new Date().toISOString();
    return {
        projectId: input.projectId,
        unitId: input.unitId,
        resourceId: input.result.resourceId,
        fileName: input.result.fileName,
        size: input.result.size,
        durationMs: input.result.durationMs,
        subtitleSrt: input.result.subtitleSrt,
        timelineFingerprint: timelineFingerprint(input.timeline),
        ...(input.shotDependencyFingerprint ? { shotDependencyFingerprint: input.shotDependencyFingerprint } : {}),
        renderedAt: now,
        updatedAt: now,
        reviewStatus: "pending",
        issues: input.previous?.issues || [],
    };
}

function parseRecord(raw: string | null): LocalDeliveryRecord | null {
    if (!raw) return null;
    try {
        const value = JSON.parse(raw) as Partial<LocalDeliveryRecord>;
        if (![value.projectId, value.unitId, value.resourceId, value.timelineFingerprint, value.updatedAt].every((item) => typeof item === "string" && item.length > 0) || !Array.isArray(value.issues)) throw new Error("审片记录不完整");
        if (value.issues.some((issue) => !issue || typeof issue.id !== "string" || typeof issue.note !== "string" || !["blocker", "major", "minor"].includes(issue.severity) || typeof issue.createdAt !== "string" || (issue.resolvedAt !== undefined && typeof issue.resolvedAt !== "string"))) throw new Error("审片问题记录不完整");
        if (value.issues.some((issue) => issue.position !== undefined && !isDeliveryIssuePosition(issue.position))) throw new Error("审片时间点记录不完整");
        return {
            projectId: value.projectId!,
            unitId: value.unitId!,
            resourceId: value.resourceId!,
            fileName: value.fileName,
            size: value.size,
            durationMs: value.durationMs,
            subtitleSrt: value.subtitleSrt,
            timelineFingerprint: value.timelineFingerprint!,
            ...(value.shotDependencyFingerprint ? { shotDependencyFingerprint: value.shotDependencyFingerprint } : {}),
            renderedAt: value.renderedAt || new Date(0).toISOString(),
            updatedAt: value.updatedAt || value.renderedAt || new Date(0).toISOString(),
            reviewStatus: value.reviewStatus === "verified" ? "verified" : "pending",
            issues: Array.isArray(value.issues) ? value.issues.filter(Boolean) as DeliveryIssue[] : [],
        };
    } catch {
        throw new Error("审片记录读取失败，请重试；原记录已保留");
    }
}

async function readRecord(projectId: string, unitId: string, scope: string) {
    const raw = await localForageStorageForScope(scope).getItem(storageKey(projectId, unitId));
    const record = parseRecord(raw);
    if (record && (record.projectId !== projectId || record.unitId !== unitId)) throw new Error("审片记录与当前项目或集数不一致");
    return record;
}

async function writeRecord(record: LocalDeliveryRecord, scope: string) {
    await localForageStorageForScope(scope).setItem(storageKey(record.projectId, record.unitId), JSON.stringify(record));
    return record;
}

export async function loadLocalDeliveryRecord(projectId: string, unitId: string, scope = getActiveUserScope()) {
    return readRecord(projectId, unitId, scope);
}

export async function loadLocalDeliverySnapshot(projectId: string, unitId: string, scope = getActiveUserScope()) {
    return withProjectEditorStorageLock(scope, projectId, unitId, async () => {
        const record = await readRecord(projectId, unitId, scope);
        const timeline = await loadProjectEditorTimeline(projectId, unitId, scope);
        return { record, ...(timeline ? { timeline } : {}), currentTimelineFingerprint: timeline ? timelineFingerprint(timeline) : null };
    });
}

export async function recordLocalDeliveryRender(input: { projectId: string; unitId: string; timeline: TimelineProject; result: TimelineRenderResult; shotDependencyFingerprint?: string; scope?: string }) {
    const scope = input.scope ?? getActiveUserScope();
    return withProjectEditorStorageLock(scope, input.projectId, input.unitId, async () => {
        const saved = await loadProjectEditorTimeline(input.projectId, input.unitId, scope);
        if (!saved || timelineFingerprint(saved) !== timelineFingerprint(input.timeline)) throw new Error("渲染期间时间线已修改或尚未保存，成片可下载，当前审片记录未替换");
        if (!input.result.resourceId) throw new Error("渲染结果缺少成片资源");
        const previous = await readRecord(input.projectId, input.unitId, scope);
        return writeRecord(buildLocalDeliveryRecord({ ...input, previous }), scope);
    }, true);
}

async function mutateRecord(projectId: string, unitId: string, expected: DeliveryRecordVersion, scope: string, change: (record: LocalDeliveryRecord) => Promise<LocalDeliveryRecord>) {
    return withProjectEditorStorageLock(scope, projectId, unitId, async () => {
        const current = await readRecord(projectId, unitId, scope);
        if (!current || current.resourceId !== expected.resourceId || current.timelineFingerprint !== expected.timelineFingerprint || current.updatedAt !== expected.updatedAt) {
            throw new Error("审片版本已更新，请刷新记录后重试；本次修改未覆盖新版本");
        }
        const next = await change(current);
        // 毫秒内连续操作也须产生新的并发版本标识。
        next.updatedAt = new Date(Math.max(Date.now(), (Date.parse(current.updatedAt) || 0) + 1)).toISOString();
        return writeRecord(next, scope);
    }, true);
}

export async function updateLocalDeliveryReview(projectId: string, unitId: string, reviewStatus: LocalDeliveryRecord["reviewStatus"], expected: DeliveryRecordVersion, readiness: DeliveryReadiness, scope = getActiveUserScope()) {
    return mutateRecord(projectId, unitId, expected, scope, async (current) => {
        const timeline = await loadProjectEditorTimeline(projectId, unitId, scope);
        const currentTimelineFingerprint = timeline ? timelineFingerprint(timeline) : null;
        if (reviewStatus === "verified" && !canVerifyLocalDelivery(current, { ...readiness, currentTimelineFingerprint })) throw new Error("当前成片与时间线不一致，或仍有未就绪镜头、过期产物及未关闭问题，无法确认通过");
        return { ...current, reviewStatus };
    });
}

export async function addLocalDeliveryIssue(projectId: string, unitId: string, severity: DeliveryIssueSeverity, note: string, expected: DeliveryRecordVersion, scope = getActiveUserScope(), position?: DeliveryIssuePosition) {
    if (!note.trim()) throw new Error("请填写审片问题");
    return mutateRecord(projectId, unitId, expected, scope, async (current) => {
        if (position) {
            if (!isDeliveryIssuePosition(position) || position.resourceId !== current.resourceId || position.timelineFingerprint !== current.timelineFingerprint) throw new Error("时间点属于旧审片文件，请重新定位后保存；问题草稿已保留");
            const canonical = captureDeliveryIssuePosition(current, position.timeMs, position.clipId);
            if (canonical.sourceTimeMs !== position.sourceTimeMs) throw new Error("片段时间点与审片快照不一致，请重新定位");
        }
        const issue: DeliveryIssue = { id: crypto.randomUUID(), severity, note: note.trim(), createdAt: new Date().toISOString() };
        if (position) issue.position = { ...position };
        return { ...current, reviewStatus: "pending", issues: [...current.issues, issue] };
    });
}

export async function resolveLocalDeliveryIssue(projectId: string, unitId: string, issueId: string, expected: DeliveryRecordVersion, scope = getActiveUserScope()) {
    return mutateRecord(projectId, unitId, expected, scope, async (current) => {
        if (!current.issues.some((issue) => issue.id === issueId)) throw new Error("审片问题已不存在，请刷新后重试");
        return { ...current, reviewStatus: "pending", issues: current.issues.map((issue) => issue.id === issueId ? { ...issue, resolvedAt: new Date().toISOString() } : issue) };
    });
}
