import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "antd";
import { ArrowUpRight, Link2Off, RefreshCw } from "lucide-react";
import { Link } from "react-router";

import { sameCanvasContent } from "@/lib/canvas/canvas-content";
import { getActiveUserScope } from "@/lib/user-scope";
import { getProject, linkCanvasNodeShot, listCanvasNodeShotLinks, unlinkCanvasNodeShot, type CanvasNodeShotLink, type ProjectDetail, type ProjectShot, type ShotArtifact } from "@/services/api/projects";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { CanvasNodeData } from "@/types/canvas";
import { canvasShotStateLabels } from "@/lib/canvas/canvas-shot-projection";

type MappingPreview = {
    mode: "link" | "unlink";
    canvas: CanvasProject;
    projectRevision: number;
    nodeId: string;
    shotId: string;
    shotRevisionId: string;
    artifactId: string;
    before?: CanvasNodeShotLink;
};

function compatibleArtifact(node: CanvasNodeData | undefined, artifact: ShotArtifact, shot: ProjectShot | undefined) {
    if (!node || !shot || !artifact.selected || artifact.status !== "ready" || !artifact.resourceId || artifact.revisionId !== shot.currentRevisionId) return false;
    if (artifact.type === "video" || artifact.type === "delivery") return node.type === "video";
    if (artifact.type === "audio") return node.type === "audio";
    return ["storyboard", "action_board", "start_frame", "end_frame"].includes(artifact.type) && node.type === "image";
}

function mappingState(link: CanvasNodeShotLink | undefined, node: CanvasNodeData | undefined, detail: ProjectDetail | undefined) {
    if (!link) return "未关联";
    if (!node) return "节点已删除";
    const shot = detail?.shots.find((item) => item.id === link.shotId && item.unitId === link.unitId);
    if (!shot) return "镜头已删除";
    if (shot.currentRevisionId !== link.shotRevisionId) return "镜头已修订";
    if (link.artifactId) {
        const artifact = detail?.shotArtifacts.find((item) => item.id === link.artifactId);
        if (!artifact || artifact.shotId !== shot.id || !compatibleArtifact(node, artifact, shot)) return "产物已换版";
    }
    return "已关联";
}

