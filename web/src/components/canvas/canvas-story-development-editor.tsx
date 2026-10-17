import { useRef, useState, type CSSProperties } from "react";
import { App, Button, Input, InputNumber, Segmented } from "antd";
import { ArrowRight, Clock3, Dice5, Plus, Redo2, Save, Sparkles, Square, Undo2, Upload, X } from "lucide-react";
import { CanvasTopicSettingsFields } from "./canvas-topic-settings-fields";
import { changeStoryTopicSettings, type StoryTopicSettingsPatch } from "@/lib/story-topic-settings";
import { AppModal } from "@/components/ui/product/app-modal";
import { ModelPicker } from "@/components/model-picker";
import { canvasThemes } from "@/lib/canvas-theme";
import { buildStoryDevelopmentPrompt, defaultStoryBrief, nextStoryDevelopmentStage, storyDocumentSignature, storyEpisodeCount, storySourceState, storyStageLabel, storyTopicCount, storyTopicText } from "@/lib/canvas/canvas-story-development";
import { prepareBackendGenerationTask } from "@/services/api/generation-task";
import { ApiError } from "@/services/api/request";
import { createGenerationTask } from "@/services/api/task-center";
import { receiveStoryTask, restoreStoryRevision, storyDraftKey, storyJobActive, type StoryJob, type StorySession } from "@/services/story-development-session";
import { useStoryDevelopmentSession } from "./use-story-development-session";
import { useStoryEpisodeBatch } from "./use-story-episode-batch";
import { cancelGenerationTask } from "@/services/api/task-center";
import { selectableModelsByCapability, useEffectiveConfig } from "@/stores/use-config-store";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import type { CanvasNodeData, StoryDevelopmentData, StoryTopicCandidate } from "@/types/canvas";
import "./canvas-story-development-editor.css";
import { storyBriefFromSettings, type ShortDramaGlobalSettings } from "@/lib/short-drama-settings";

type Props = {
    globalSettings?: ShortDramaGlobalSettings;
    onSaveTopicSettings?: (patch: StoryTopicSettingsPatch) => Promise<ShortDramaGlobalSettings>;
    node: CanvasNodeData;
    nodes: CanvasNodeData[];
    canvasId: string;
    onSave: (original: CanvasNodeData, title: string, content: string, data: StoryDevelopmentData) => CanvasNodeData;
    onClose: () => void;
    onNextEpisode: (nodeId: string) => void;
    onNextStage: (nodeId: string) => void;
    onPrepareBatch: (start: number, count: number, excludedIds: string[]) => Promise<{ nodes: CanvasNodeData[]; targets: CanvasNodeData[]; skipped: number[] }>;
    onOpenEpisode: (nodeId: string) => void;
    onPersistBatch: () => Promise<boolean>;
};

