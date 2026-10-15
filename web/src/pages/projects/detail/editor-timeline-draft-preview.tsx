import { useState } from "react";
import { Button } from "antd";
import { History, RefreshCw } from "lucide-react";
import type { ProjectTimelineDraft } from "@/services/project-editor-timeline";
import type { TimelineProject } from "@/types/timeline";
import { formatTimelineTime } from "@/lib/timeline/timeline-view";

export function EditorTimelineDraftPreview({ current, drafts, busy, error, onRestore, onContinue, onRefresh }: {
    current: TimelineProject | null; drafts: ProjectTimelineDraft[]; busy: boolean; error: string | null;
    onRestore: (draft: ProjectTimelineDraft) => void; onContinue: () => void; onRefresh: () => void;
}) {
    const [selectedId, setSelectedId] = useState(drafts.find((draft) => draft.reason === "save-failed")?.id || drafts[0]?.id);
    const selected = drafts.find((draft) => draft.id === selectedId) || drafts[0];
    return <section className="flex h-full min-h-0 flex-col overflow-hidden bg-surface text-foreground" aria-label="本机剪辑草稿恢复">
        <header className="shrink-0 border-b border-border px-5 py-4">
            <h2 className="text-base font-semibold">本机剪辑草稿</h2>
            <p className="mt-2 text-xs text-foreground/60">恢复后，所选草稿成为当前剪辑。当前版本保留为恢复前备份；其他页面仍有修改时，需要重新核对。</p>
            <label className="mt-4 flex flex-wrap items-center gap-2 text-xs">选择草稿
                <select aria-label="选择剪辑草稿" className="h-8 max-w-full rounded-md border border-border bg-surface px-2" value={selected?.id || ""} disabled={busy} onChange={(event) => setSelectedId(event.target.value)}>
                    {drafts.map((draft) => <option key={draft.id} value={draft.id}>{draft.reason === "save-failed" ? "未保存修改" : "恢复前备份"} · {new Date(draft.savedAt).toLocaleString()} · {draft.snapshot.clips.length} 个片段</option>)}
                </select>
            </label>
            {error ? <p role="alert" className="mt-3 break-words text-xs text-[var(--status-error)]">{error}</p> : null}
        </header>
        <div className="min-h-0 flex-1 overflow-auto px-5 py-4" data-canvas-wheel-scroll>
            <div className="grid gap-6 md:grid-cols-2">
                {[{ title: "当前已保存剪辑", timeline: current }, { title: "所选草稿", timeline: selected?.snapshot }].map(({ title, timeline }) => <section key={title} aria-label={title} className="min-w-0">
                    <h3 className="text-sm font-medium">{title}</h3>
                    <p className="my-3 text-xs text-foreground/60">{timeline ? `${timeline.clips.length} 个片段 · ${timeline.tracks.length} 条轨道 · ${formatTimelineTime(timeline.durationMs)}` : "尚无已保存剪辑"}</p>
                    <ul className="divide-y divide-border text-xs">
                        {timeline?.clips.map((clip) => <li key={clip.id} className="break-words py-3">
                            <p>{clip.title || clip.directMedia?.title || clip.text || "未命名片段"}</p>
                            {clip.text && clip.text !== clip.title ? <p className="mt-1 whitespace-pre-wrap text-foreground/60">{clip.text}</p> : null}
                            <p className="mt-1 tabular-nums text-foreground/60">开始 {formatTimelineTime(clip.startMs)} · 时长 {formatTimelineTime(clip.durationMs)}</p>
                        </li>)}
                    </ul>
                </section>)}
            </div>
        </div>
        <footer className="flex shrink-0 flex-wrap items-center gap-3 border-t border-border px-5 py-4 text-xs">
            <Button type="primary" icon={<History className="size-4" />} loading={busy} disabled={!selected} onClick={() => selected && onRestore(selected)}>恢复草稿并保留当前版本</Button>
            <button type="button" disabled={busy} onClick={onContinue} className="h-9 rounded-md border border-border px-3 disabled:opacity-40">继续当前剪辑</button>
            <button type="button" disabled={busy} onClick={onRefresh} aria-label="刷新草稿预览" title="刷新草稿预览" className="grid size-9 place-items-center rounded-md border border-border disabled:opacity-40"><RefreshCw className="size-4" /></button>
        </footer>
    </section>;
}