export function CanvasNodeShotMapping({ canvasId, projectId, unitId, detail, onSave }: {
    canvasId: string; projectId: string; unitId: string; detail: ProjectDetail; onSave: () => Promise<boolean>;
}) {
    const scope = getActiveUserScope();
    const owner = `${scope}:${canvasId}:${projectId}:${unitId}`;
    const ownerRef = useRef(owner);
    ownerRef.current = owner;
    const alive = useRef(true);
    useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
    const isCurrent = () => alive.current && ownerRef.current === owner && getActiveUserScope() === scope;
    const queryClient = useQueryClient();
    const canvas = useCanvasStore((state) => state.projects.find((item) => item.id === canvasId));
    const linksQuery = useQuery({ queryKey: ["canvas-node-shot-links", scope, projectId, canvasId], queryFn: () => listCanvasNodeShotLinks(projectId, canvasId) });
    const links = linksQuery.data?.links || [];
    const views = useMemo(() => new Map(linksQuery.data?.views?.map((view) => [view.linkId, view])), [linksQuery.data?.views]);
    const stateFor = (link: CanvasNodeShotLink | undefined, node: CanvasNodeData | undefined) => {
        const state = mappingState(link, node, detail);
        if (state !== "已关联" || !link) return state;
        if (linksQuery.isError) return "读取失败，需刷新";
        const view = views.get(link.id);
        return view ? canvasShotStateLabels[view.state] : "已关联，内容待核验";
    };
    const [nodeId, setNodeId] = useState("");
    const [shotId, setShotId] = useState("");
    const [artifactId, setArtifactId] = useState("");
    const [search, setSearch] = useState("");
    const [preview, setPreview] = useState<MappingPreview | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const nodes = canvas?.nodes || [];
    const node = nodes.find((item) => item.id === nodeId);
    const selectedLink = links.find((item) => item.nodeId === nodeId);
    const shots = detail.shots.filter((item) => item.unitId === unitId).slice().sort((left, right) => left.position - right.position);
    const shot = shots.find((item) => item.id === shotId);
    const artifacts = detail.shotArtifacts.filter((item) => item.shotId === shotId && compatibleArtifact(node, item, shot));
    const nodeById = useMemo(() => new Map(nodes.map((item) => [item.id, item])), [nodes]);
    const orphans = links.filter((item) => !nodeById.has(item.nodeId));
    const filtered = [...nodes, ...orphans.map((item) => ({ id: item.nodeId, title: "已删除节点", type: "text" } as CanvasNodeData))]
        .filter((item) => `${item.title} ${item.id}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
    const currentCount = links.filter((item) => stateFor(item, nodeById.get(item.nodeId)) === "已关联").length;
    const previewStale = Boolean(preview && (!canvas || canvas.revision !== preview.canvas.revision || !sameCanvasContent(canvas, preview.canvas)
        || detail.project.revision > preview.projectRevision
        || preview.nodeId !== nodeId || (preview.mode === "link" && (preview.shotId !== shotId || preview.artifactId !== artifactId))));

    useEffect(() => {
        if (!nodeId && nodes[0]) setNodeId(nodes[0].id);
    }, [nodeId, nodes]);

    const selectNode = (nextId: string) => {
        const existing = links.find((item) => item.nodeId === nextId);
        const nextNode = nodeById.get(nextId);
        const nextShot = shots.find((item) => item.id === existing?.shotId);
        const nextArtifact = detail.shotArtifacts.find((item) => item.id === existing?.artifactId);
        setNodeId(nextId);
        setShotId(nextShot?.id || "");
        setArtifactId(nextArtifact && compatibleArtifact(nextNode, nextArtifact, nextShot) ? nextArtifact.id : "");
        setPreview(null);
        setError("");
        setNotice("");
    };

    const loadPreview = async (mode: "link" | "unlink") => {
        if (busy || !nodeId || (mode === "link" && (!node || !shotId)) || (mode === "unlink" && !selectedLink)) return;
        setBusy(true); setError(""); setNotice(""); setPreview(null);
        try {
            if (!await onSave()) throw new Error("画布尚未保存到云端，请先处理保存错误");
            if (!isCurrent()) return;
            const saved = useCanvasStore.getState().openProject(canvasId);
            if (!saved || !Number.isSafeInteger(saved.revision) || saved.revision! < 1) throw new Error("画布版本不可用，请刷新后重试");
            const [freshDetail, freshLinks] = await Promise.all([getProject(projectId), listCanvasNodeShotLinks(projectId, canvasId)]);
            if (!isCurrent()) return;
            const before = (freshLinks.links || []).find((item) => item.nodeId === nodeId);
            if (mode === "unlink" && (!before || before.id !== selectedLink?.id)) throw new Error("映射已变化，请刷新列表");
            if (mode === "link") {
                if (!freshDetail.canvasUnitLinks.some((item) => item.canvasId === canvasId && item.unitId === unitId)) throw new Error("画布尚未关联目标章节");
                if (!saved.nodes.some((item) => item.id === nodeId)) throw new Error("画布节点已删除，请重新选择");
                const target = freshDetail.shots.find((item) => item.id === shotId && item.unitId === unitId);
                if (!target?.currentRevisionId) throw new Error("镜头已变化或不属于当前章节，请刷新");
                if (artifactId && !freshDetail.shotArtifacts.some((item) => item.id === artifactId && item.shotId === shotId && compatibleArtifact(saved.nodes.find((candidate) => candidate.id === nodeId), item, target))) throw new Error("所选产物不再是当前采用版本，请刷新");
                setPreview({ mode, canvas: saved, projectRevision: freshDetail.project.revision, nodeId, shotId, shotRevisionId: target.currentRevisionId, artifactId, before });
            } else {
                setPreview({ mode, canvas: saved, projectRevision: freshDetail.project.revision, nodeId, shotId: before!.shotId, shotRevisionId: before!.shotRevisionId, artifactId: before!.artifactId || "", before });
            }
        } catch (cause) {
            if (isCurrent()) setError(cause instanceof Error ? cause.message : "映射预览失败");
        } finally { if (isCurrent()) setBusy(false); }
    };

    const confirm = async () => {
        if (!preview || previewStale || busy) return;
        setBusy(true); setError("");
        try {
            const live = useCanvasStore.getState().openProject(canvasId);
            if (!live || live.revision !== preview.canvas.revision || !sameCanvasContent(live, preview.canvas)) throw new Error("画布已变化，请重新预览");
            if (preview.mode === "link") {
                await linkCanvasNodeShot(projectId, canvasId, { unitId, nodeId: preview.nodeId, shotId: preview.shotId, artifactId: preview.artifactId || undefined, expectedCanvasRevision: preview.canvas.revision!, expectedProjectRevision: preview.projectRevision });
            } else {
                await unlinkCanvasNodeShot(projectId, canvasId, preview.nodeId, { expectedLinkId: preview.before!.id, expectedProjectRevision: preview.projectRevision });
            }
            if (!isCurrent()) return;
            setPreview(null);
            setNotice(preview.mode === "unlink" ? "已解除节点映射，项目镜头保留" : "节点映射已保存");
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: ["project", projectId] }),
                queryClient.invalidateQueries({ queryKey: ["canvas-node-shot-links", scope, projectId, canvasId] }),
            ]);
        } catch (cause) {
            if (isCurrent()) setError(cause instanceof Error ? cause.message : "保存节点映射失败");
        } finally { if (isCurrent()) setBusy(false); }
    };

    return <section aria-label="画布节点与项目镜头映射" className="border-t border-border pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
            <div><h3 className="text-sm font-semibold">节点与镜头映射</h3><p className="mt-1 text-xs text-foreground/55">{currentCount} 项当前关联 · {links.length - currentCount} 项待复核或解除</p></div>
            <Button size="small" icon={<RefreshCw className="size-3.5" />} disabled={busy} loading={linksQuery.isFetching} onClick={() => { setPreview(null); void linksQuery.refetch(); void queryClient.invalidateQueries({ queryKey: ["project", projectId] }); }}>刷新</Button>
        </div>
        <p className="mt-2 text-xs leading-5 text-foreground/55">关联后显示项目镜头的只读视图，可切回原节点；原画布内容保留，镜头与产物仍在项目工作台编辑。</p>
        {linksQuery.isError ? <p role="alert" className="mt-2 text-xs text-[var(--status-error)]">读取节点映射失败：{linksQuery.error instanceof Error ? linksQuery.error.message : "请重试"}</p> : null}
        {shots.length === 0 ? <p className="mt-3 text-xs">当前章节没有镜头。<Link to={`/projects/${projectId}/workflow/${unitId}/storyboard`} className="text-[var(--workspace-accent)]">打开分镜工作台</Link></p> : null}
        <div className="mt-3 grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
            <div className="min-w-0">
                <input aria-label="搜索画布节点" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索节点名称或 ID" className="h-9 w-full rounded-md border border-border bg-surface px-2 text-xs" />
                <div role="list" aria-label="画布节点映射列表" className="mt-2 max-h-60 overflow-y-auto border-y border-border">
                    {filtered.slice(0, 100).map((item) => {
                        const link = links.find((candidate) => candidate.nodeId === item.id);
                        return <button key={item.id} type="button" role="listitem" disabled={busy} aria-current={nodeId === item.id ? "true" : undefined} onClick={() => selectNode(item.id)} className="flex w-full items-center justify-between gap-2 border-b border-border/60 px-2 py-2 text-left text-xs hover:bg-foreground/5" style={nodeId === item.id ? { background: "var(--workspace-accent-soft)" } : undefined}>
                            <span className="min-w-0 truncate">{item.title || item.id}</span><span className="shrink-0 text-foreground/50">{stateFor(link, nodeById.get(item.id))}</span>
                        </button>;
                    })}
                </div>
                {filtered.length > 100 ? <p className="mt-1 text-xs text-foreground/50">显示前 100 项，请搜索定位其余节点</p> : null}
            </div>
            <div className="min-w-0 space-y-3">
                <div className="text-xs"><span className="text-foreground/55">当前节点：</span>{node?.title || (selectedLink ? "已删除节点" : "请选择节点")}</div>
                {selectedLink ? <p className="text-xs text-foreground/60">现有关联：{detail.shots.find((item) => item.id === selectedLink.shotId)?.title || "镜头已删除"} · {stateFor(selectedLink, node)}</p> : null}
                <label className="block space-y-1 text-xs"><span>目标镜头</span><select aria-label="目标项目镜头" disabled={busy || !node || !shots.length} value={shotId} onChange={(event) => { setShotId(event.target.value); setArtifactId(""); setPreview(null); }} className="h-9 w-full rounded-md border border-border bg-surface px-2"><option value="">选择当前章节镜头</option>{shots.map((item) => <option key={item.id} value={item.id}>{item.position + 1}. {item.title}</option>)}</select></label>
                <label className="block space-y-1 text-xs"><span>已采用产物版本（可选）</span><select aria-label="关联已采用产物" disabled={busy || !node || !shot} value={artifactId} onChange={(event) => { setArtifactId(event.target.value); setPreview(null); }} className="h-9 w-full rounded-md border border-border bg-surface px-2"><option value="">仅关联镜头修订</option>{artifacts.map((item) => <option key={item.id} value={item.id}>{item.type} · v{item.version}</option>)}</select></label>
                {preview ? <div role="region" aria-label="节点镜头映射预览" className="break-words border-y border-border py-2 text-xs leading-6">
                    <p>节点：{node?.title || preview.nodeId}</p>
                    <p>原关联：{preview.before ? `${detail.shots.find((item) => item.id === preview.before?.shotId)?.title || "已删除镜头"} / ${preview.before.shotRevisionId}` : "无"}</p>
                    <p>新关联：{preview.mode === "unlink" ? "解除关联（项目镜头保留）" : `${shot?.title || preview.shotId} / ${preview.shotRevisionId}${preview.artifactId ? ` / ${preview.artifactId}` : ""}`}</p>
                    {previewStale ? <p role="status" className="text-[var(--status-warning)]">画布、项目或选择已变化，请重新预览。</p> : null}
                </div> : null}
                <div className="flex flex-wrap gap-2">
                    <Button size="small" icon={<RefreshCw className="size-3.5" />} loading={busy && !preview} disabled={busy || !node || !shot} onClick={() => void loadPreview("link")}>保存画布并预览映射</Button>
                    {selectedLink ? <Button size="small" icon={<Link2Off className="size-3.5" />} disabled={busy} onClick={() => void loadPreview("unlink")}>预览解除</Button> : null}
                    <Button size="small" type="primary" aria-label={preview?.mode === "unlink" ? "确认解除" : "确认映射"} disabled={!preview || previewStale || busy} loading={busy && Boolean(preview)} onClick={() => void confirm()}>确认{preview?.mode === "unlink" ? "解除" : "映射"}</Button>
                </div>
                {shot ? <Link className="inline-flex items-center gap-1 text-xs text-[var(--workspace-accent)]" to={`/projects/${projectId}/workflow/${unitId}/storyboard`} onClick={() => sessionStorage.setItem(`project-workflow-selected-shot:${projectId}`, shot.id)}>打开目标镜头<ArrowUpRight className="size-3.5" /></Link> : null}
            </div>
        </div>
        {error ? <p role="alert" className="mt-2 break-words text-xs text-[var(--status-error)]">{error}</p> : null}
        {notice ? <p role="status" className="mt-2 text-xs">{notice}</p> : null}
    </section>;
}