export function CanvasStoryDevelopmentEditor({ node, nodes, canvasId, onSave, onClose, onNextEpisode, onNextStage, onPrepareBatch, onOpenEpisode, onPersistBatch, globalSettings, onSaveTopicSettings }: Props) {
    const { message, modal } = App.useApp();
    const theme = canvasThemes[useActiveTheme()];
    const config = useEffectiveConfig();
    const { session, current, update, ready, storageError, syncError, persisting, reload, flush } = useStoryDevelopmentSession(node, canvasId, config.textModel || "");
    const { title, content, data, dirty, instruction, model, preview, job } = session;
    const [error, setError] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [saving, setSaving] = useState(false);
    const savingRef = useRef(false);
    const submittingRef = useRef(false);
    const [stopping, setStopping] = useState(false);
    const [topicView, setTopicView] = useState("candidates");
    const fileInput = useRef<HTMLInputElement>(null);
    const topicSettings = globalSettings ? { ...globalSettings, ...session.topicSettingsPatch } : undefined;
    const brief = { ...defaultStoryBrief, ...(data.brief || {}), ...(topicSettings ? storyBriefFromSettings(topicSettings) : {}), topicCount: data.brief?.topicCount || 4 };
    const source = storySourceState(data, nodes);
    const stage = storyStageLabel(data.stage);
    const draftKey = storyDraftKey(session);
    const selectedModel = model || config.textModel;
    const canGenerate = selectableModelsByCapability(config, "text").includes(selectedModel);
    const isTopic = data.stage === "topic";
    const batch = useStoryEpisodeBatch({ node, nodes, canvasId, config, model: selectedModel, session, current, ready, update, onPrepare: onPrepareBatch, onSave, onPersist: onPersistBatch });
    const busy = saving || submitting || batch.submitting || storyJobActive(job);
    const episodeTotal = storyEpisodeCount(data, nodes);
    const batchStart = session.batchStart || data.episodeNumber || 1;
    const batchCount = session.batchCount || Math.min(3, Math.max(1, episodeTotal - batchStart + 1));
    const batchActive = batch.rows.some((row) => ["pending", "submitting", "unknown", "queued", "running", "ready"].includes(row.status));
    const nextStage = nextStoryDevelopmentStage(data.stage);
    const change = (patch: Partial<StorySession>) => { void update({ ...patch, ...("content" in patch || "data" in patch ? { redoVersion: undefined } : {}) }).catch(() => undefined); };
    const changeData = (patch: Partial<StoryDevelopmentData>) => change({ data: { ...current.current.data, ...patch }, dirty: true });
    const persistTopicSettings = async () => {
        if (!globalSettings || !onSaveTopicSettings || data.stage !== "topic") return globalSettings;
        const saved = await onSaveTopicSettings(current.current.topicSettingsPatch || {});
        await update({ topicSettingsPatch: undefined });
        return saved;
    };
    const cancel = async () => {
        if (!job?.taskId || stopping) return;
        setStopping(true);
        try {
            const task = await cancelGenerationTask(job.taskId);
            await update(receiveStoryTask(current.current, task));
        } catch { setError("取消尚未确认，任务仍可能运行，请稍后重试或查看任务中心"); }
        finally { setStopping(false); }
    };
    const save = async () => {
        if (!ready || busy || savingRef.current) return null;
        savingRef.current = true; setSaving(true);
        try {
            await flush();
            const latest = nodes.find((item) => item.id === node.id);
            if (!latest || storyDocumentSignature(latest) !== current.current.baseSignature) throw new Error("画布原稿已被修改或删除，请保留本地草稿并核对最新原稿");
            const settings = await persistTopicSettings();
            const draft = current.current;
            const savedData = settings ? { ...draft.data, brief: { ...storyBriefFromSettings(settings), topicCount: draft.data.brief?.topicCount || 4 } } : draft.data;
            const saved = onSave(latest, draft.title, draft.content, savedData);
            await update({ baseSignature: storyDocumentSignature(saved), data: structuredClone(saved.metadata!.storyDevelopment!), dirty: false, ...(draft.job?.batchOwnerNodeId && draft.job.status === "succeeded" ? { job: { ...draft.job, appliedToCanvas: true } } : {}) });
            setError("");
            return saved;
        } catch (failure) { setError(failure instanceof Error ? failure.message : "保存失败"); return null; }
        finally { savingRef.current = false; setSaving(false); }
    };
    const close = async () => {
        try { if (ready) await flush(); onClose(); }
        catch { message.error("本地草稿未保存，暂未关闭，请保留文本后重试"); }
    };
    const selectTopic = (candidate: StoryTopicCandidate) => {
        change({ content: storyTopicText(candidate), data: { ...data, selectedTopicId: candidate.id }, dirty: true, preview: null });
    };
    const importStoryText = async (file: File) => {
        if (file.size > 2 * 1024 * 1024) { setError("文本文件不能超过 2 MB"); return; }
        try {
            const imported = (await file.text()).replace(/^\uFEFF/, "").trim();
            if (!imported) { setError("Markdown 文件没有可导入的正文"); return; }
            const heading = imported.match(/^#\s+(.+)$/m)?.[1]?.trim();
            change({
                ...(heading ? { title: heading } : {}),
                content: imported,
                data: { ...data, selectedTopicId: undefined, candidates: data.candidates },
                dirty: true,
                preview: null,
            });
            if (isTopic) setTopicView("draft");
            setError("");
            message.success(isTopic ? "Markdown 选题已导入，可继续编辑后保存" : "文本已导入，可继续编辑后保存");
        } catch { setError("文件读取失败，原稿已保留"); }
    };
    const openTopicImport = () => fileInput.current?.click();
    const openEpisode = async (id: string) => {
        try { await flush(); onOpenEpisode(id); }
        catch { setError("本地草稿未保存，暂未切换节点"); }
    };
    const generate = async (draw = false) => {
        if (savingRef.current || submittingRef.current || storyJobActive(current.current.job) || !ready || storageError || !canGenerate) return;
        submittingRef.current = true; setSubmitting(true); setError("");
        let submitted = false;
        try {
            const settings = await persistTopicSettings();
            const generationBrief = { ...brief, ...(settings ? storyBriefFromSettings(settings) : {}), topicCount: brief.topicCount };
            const generationData = { ...current.current.data, brief: generationBrief };
            const prompt = buildStoryDevelopmentPrompt(generationData, nodes, content, instruction, draw);
            const operationId = crypto.randomUUID();
            const input = await prepareBackendGenerationTask({
                projectId: canvasId, mode: "text", prompt, config: { ...config, model: selectedModel },
                streamText: true, clientOperationId: operationId,
                metadata: { source: "canvas-story-development", stage: data.stage, storyNodeId: node.id, pipelineId: data.pipelineId },
            });
            const pending: StoryJob = { operationId, status: "submitting", draw, topicCount: storyTopicCount(brief.topicCount), draft: draftKey, signatures: { ...source.signatures } };
            // Persist the operation BEFORE POST. Lost acknowledgements are recovered by metadata, never reposted automatically.
            await update({ job: pending, data: generationData });
            submitted = true;
            const task = await createGenerationTask(input);
            await update(receiveStoryTask(current.current, task));
        } catch (failure) {
            const text = failure instanceof Error ? failure.message : "生成失败，原稿已保留";
            if (!submitted) setError(text);
            const pending = current.current.job;
            if (submitted && pending && !pending.taskId) {
                const rejected = failure instanceof ApiError && [400, 401, 403, 404, 422, 429].includes(failure.status || 0);
                await update({ job: { ...pending, status: rejected ? "failed" : "unknown", error: text } }).catch(() => undefined);
            }
        } finally {
            submittingRef.current = false; setSubmitting(false);
        }
    };
    const style = { "--story-bg": theme.node.panel, "--story-body": theme.canvas.background, "--story-line": theme.node.stroke, "--story-muted": theme.node.muted, "--story-text": theme.node.text, "--story-active": theme.toolbar.itemHover } as CSSProperties;
    return <AppModal open title={null} footer={null} closable={false} centered width="min(1240px, calc(100vw - 24px))" onCancel={close} flush className="canvas-story-development-modal">
        <section className={`story-development-editor${isTopic ? " story-topic-editor" : ""}`} style={style} aria-label={`${stage}编辑器`} data-canvas-no-zoom data-canvas-wheel-scroll
            onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}
            onKeyDown={(event) => { event.stopPropagation(); if (!event.nativeEvent.isComposing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); save(); } }}>
            <header className="story-development-header">
                <strong>{stage}{data.stage === "body" ? ` · 第 ${data.episodeNumber || 1} 集` : ""}</strong>
                <span role="status">{!ready ? "恢复草稿中" : storageError ? "本地保存失败" : persisting ? "保存本地草稿中" : dirty ? "草稿已存本机" : "已写回画布"}</span>
                <Button icon={<Save size={15} />} type={isTopic ? "default" : "primary"} onClick={() => void save()} disabled={!ready || !dirty || busy}>保存</Button>
                <Button type="text" icon={<X size={17} />} aria-label="关闭创作编辑器" onClick={() => void close()} />
            </header>
            <div className={`story-development-layout${isTopic ? " story-development-topic-layout" : ""}`}>
                <div className="story-development-document">
                    {isTopic ? <div className="story-topic-tabs"><Segmented aria-label="选题内容视图" value={topicView} onChange={setTopicView} options={[{ label: `候选选题 (${data.candidates?.length || 0})`, value: "candidates" }, { label: "已采用选题", value: "draft" }]} />
                        <Button icon={<Upload size={15} />} title="导入 Markdown 选题" aria-label="导入 Markdown 选题" onClick={openTopicImport} disabled={!ready || busy}>导入 Markdown</Button>
                        {Boolean(data.candidates?.length) && topicView === "candidates" ? <Button icon={<Dice5 size={15} />} disabled={!ready || busy} onClick={() => selectTopic(data.candidates![crypto.getRandomValues(new Uint32Array(1))[0] % data.candidates!.length])}>随机采用一个</Button> : null}
                    </div> : null}
                    <div className="story-development-document-scroll">
                    <div hidden={isTopic && topicView !== "draft"}>
                    <div className="story-development-document-tools">
                        <Input aria-label="创作节点标题" disabled={!ready} value={title} onChange={(event) => change({ title: event.target.value, dirty: true })} />
                        <Button icon={<Undo2 size={15} />} title="撤销 AI 更新" aria-label="撤销 AI 更新" disabled={!ready || busy || Boolean(storageError) || !session.previousVersion} onClick={() => void update(restoreStoryRevision(current.current)).catch(() => undefined)} />
                        <Button icon={<Redo2 size={15} />} title="重做 AI 更新" aria-label="重做 AI 更新" disabled={!ready || busy || Boolean(storageError) || !session.redoVersion} onClick={() => void update(restoreStoryRevision(current.current, true)).catch(() => undefined)} />
                        <Button icon={<Upload size={15} />} title="导入 TXT 或 Markdown" aria-label="导入创作文本" onClick={openTopicImport} disabled={!ready || busy} />
                        <input ref={fileInput} type="file" accept=".txt,.md,text/plain,text/markdown" hidden onChange={async (event) => {
                            const file = event.target.files?.[0]; event.target.value = "";
                            if (!file) return;
                            await importStoryText(file);
                        }} />
                    </div>
                    </div>
                    {isTopic ? <section hidden={topicView !== "candidates"} className="story-development-topic-results" aria-label="选题结果">
                        <div className="story-development-results-heading"><strong>选题结果</strong><span>{data.candidates?.length ? `${data.candidates.length} 个候选` : "等待生成"}</span></div>
                        {data.candidates?.length ? <div className="story-development-result-list">
                            {data.candidates.map((candidate) => <article key={candidate.id} data-selected={data.selectedTopicId === candidate.id}>
                                <div className="story-development-result-copy"><strong>{candidate.title}</strong><p>{candidate.logline}</p><p><b>核心冲突</b>{candidate.conflict}</p><p><b>观看吸引力</b>{candidate.appeal}</p></div>
                                <Button size="small" disabled={busy} aria-pressed={data.selectedTopicId === candidate.id} onClick={() => selectTopic(candidate)}>{data.selectedTopicId === candidate.id ? "已采用" : "采用此选题"}</Button>
                            </article>)}
                        </div> : <div className="story-development-results-empty">暂无候选选题</div>}
                    </section> : <div className="story-development-sources">
                        <span>依据：{source.sources.map((item) => item?.title || "已删除节点").join("、")}</span>
                        {source.missing ? <span role="status">前序内容未齐备，可先编辑或导入</span> : source.stale ? <span role="status">上游内容已变更，当前稿待复核</span> : null}
                        {source.upstreamStale ? <span role="status">前序节点待复核，请先更新上游</span> : null}
                        {source.stale && !source.missing ? <Button size="small" disabled={busy || source.upstreamStale} onClick={() => changeData({ sourceSignatures: source.signatures })}>已核对上游</Button> : null}
                    </div>}
                    {source.references.map((reference) => <details key={reference.id} className="story-development-sources">
                        <summary>历史粗纲参考 · {reference.title}</summary>
                        <Input.TextArea aria-label="历史粗纲参考" readOnly value={reference.metadata?.content || ""} autoSize={{ minRows: 3, maxRows: 6 }} />
                        {data.stage === "plan" ? <Button size="small" disabled={!ready || busy || Boolean(preview)} onClick={() => change({ content: [current.current.content, `## 待整合的历史粗纲\n${reference.metadata?.content}`].filter(Boolean).join("\n\n"), dirty: true })}>补入制作方案草稿</Button> : null}
                    </details>)}
                    <div hidden={isTopic && topicView !== "draft"} className="story-development-draft">
                        <label className="story-development-content-label" htmlFor={`story-content-${node.id}`}>{data.stage === "topic" ? "采用的选题" : data.stage === "plan" ? "制作方案 · 含故事总纲" : "正文草稿"}<span>{content.length.toLocaleString()} 字</span></label>
                        <Input.TextArea id={`story-content-${node.id}`} aria-label="创作正文" disabled={!ready} className="story-development-content" autoSize={isTopic ? { minRows: 12 } : undefined} value={content} onChange={(event) => change({ content: event.target.value, dirty: true })} spellCheck={false} />
                    </div>
                    </div>
                    <div className="story-development-next" aria-label="下一步流程">
                        <span>{!content.trim() ? "待采用或填写当前内容" : preview ? "待处理 AI 结果" : source.missing || source.stale || source.upstreamStale ? "待补齐或复核前序内容" : isTopic ? `已采用：${data.candidates?.find((item) => item.id === data.selectedTopicId)?.title || "自定义选题"}` : "前置内容已齐备"}</span>
                        {nextStage ? <Button type={isTopic ? "primary" : "default"} icon={<ArrowRight size={15} />} disabled={!ready || busy || Boolean(preview) || !content.trim() || source.missing || source.stale || source.upstreamStale}
                            onClick={async () => { if (await save()) onNextStage(node.id); }}>保存并进入{nextStage.label}</Button>
                            : <Button icon={<Plus size={15} />} disabled={!ready || busy || Boolean(preview) || !content.trim() || source.missing || source.stale || source.upstreamStale} onClick={async () => { if (await save()) onNextEpisode(node.id); }}>新建下一集正文</Button>}
                    </div>
                </div>
                <aside className="story-development-ai" aria-label="AI 创作助手">
                    <div className="story-development-ai-scroll">
                    {isTopic && topicSettings && globalSettings ? <CanvasTopicSettingsFields settings={topicSettings} disabled={!ready || busy} onChange={(key, value) => change({ topicSettingsPatch: changeStoryTopicSettings(globalSettings, current.current.topicSettingsPatch, key, value), dirty: true })} /> : null}
                    {isTopic && !globalSettings ? <fieldset className="story-development-brief" disabled={!ready || busy}>
                        <legend>选题条件</legend>
                        {([['genre', '类型', '如：当代奇幻、群像情感'], ['style', '风格', '如：原创 3D 动漫、情感悬疑']] as const).map(([key, label, placeholder]) => <label key={key}>{label}<Input aria-label={label} placeholder={placeholder} readOnly={Boolean(globalSettings)} value={brief[key]} onChange={(event) => changeData({ brief: { ...brief, [key]: event.target.value } })} /></label>)}
                        <label className="story-development-premise">核心设定<Input.TextArea aria-label="核心设定" placeholder="一句话说明世界、主角和主要矛盾" readOnly={Boolean(globalSettings)} value={brief.premise} autoSize={{ minRows: 3, maxRows: 6 }} onChange={(event) => changeData({ brief: { ...brief, premise: event.target.value } })} /></label>
                    </fieldset> : null}
                    <strong>{isTopic ? "生成参数" : "AI 创作"}</strong>
                    {isTopic ? <label>一次生成选题数<InputNumber aria-label="一次生成选题数" min={1} max={10} precision={0} disabled={!ready || busy} value={brief.topicCount} onChange={(value) => changeData({ brief: { ...brief, topicCount: storyTopicCount(value || 1) } })} /></label> : null}
                    <div className="story-development-model"><span>文本模型</span><ModelPicker config={config} value={selectedModel} capability="text" onChange={(value) => { if (ready) change({ model: value }); }} fullWidth /></div>
                    {!canGenerate ? <span role="status">请先在模型设置中配置文本模型</span> : null}
                    {data.stage === "body" ? <section className="story-development-batch" aria-label="批量生成正文">
                        <div className="story-development-brief">
                            <label>起始集数<InputNumber aria-label="起始集数" min={1} max={episodeTotal} value={batchStart} disabled={!ready || busy || batchActive} onChange={(value) => { const start = Math.max(1, Math.min(episodeTotal, Math.floor(value || 1))); change({ batchStart: start, batchCount: Math.min(batchCount, episodeTotal - start + 1) }); }} /></label>
                            <label>本次生成集数<InputNumber aria-label="本次生成集数" min={1} max={Math.max(1, episodeTotal - batchStart + 1)} value={batchCount} disabled={!ready || busy || batchActive} onChange={(value) => change({ batchCount: Math.max(1, Math.min(episodeTotal - batchStart + 1, Math.floor(value || 1))) })} /></label>
                        </div>
                        <span>第 {batchStart}–{batchStart + batchCount - 1} 集 · 共 {episodeTotal} 集</span>
                        <span>已有正文、草稿或任务的集会跳过</span>
                        <Button icon={<Sparkles size={15} />} loading={batch.submitting} disabled={!ready || Boolean(storageError) || busy || batchActive || !canGenerate || source.missing || source.upstreamStale} onClick={() => void batch.run(batchStart, batchCount)}>批量生成正文</Button>
                        {session.episodeBatch ? <div className="story-development-batch-progress" aria-label="正文批次进度">
                            {session.episodeBatch.skipped.length ? <span>已跳过：第 {session.episodeBatch.skipped.join("、")} 集</span> : null}
                            {batch.rows.map((row) => <div key={row.nodeId} className="story-development-batch-row">
                                <span>第 {row.episodeNumber} 集 · {row.label}</span>
                                <Button size="small" aria-label={`打开第 ${row.episodeNumber} 集`} disabled={batch.submitting || row.status === "deleted"} onClick={() => void openEpisode(row.nodeId)}>打开</Button>
                                {row.error ? <span role="status">{row.error}</span> : null}
                            </div>)}
                            {!session.episodeBatch.stopped && batch.rows.some((row) => row.status === "pending") ? <Button disabled={batch.submitting || Boolean(storageError) || !canGenerate} onClick={() => void batch.run()}>继续提交未提交的集</Button> : null}
                            {batchActive && !session.episodeBatch.stopped ? <Button icon={<Square size={13} />} disabled={batch.submitting} onClick={() => void batch.stop()}>停止批次</Button> : null}
                        </div> : null}
                        {job?.batchOwnerNodeId && job.batchOwnerNodeId !== node.id ? <Button onClick={() => void openEpisode(job.batchOwnerNodeId!)}>返回批次</Button> : null}
                        {batch.error ? <span role="alert">{batch.error}</span> : null}
                    </section> : null}
                    <label>{isTopic ? "本次创作要求（可选）" : "调整要求"}<Input.TextArea aria-label="AI 调整要求" disabled={!ready} value={instruction} onChange={(event) => change({ instruction: event.target.value })} autoSize={{ minRows: 3 }} placeholder={isTopic ? "例如：侧重亲情，主角从普通人开始成长" : "保留哪些内容，调整哪些人物、结构或情节"} /></label>
                    {job ? <span role="status">{job.status === "pending" ? "等待批次提交" : job.status === "submitting" ? "正在提交任务" : job.status === "unknown" ? "提交结果待确认" : job.status === "queued" ? "已排队，可后台运行" : job.status === "running" ? "AI 正在创作，可后台运行" : job.status === "failed" ? "生成失败，原稿已保留" : job.status === "cancelled" ? "任务已取消" : "AI 任务已完成"}</span> : null}
                    {syncError ? <span role="status">{syncError}</span> : null}
                    {error || job?.error || storageError ? <div role="alert">{[error || job?.error, storageError].filter(Boolean).join("\n")}</div> : null}
                    {storageError && ready ? <Button onClick={() => void flush().catch(() => undefined)}>重试保存本地草稿</Button> : null}
                    {storageError ? <Button onClick={() => modal.confirm({ title: "重新载入已保存的草稿？", content: "当前窗口未保存成功的文字将被替换，请先保留需要合并的内容。", okText: "重新载入", cancelText: "继续编辑", onOk: reload })}>重新载入本地草稿</Button> : null}
                    {ready && session.baseSignature !== storyDocumentSignature(node) ? <section className="story-development-preview">
                        <strong>画布原稿已更新，待合并</strong><Input.TextArea aria-label="最新画布原稿" value={node.metadata?.content || ""} readOnly autoSize={{ minRows: 3, maxRows: 8 }} />
                        <Button disabled={busy} onClick={() => modal.confirm({ title: "已将最新原稿合并到当前草稿？", content: "确认后，下次保存将使用当前草稿替换画布原稿。", okText: "已核对，继续编辑", cancelText: "继续核对", onOk: () => update({ baseSignature: storyDocumentSignature(node), dirty: true }) })}>核对并合并原稿</Button>
                    </section> : null}
                    {job?.status === "unknown" ? <Button onClick={() => modal.confirm({ title: "确认任务中心没有对应任务？", content: "只有核对后确认任务未创建，才解除提交占用。已存在的任务应等待恢复，避免再次生成。", okText: "已核对，解除占用", cancelText: "继续等待", onOk: () => update({ job: { ...job, status: "failed", error: "提交结果未确认，已手动解除占用" } }) })}>核对后解除占用</Button> : null}
                    {job?.partialText && job.status !== "succeeded" ? <section className="story-development-preview"><strong>{busy ? "生成中片段" : "中断前片段（未完成）"}</strong><Input.TextArea aria-label="生成中片段" value={job.partialText} readOnly autoSize={{ minRows: 3, maxRows: 8 }} /></section> : null}
                    {preview ? <section className="story-development-preview" aria-label="旧结果恢复失败">
                        <strong>旧结果恢复失败</strong>
                        <span role="alert">{preview.error}</span>
                        <Input.TextArea aria-label="AI 结果预览" value={preview.text} readOnly autoSize={{ minRows: 7, maxRows: 18 }} />
                        <Button type="text" disabled={busy} onClick={() => change({ preview: null })}>放弃结果</Button>
                    </section> : null}
                    </div>
                    <div className="story-development-ai-actions">
                        {isTopic ? <Button type="primary" icon={<Dice5 size={15} />} loading={submitting} disabled={!ready || Boolean(storageError) || !canGenerate || busy || Boolean(preview)} onClick={() => { setTopicView("candidates"); void generate(true); }}>生成选题</Button> : null}
                        {!isTopic || content.trim() ? <Button icon={<Sparkles size={15} />} disabled={!ready || Boolean(storageError) || !canGenerate || busy || Boolean(preview) || source.upstreamStale || (data.stage !== "topic" && source.missing)} onClick={() => { if (isTopic) setTopicView("draft"); void generate(); }}>{content.trim() ? data.stage === "plan" ? "完善制作方案" : "AI 调整" : `生成${stage}`}</Button> : null}
                        {busy || batchActive ? <Button icon={<Clock3 size={15} />} onClick={() => void close()}>后台运行</Button> : null}
                        {busy && job?.taskId ? <Button icon={<Square size={13} />} loading={stopping} onClick={() => void cancel()}>停止</Button> : null}
                    </div>
                </aside>
            </div>
        </section>
    </AppModal>;
}
