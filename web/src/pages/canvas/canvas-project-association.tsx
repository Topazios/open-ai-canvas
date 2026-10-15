import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { Button } from "antd";
import { ArrowUpRight, Link2, RefreshCw } from "lucide-react";
import { AppModal } from "@/components/ui/product/app-modal";
import { getProject, linkCanvasUnit, listProjects, listProjectUnits, type ProjectUnit } from "@/services/api/projects";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { getActiveUserScope } from "@/lib/user-scope";
import { sameCanvasContent } from "@/lib/canvas/canvas-content";
import { shortDramaStages } from "@/lib/short-drama-stages";
import { CanvasNodeShotMapping } from "./canvas-node-shot-mapping";

export function CanvasProjectAssociation({ canvasId, onClose, onSave, onReload }: {
    canvasId: string; onClose: () => void; onSave: () => Promise<boolean>; onReload: () => Promise<void>;
}) {
    const scope = getActiveUserScope();
    const owner = JSON.stringify([scope, canvasId]);
    const ownerRef = useRef(owner);
    ownerRef.current = owner;
    const alive = useRef(true);
    useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
    const isCurrent = () => alive.current && ownerRef.current === owner && getActiveUserScope() === scope;
    const queryClient = useQueryClient();
    const current = useCanvasStore((state) => state.projects.find((project) => project.id === canvasId));
    const [projectId, setProjectId] = useState(current?.projectId || "");
    const [unitId, setUnitId] = useState("");
    const [preview, setPreview] = useState<{ canvas: CanvasProject; unit: ProjectUnit; projectName: string } | null>(null);
    const [linked, setLinked] = useState<{ projectId: string; unitId: string; unitTitle: string } | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const projects = useQuery({ queryKey: ["projects", scope, "canvas-association"], queryFn: () => listProjects() });
    const units = useQuery({ queryKey: ["project", projectId, "units", scope], queryFn: () => listProjectUnits(projectId), enabled: Boolean(projectId) });
    const detail = useQuery({ queryKey: ["project", projectId, "canvas-association", scope], queryFn: () => getProject(projectId), enabled: Boolean(projectId && current?.projectId === projectId) });
    const existingUnits = detail.data?.canvasUnitLinks.filter((link) => link.canvasId === canvasId).map((link) => link.unitId) || [];
    useEffect(() => {
        if (!unitId && existingUnits[0]) setUnitId(existingUnits[0]);
    }, [unitId, existingUnits[0]]);
    const selectedUnit = units.data?.units.find((unit) => unit.id === unitId);
    const selectedProject = projects.data?.projects.find(({ project }) => project.id === projectId)?.project;
    const stale = Boolean(preview && (!current || current.revision !== preview.canvas.revision || !sameCanvasContent(current, preview.canvas)));
    const loadPreview = async () => {
        if (busy || !selectedUnit || !selectedProject) return;
        setBusy(true); setError(null); setPreview(null);
        try {
            if (!await onSave()) throw new Error("画布尚未保存到云端，请先处理保存错误");
            if (!isCurrent()) return;
            const saved = useCanvasStore.getState().openProject(canvasId);
            if (!saved || !Number.isSafeInteger(saved.revision) || saved.revision! < 1) throw new Error("画布尚无有效云端版本，请保存后重试");
            if (saved.projectId && saved.projectId !== projectId) throw new Error("画布已关联其他项目，请关闭后重新核对");
            setPreview({ canvas: saved, unit: selectedUnit, projectName: selectedProject.name });
        } catch (cause) {
            if (isCurrent()) setError(cause instanceof Error ? cause.message : "关联预览失败");
        } finally { if (isCurrent()) setBusy(false); }
    };
    const confirm = async () => {
        if (!preview || busy) return;
        setBusy(true); setError(null);
        try {
            const live = useCanvasStore.getState().openProject(canvasId);
            if (!live || live.revision !== preview.canvas.revision || !sameCanvasContent(live, preview.canvas)) throw new Error("画布已变化，请刷新关联预览");
            await linkCanvasUnit(projectId, { canvasId, unitId: preview.unit.id, role: "storyboard", expectedCanvasRevision: preview.canvas.revision });
            if (!isCurrent()) return;
            // Remember a committed relationship even if reloading its document fails.
            setLinked({ projectId, unitId: preview.unit.id, unitTitle: preview.unit.title });
            setUnitId(preview.unit.id);
            setPreview(null);
            await queryClient.invalidateQueries({ queryKey: ["project", projectId] });
            await queryClient.invalidateQueries({ queryKey: ["canvas-library"] });
            await onReload();
        } catch (cause) {
            if (isCurrent()) setError(cause instanceof Error ? cause.message : "画布关联失败");
        } finally { if (isCurrent()) setBusy(false); }
    };
    const readError = projects.error || units.error || detail.error;
    return <AppModal open title="画布关联与制作流程" onCancel={() => { if (!busy) onClose(); }} maskClosable={!busy} closable={!busy} keyboard={!busy} width={760} footer={null}>
        <div data-canvas-no-zoom data-canvas-wheel-scroll onWheel={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()} className="max-h-[70dvh] space-y-4 overflow-y-auto text-sm">
            {linked ? <>
                <p role="status">已关联「{linked.unitTitle}」。制作流程使用该章节的项目记录。</p>
                {existingUnits.length > 1 ? <label className="block space-y-1 text-xs"><span>查看映射的章节</span><select aria-label="查看映射的章节" value={unitId} onChange={(event) => setUnitId(event.target.value)} className="h-9 w-full rounded-md border border-border bg-surface px-2">{units.data?.units.filter((unit) => existingUnits.includes(unit.id)).map((unit) => <option key={unit.id} value={unit.id}>{unit.title}</option>)}</select></label> : null}
                <nav aria-label="已关联章节制作流程" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {shortDramaStages.map((stage) => <Link key={stage.key} className="flex items-center justify-between gap-1 border-b border-border py-2 text-xs" to={`/projects/${linked.projectId}/workflow/${unitId || linked.unitId}/${stage.key}`}>{stage.label}<ArrowUpRight className="size-3.5 shrink-0" /></Link>)}
                </nav>
                <Button icon={<RefreshCw className="size-4" />} loading={busy} onClick={async () => { setBusy(true); setError(null); try { await onReload(); } catch (cause) { if (isCurrent()) setError(cause instanceof Error ? cause.message : "读取关联结果失败"); } finally { if (isCurrent()) setBusy(false); } }}>重新读取画布</Button>
            </> : <>
                <div className="grid gap-3 sm:grid-cols-2">
                    <label className="space-y-1 text-xs"><span>项目</span><select aria-label="关联目标项目" disabled={busy || Boolean(current?.projectId)} value={projectId} onChange={(event) => { setProjectId(event.target.value); setUnitId(""); setPreview(null); setError(null); }} className="h-9 w-full rounded-md border border-border bg-surface px-2">
                        <option value="">选择项目</option>{projects.data?.projects.map(({ project }) => <option key={project.id} value={project.id}>{project.name}</option>)}
                    </select></label>
                    <label className="space-y-1 text-xs"><span>章节 / 集数</span><select aria-label="关联目标章节" disabled={busy || !projectId || units.isLoading} value={unitId} onChange={(event) => { setUnitId(event.target.value); setPreview(null); setError(null); }} className="h-9 w-full rounded-md border border-border bg-surface px-2">
                        <option value="">选择章节</option>{units.data?.units.map((unit) => <option key={unit.id} value={unit.id}>{unit.title}{existingUnits.includes(unit.id) ? "（已关联）" : ""}</option>)}
                    </select></label>
                </div>
                {projectId && units.data?.units.length === 0 ? <p className="text-xs text-foreground/60">该项目暂无章节。<Link className="text-[var(--workspace-accent)]" to={`/projects/${projectId}/chapters`}>进入剧情与章节</Link></p> : null}
                {existingUnits.length ? <nav aria-label="现有章节关联" className="flex flex-wrap gap-3 text-xs">{units.data?.units.filter((unit) => existingUnits.includes(unit.id)).map((unit) => <Link key={unit.id} to={`/projects/${projectId}/workflow/${unit.id}/story`} className="inline-flex items-center gap-1 text-[var(--workspace-accent)]">{unit.title}<ArrowUpRight className="size-3.5" /></Link>)}</nav> : null}
                {preview ? <section aria-label="画布关联预览" className="space-y-3 border-y border-border py-3">
                    <p className="font-medium">{preview.canvas.title} → {preview.projectName} / {preview.unit.title}</p>
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                        <dt>画布节点与连线</dt><dd>{preview.canvas.nodes.length} 个节点 · {preview.canvas.connections.length} 条连线，原样保留</dd>
                        <dt>章节正文</dt><dd>{preview.unit.wordCount} 字，使用项目现有正文</dd>
                        <dt>节点与业务镜头</dt><dd>不自动建立对应关系，不导入或覆盖章节正文、镜头与已采用产物</dd>
                        <dt>审核及交付</dt><dd>进入该章节现有记录，未审核的内容保持待确认</dd>
                    </dl>
                    <ul aria-label="保留的画布节点" className="max-h-36 overflow-y-auto border-t border-border text-xs">{preview.canvas.nodes.map((node) => <li key={node.id} className="break-words py-1">{node.title || node.id}</li>)}</ul>
                    {stale ? <p role="status" className="text-xs text-[var(--status-warning)]">画布已变化，请刷新关联预览。</p> : null}
                </section> : null}
                <div className="flex flex-wrap items-center gap-2">
                    <Button icon={<RefreshCw className="size-4" />} loading={busy && !preview} disabled={!selectedUnit || !selectedProject || busy} onClick={() => void loadPreview()}>{preview ? "刷新关联预览" : "保存画布并预览关联"}</Button>
                    <Button type="primary" icon={<Link2 className="size-4" />} loading={busy && Boolean(preview)} disabled={!preview || stale || busy} onClick={() => void confirm()}>确认关联</Button>
                </div>
            </>}
            {current?.projectId === projectId && unitId && existingUnits.includes(unitId) && detail.data ? <CanvasNodeShotMapping key={`${projectId}:${unitId}`} canvasId={canvasId} projectId={projectId} unitId={unitId} detail={detail.data} onSave={onSave} /> : null}
            {error || readError ? <p role="alert" className="break-words text-xs text-[var(--status-error)]">{error || (readError instanceof Error ? readError.message : "读取项目失败")}</p> : null}
            {readError ? <Button icon={<RefreshCw className="size-4" />} onClick={() => { void projects.refetch(); if (projectId) void units.refetch(); if (current?.projectId) void detail.refetch(); }}>重试读取</Button> : null}
        </div>
    </AppModal>;
}
