import { ArrowRight, FolderInput, RefreshCw } from "lucide-react";
import { Button } from "antd";
import { Link, useNavigate } from "react-router";
import type { ProjectUnit } from "@/services/api/projects";
import type { TimelineProject } from "@/types/timeline";
import { formatTimelineTime } from "@/lib/timeline/timeline-view";

export function EditorLegacyTimelinePreview({ projectId, unitId, units, source, assignedUnitId, busy, error, onAssign, onEmpty, onRefresh }: {
    projectId: string; unitId: string; units: ProjectUnit[]; source: TimelineProject; assignedUnitId?: string;
    busy: boolean; error: string | null; onAssign: () => void; onEmpty: () => void; onRefresh: () => void;
}) {
    const navigate = useNavigate();
    const assignedUnit = units.find((unit) => unit.id === assignedUnitId);
    const conflictingSources = source.clips.some((clip) => [clip.shotSource, clip.voiceSource].some((reference) => reference && (reference.projectId !== projectId || reference.unitId !== unitId)));
    const kinds = { video: "视频", audio: "音频", image: "图片", subtitle: "字幕", text: "文字" };
    return <section className="flex h-full min-h-0 flex-col overflow-hidden bg-surface text-foreground" aria-label="旧项目剪辑归属预览">
        <header className="shrink-0 border-b border-border px-5 py-4">
            <h2 className="text-base font-semibold">旧项目剪辑归属</h2>
            <p className="mt-2 text-xs text-foreground/60">原项目剪辑保留。确认归属后，当前集沿用原有片段、剪辑点、字幕和素材引用。</p>
            <div className="mt-4 flex flex-wrap items-center gap-4 text-xs">
                <label className="flex items-center gap-2">目标集数
                    <select className="h-8 max-w-full rounded-md border border-border bg-transparent px-2" aria-label="旧剪辑目标集数" disabled={busy} value={unitId} onChange={(event) => navigate(`/projects/${projectId}/editor/${event.target.value}`)}>
                        {units.map((unit) => <option key={unit.id} value={unit.id}>{unit.title}</option>)}
                    </select>
                </label>
                <span>{source.clips.length} 个片段 · {source.tracks.length} 条轨道 · {formatTimelineTime(source.durationMs)}</span>
            </div>
            {assignedUnitId ? <p role="status" className="mt-3 text-xs text-[var(--status-warning)]">旧剪辑已归属「{assignedUnit?.title || "其他集"}」，不能重复分配。</p> : conflictingSources ? <p role="status" className="mt-3 text-xs text-[var(--status-warning)]">部分片段绑定其他项目或集数，请选择对应集数。归属不会重写镜头来源。</p> : null}
            {error ? <p role="alert" className="mt-3 text-xs text-[var(--status-error)]">{error}</p> : null}
        </header>
        <div className="min-h-0 flex-1 overflow-auto px-5" data-canvas-wheel-scroll>
            <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-surface text-foreground/55"><tr><th className="py-3 font-normal">片段</th><th className="px-3 font-normal">类型</th><th className="px-3 font-normal">开始</th><th className="font-normal">时长</th></tr></thead>
                <tbody>{source.clips.slice().sort((a, b) => a.startMs - b.startMs).map((clip) => <tr key={clip.id} className="border-t border-border/60">
                    <td className="max-w-72 break-words py-3">{clip.title || clip.directMedia?.title || clip.text || "未命名片段"}</td>
                    <td className="whitespace-nowrap px-3">{kinds[clip.kind]}</td><td className="whitespace-nowrap px-3 tabular-nums">{formatTimelineTime(clip.startMs)}</td><td className="whitespace-nowrap tabular-nums">{formatTimelineTime(clip.durationMs)}</td>
                </tr>)}</tbody>
            </table>
        </div>
        <footer className="flex shrink-0 flex-wrap items-center gap-3 border-t border-border px-5 py-4 text-xs">
            <Button type="primary" icon={<FolderInput className="size-4" />} loading={busy} disabled={Boolean(assignedUnitId) || conflictingSources} onClick={onAssign}>确认归属到当前集</Button>
            <button type="button" className="h-9 rounded-md border border-border px-3 disabled:opacity-40" disabled={busy} onClick={onEmpty}>从空白开始</button>
            <button type="button" className="grid size-9 place-items-center rounded-md border border-border disabled:opacity-40" disabled={busy} onClick={onRefresh} aria-label="刷新归属预览" title="刷新归属预览"><RefreshCw className="size-4" /></button>
            {assignedUnit ? <Link className="inline-flex items-center gap-1 text-[var(--workspace-accent)]" to={`/projects/${projectId}/editor/${assignedUnit.id}`}>打开已归属剪辑<ArrowRight className="size-4" /></Link> : null}
        </footer>
    </section>;
}
