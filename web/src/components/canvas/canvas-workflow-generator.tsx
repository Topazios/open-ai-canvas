import { useState, type CSSProperties } from "react";
import { Button, Checkbox, Input, InputNumber, Select } from "antd";
import { Sparkles, X } from "lucide-react";
import { AppModal } from "@/components/ui/product/app-modal";
import { workflowSourceMatches } from "@/lib/canvas/canvas-production-sources";
import { workflowAssetActions, workflowAssetRevisionMembers } from "@/lib/canvas/canvas-workflow-asset-actions";
import { productionAssetMentions } from "@/lib/canvas/production-asset-references";
import { CanvasResourceMentionTextarea } from "./canvas-resource-mention-textarea";
import { ModelPicker } from "@/components/model-picker";
import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { mergedImageCapabilityConfig } from "@/lib/model-selection";
import { normalizeImageValue } from "@/lib/model-capabilities";
import { assetSheetKind, assetSheetImageSettings } from "@/lib/asset-reference-sheet";
import { workflowAssetSheetContext } from "@/lib/canvas/canvas-asset-sheet-context";
import { workflowImageSubjectHasGeneratedResult, workflowImageSubjects, workflowImageShots } from "@/lib/canvas/canvas-workflow-images";
import { workflowSoundSubjects } from "@/lib/canvas/canvas-workflow-sounds";
import { ProductionSoundKind, projectVoiceCalibration } from "@/lib/production-sound";
import { AudioSettingsPanel } from "@/components/audio-settings-panel";
import { audioVoiceOptions } from "@/lib/audio-generation";
import { ReasoningEffortSelect } from "@/components/reasoning-effort-select";
import { WORKFLOW_CONTEXT_LIMIT } from "@/lib/canvas/workflow-text-batch";
import { canvasThemes } from "@/lib/canvas-theme";
import { defaultWorkflowSources, nodeWorkflow, workflowGenerationSources, workflowParameters, workflowEpisodeProgress, workflowContinuationRange, DEFAULT_WORKFLOW_CONTINUATION_SPAN, episodeProgressLabel, workflowContextContent, type WorkflowGenerationRequest } from "@/lib/canvas/canvas-short-drama-workflow";
import { isStoryboardFrameStep, shortDramaStep, ShortDramaStep, type ShortDramaStepId } from "@/lib/short-drama-steps";
import { selectableModelsByCapability, useEffectiveConfig } from "@/stores/use-config-store";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import type { CanvasNodeData } from "@/types/canvas";
import "./canvas-workflow-generator.css";

export type WorkflowGeneratorTarget = { step: ShortDramaStepId; pipelineId: string; anchorId?: string; aggregate?: boolean; continueGeneration?: boolean; stepIds?: ShortDramaStepId[]; assetRevisionSourceId?: string; auditRepairReportId?: string };
type GeneratorProps = {
    globalSettings?: import("@/lib/short-drama-settings").ShortDramaGlobalSettings;
    target: WorkflowGeneratorTarget; nodes: CanvasNodeData[]; submitting: boolean;
    onGenerate: (request: WorkflowGenerationRequest) => void | Promise<void>; onClose: () => void;
};
export function CanvasWorkflowGenerator(props: GeneratorProps) {
    const [selectedStep, setSelectedStep] = useState(props.target.step);
    return <WorkflowGeneratorForm key={selectedStep} {...props} target={{ ...props.target, step: selectedStep }} onStepChange={setSelectedStep} />;
}
function WorkflowGeneratorForm({ target, nodes, submitting, onGenerate, onClose, onStepChange, globalSettings }: GeneratorProps & { onStepChange: (step: ShortDramaStepId) => void }) {
    const config = useEffectiveConfig();
    const theme = canvasThemes[useActiveTheme()];
    const step = shortDramaStep(target.step)!;
    const selectableStepIds = target.stepIds?.filter((id) => !isStoryboardFrameStep(id)) || [];
    const capability = step.mediaOutput || "text";
    const isImage = capability === "image";
    const isAudio = capability === "audio";
    const [audioValues, setAudioValues] = useState(config);
    const [soundVoices, setSoundVoices] = useState<Record<string, string>>({});
    const soundKind = ProductionSoundKind.Voice;
    const calibrationText = projectVoiceCalibration(globalSettings);
    const isAssetRevision = Boolean(target.assetRevisionSourceId);
    const isRepair = Boolean(target.auditRepairReportId);
    const revisionAnchor = nodes.find((node) => node.id === target.assetRevisionSourceId);
    let revisionCount = 0;
    try { if (revisionAnchor) revisionCount = workflowAssetRevisionMembers(revisionAnchor, nodes).length; } catch { /* Dependency validation below displays the error. */ }
    const requirements = isAssetRevision || isRepair ? [] : target.aggregate ? [step.id] : [...step.requires, ...(step.optionalRequires || [])];
    const [sources, setSources] = useState(() => isRepair ? [target.auditRepairReportId!] : target.assetRevisionSourceId ? [target.assetRevisionSourceId] : target.aggregate ? [target.anchorId || ""] : defaultWorkflowSources(target.step, target.pipelineId, nodes, target.anchorId));
    const [model, setModel] = useState(config[`${capability}Model`] || "");
    const [imageValues, setImageValues] = useState({ size: step.stage === "storyboard" && globalSettings ? globalSettings.aspectRatio : config.size, quality: config.quality, transparentBackground: config.transparentBackground });
    const isSheet = Boolean(assetSheetKind(step.id));
    const [selectedSubjectIds, setSelectedSubjectIds] = useState<string[] | null>(() => {
        const anchor = nodes.find((node) => node.id === target.anchorId);
        return anchor && nodeWorkflow(anchor)?.role !== "collection" && (workflowAssetActions(anchor)?.imageStep === step.id || workflowAssetActions(anchor)?.audioStep === step.id) &&
            !(isImage && step.stage === "assets" && workflowImageSubjectHasGeneratedResult(step.id, anchor.id, nodes)) ? [anchor.id] : null;
    });
    const [selectedAssetTargetKeys, setSelectedAssetTargetKeys] = useState<string[] | null>(null);
    const [imagePrompt, setImagePrompt] = useState<string | null>(null);
    const [selectedShotId, setSelectedShotId] = useState<string | null>(null);
    const [instruction, setInstruction] = useState("");
    const [shotDurationSeconds, setShotDuration] = useState(10);
    const [shotDurationToleranceSeconds, setShotTolerance] = useState(3);
    const [error, setError] = useState("");
    const productionAgent = step.output === "asset-group";
    const imageSubjects = isAudio ? workflowSoundSubjects({ pipelineId: target.pipelineId, sourceNodeIds: sources.filter(Boolean) }, nodes) : workflowImageSubjects({ step: target.step, sourceNodeIds: sources.filter(Boolean) }, nodes);
    const selectableImageSubjects = step.stage === "assets" && isImage
        ? imageSubjects.filter((node) => !workflowImageSubjectHasGeneratedResult(step.id, node.id, nodes))
        : imageSubjects;
    const assetTargetOptions = isSheet ? imageSubjects.flatMap((node) => {
        const data = nodeWorkflow(node);
        const identity = data?.assetIdentity?.code;
        const generated = workflowImageSubjectHasGeneratedResult(step.id, node.id, nodes);
        const base = { key: JSON.stringify([node.id, ""]), subjectId: node.id, variantCode: "", generated, label: [[identity, node.title, "基准状态"].filter(Boolean).join(" · "), generated ? "已生成" : ""].filter(Boolean).join(" · ") };
        return [base];
    }) : [];
    const selectableAssetTargetOptions = assetTargetOptions.filter((option) => !option.generated);
    const defaultAssetTargetKeys = isSheet
        ? (selectedAssetTargetKeys || (selectedSubjectIds?.length ? selectableAssetTargetOptions.filter((option) => selectedSubjectIds.includes(option.subjectId) && !option.variantCode).map((option) => option.key) : selectableAssetTargetOptions.slice(0, 1).map((option) => option.key))).filter((key) => selectableAssetTargetOptions.some((option) => option.key === key))
        : [];
    const selectedAssetTargets = defaultAssetTargetKeys.map((key) => assetTargetOptions.find((option) => option.key === key)).filter((option): option is (typeof assetTargetOptions)[number] => Boolean(option));
    const imageSubjectIds = isSheet
        ? [...new Set(selectedAssetTargets.map((target) => target.subjectId))]
        : (selectedSubjectIds || selectableImageSubjects.slice(0, 1).map((node) => node.id)).filter((id) => imageSubjects.some((node) => node.id === id) && (step.stage !== "assets" || !isImage || selectableImageSubjects.some((node) => node.id === id)));
    const imageTargetCount = isSheet ? selectedAssetTargets.length : imageSubjectIds.length;
    let ancestors: CanvasNodeData[] = [];
    let dependencyError = "";
    try { ancestors = workflowGenerationSources({ ...target, sourceNodeIds: sources.filter(Boolean), ...(isImage ? { imageSubjectIds } : {}) }, nodes); }
    catch (failure) { dependencyError = failure instanceof Error ? failure.message : "前置内容不完整"; }
    let assetMentions: ReturnType<typeof productionAssetMentions> = [];
    try { if (!dependencyError) assetMentions = productionAssetMentions(ancestors); }
    catch (failure) { dependencyError = failure instanceof Error ? failure.message : "资产引用不可用"; }
    let imageSettings: ReturnType<typeof normalizeImageValue> | undefined;
    if (isImage && model) {
        try {
            const profile = mergedImageCapabilityConfig(config, model);
            imageSettings = isSheet && !dependencyError
                ? assetSheetImageSettings(profile, imageValues, workflowAssetSheetContext(ancestors, nodes, target.pipelineId).size)
                : normalizeImageValue(profile, { ...imageValues, count: "1" });
        } catch (failure) { dependencyError = failure instanceof Error ? failure.message : "图片规格不可用"; }
    }
    const imageShots = step.stage === "storyboard" ? workflowImageShots(nodes.find((node) => node.id === imageSubjectIds[0]), step.id) : [];
    const imageShotId = selectedShotId || imageShots[0]?.id;
    const effectiveImagePrompt = imagePrompt ?? imageShots.find((shot) => shot.id === imageShotId)?.prompt ?? "";
    const imageError = (isImage || isAudio) && !dependencyError ? !imageTargetCount ? "请选择要生成的资产或镜头来源" : isAudio && (!calibrationText.trim() || !audioValues.audioVoice.trim()) ? "请填写校准文本并选择声线" : isAudio && soundKind !== ProductionSoundKind.Voice ? "当前试听入口使用语音合成；环境、道具及音乐可在资产资料关联已有音频" : step.stage === "storyboard" && !effectiveImagePrompt.trim() ? "请填写镜头编号与画面提示词" : "" : "";
    const parameters = workflowParameters(ancestors, globalSettings);
    const total = parameters.episodeCount;
    const outlineId = ancestors.find((node) => nodeWorkflow(node)?.step === ShortDramaStep.Episodes)?.id;
    const progress = workflowEpisodeProgress(nodes, target.pipelineId, outlineId);
    const isAudit = step.id === ShortDramaStep.Audit && !isRepair;
    const auditSource = nodes.find((node) => node.id === sources.find(Boolean));
    const auditMembers = auditSource && nodeWorkflow(auditSource)?.role === "collection"
        ? nodeWorkflow(auditSource)!.sourceNodeIds.map((id) => nodes.find((node) => node.id === id)).filter((node): node is CanvasNodeData => Boolean(node))
        : auditSource ? [auditSource] : [];
    const auditEpisodes = auditMembers.map((node) => nodeWorkflow(node)?.episodeNumber).filter((episode): episode is number => Number.isInteger(episode)).sort((a, b) => a - b);
    const auditReadyEpisodes = auditMembers.filter((node) => {
        const data = nodeWorkflow(node);
        const diagnosticNode = Boolean(data?.screenplayAudit || data?.screenplayRepair);
        return data?.step === ShortDramaStep.Body && data.role === "document" && Boolean(data.episodeNumber) && Boolean(node.metadata?.content?.trim())
            && node.metadata?.status !== "loading" && (node.metadata?.status !== "error" || diagnosticNode);
    }).map((node) => nodeWorkflow(node)!.episodeNumber!).sort((a, b) => a - b);
    const collections = sources.map((id) => nodes.find((node) => node.id === id)).filter((node) => nodeWorkflow(node)?.role === "collection" && !nodeWorkflow(node)?.assetGroup && !nodeWorkflow(node)?.mediaGroup);
    const directIds = new Set(sources.flatMap((id) => {
        const source = nodeWorkflow(nodes.find((node) => node.id === id));
        return source?.role === "collection" ? source.sourceNodeIds : [id];
    }));
    const sourceLength = ancestors.filter((node) => step.stage === "story" || directIds.has(node.id) || nodeWorkflow(node)?.step === ShortDramaStep.Plan).reduce((total, node) => total + (workflowContextContent(node, step.id)?.length || 0), 0);
    const [episodeCount, setEpisodeCount] = useState(total);
    const [minutes, setMinutes] = useState(parameters.minutesPerEpisode);
    const continuation = workflowContinuationRange(progress);
    const auditInitialStart = auditReadyEpisodes[0] || auditEpisodes[0] || 1;
    const auditInitialEnd = auditReadyEpisodes.at(-1) || auditEpisodes.at(-1) || auditInitialStart;
    const initialStart = isAudit ? auditInitialStart : target.continueGeneration && step.id === ShortDramaStep.Body ? continuation.start : nodeWorkflow(nodes.find((node) => node.id === target.anchorId))?.episodeNumber || progress.next;
    const [start, setStart] = useState(initialStart);
    const [count, setCount] = useState(isAudit ? Math.max(1, auditInitialEnd - auditInitialStart + 1) : target.continueGeneration && step.id === ShortDramaStep.Body ? continuation.count : Math.min(continuation.count, Math.max(1, total - initialStart + 1)));
    const auditEnd = start + count - 1;
    const auditSelectedReady = auditReadyEpisodes.filter((episode) => episode >= start && episode <= auditEnd);
    const auditRangeError = isAudit && !auditSelectedReady.length ? "所选范围内没有已生成完成的正文" : "";
    const style = { "--workflow-bg": theme.node.panel, "--workflow-text": theme.node.text, "--workflow-muted": theme.node.muted, "--workflow-border": theme.node.stroke } as CSSProperties;
    const sourceField = (required: ShortDramaStepId, index: number) => required === ShortDramaStep.Scenes && !sources[index] && !nodes.some((node) => nodeWorkflow(node)?.pipelineId === target.pipelineId && nodeWorkflow(node)?.step === required && (node.metadata?.content?.trim() || nodeWorkflow(node)?.role === "collection")) ? null : <label key={required}>
        {required === ShortDramaStep.Bible ? "制作依据" : shortDramaStep(required)!.label}{step.optionalRequires?.includes(required) ? "（可选）" : ""}
        <Select allowClear={step.optionalRequires?.includes(required)} aria-label={`${shortDramaStep(required)!.label}来源`} value={sources[index] || undefined} placeholder="选择来源节点" disabled={submitting}
            onChange={(id) => {
                setSources((current) => current.map((value, i) => i === index ? id || "" : value));
                setSelectedSubjectIds(null); setSelectedAssetTargetKeys(null); setImagePrompt(null); setSelectedShotId(null);
                if (step.id === ShortDramaStep.Body) {
                    const next = workflowEpisodeProgress(nodes, target.pipelineId, id);
                    const range = workflowContinuationRange(next);
                    setStart(range.start); setCount(range.count);
                }
                if (step.id === ShortDramaStep.Audit) {
                    const source = nodes.find((node) => node.id === id);
                    const members = source && nodeWorkflow(source)?.role === "collection" ? nodeWorkflow(source)!.sourceNodeIds.map((memberId) => nodes.find((node) => node.id === memberId)).filter((node): node is CanvasNodeData => Boolean(node)) : source ? [source] : [];
                    const ready = members.filter((node) => nodeWorkflow(node)?.step === ShortDramaStep.Body && Boolean(nodeWorkflow(node)?.episodeNumber) && Boolean(node.metadata?.content?.trim()) && !["loading", "error"].includes(node.metadata?.status || "")).map((node) => nodeWorkflow(node)!.episodeNumber!).sort((a, b) => a - b);
                    const nextStart = ready[0] || 1;
                    setStart(nextStart); setCount(Math.max(1, (ready.at(-1) || nextStart) - nextStart + 1));
                }
            }}
            options={nodes.filter((node) => nodeWorkflow(node)?.pipelineId === target.pipelineId && workflowSourceMatches(node, required, nodes) && !nodeWorkflow(node)?.assetKey && !nodeWorkflow(node)?.mediaGroup &&
                (!target.aggregate || nodeWorkflow(node)?.role === "collection") && (node.metadata?.content?.trim() || node.metadata?.storageKey || nodeWorkflow(node)?.role === "collection"))
                .map((node) => ({ value: node.id, label: node.title }))} />
    </label>;
    const optionalSources = isImage ? requirements.map((required, index) => ({ required, index })).filter(({ required }) => step.optionalRequires?.includes(required)) : [];
    return <AppModal open title={null} footer={null} closable={false} centered width="min(440px, calc(100vw - 24px))" flush onCancel={onClose} className="canvas-workflow-generator-modal">
        <section className="canvas-workflow-generator" aria-label={`${step.label}生成设置`} style={style} data-canvas-no-zoom data-canvas-wheel-scroll onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
            <header><strong>{isRepair ? "依据诊断修复正文" : isAssetRevision ? "重做另一版" : `${target.aggregate ? "跨集汇总 · " : ""}${step.label}`}</strong><Button type="text" icon={<X size={17} />} aria-label="关闭生成设置" onClick={onClose} /></header>
            <fieldset disabled={submitting} className="canvas-workflow-generator-fields">
                {isAssetRevision ? <div className="canvas-workflow-generator-progress" role="status"><strong>{revisionAnchor?.title}</strong><span>本次重做 {revisionCount} 项资产 · 保留原版与资产编码</span></div> : null}
                {step.id === ShortDramaStep.Plan ? <div className="canvas-workflow-generator-progress" aria-label="故事总纲产物"><strong>故事总纲与世界规则</strong><span>保存总纲后停止；完成后可右键创作其他制作方案。</span></div> : null}
                {selectableStepIds.length > 1 ? <label>制作项目<Select aria-label="制作项目" value={step.id} onChange={onStepChange} options={selectableStepIds.map((id) => ({ value: id, label: `${shortDramaStep(id)!.label}${shortDramaStep(id)!.optional ? "（按需）" : ""}` }))} /></label> : null}
                <label>{isImage ? "生图模型" : isAudio ? "音频模型" : "文本模型"}<ModelPicker config={config} value={model} capability={capability} onChange={setModel} fullWidth /></label>
                {isAudio ? <>
                    <label>项目统一校准文本<Input.TextArea aria-label="项目统一校准文本" value={calibrationText} readOnly autoSize={{ minRows: 3, maxRows: 6 }} /></label>
                    <AudioSettingsPanel config={audioValues} onConfigChange={(key, value) => setAudioValues(current => ({ ...current, [key]: value }))} theme={theme} />
                </> : null}
                {capability === "text" ? <ReasoningEffortSelect disabled={submitting} /> : null}
                {isImage && imageSettings && model ? <details className="canvas-workflow-image-settings"><summary>{isSheet ? "统一设定板" : "图片规格"} · {imageSettings.size} · {imageSettings.quality}</summary><ImageSettingsPanel config={{ ...config, model, imageModel: model, ...imageSettings }} onConfigChange={(key, value) => setImageValues((current) => ({ ...current, [key]: value }))} theme={theme} showTitle={false} showCount={false} showSize={!isSheet} showTransparent={!isSheet} className="min-w-0 space-y-3" /></details> : null}
                {requirements.map((required, index) => isImage && step.optionalRequires?.includes(required) ? null : sourceField(required, index))}
                {optionalSources.length ? <details className="canvas-workflow-image-settings"><summary>参考画面（可选） · 已选 {optionalSources.filter(({ index }) => sources[index]).length}</summary><div className="canvas-workflow-optional-sources">{optionalSources.map(({ required, index }) => sourceField(required, index))}</div></details> : null}
                {isImage || isAudio ? <>
                    {step.stage === "assets" ? <div className="canvas-workflow-asset-selection">
                        <Checkbox disabled={submitting || !(isSheet ? selectableAssetTargetOptions.length : selectableImageSubjects.length)} checked={(isSheet ? defaultAssetTargetKeys.length === selectableAssetTargetOptions.length : imageSubjectIds.length === selectableImageSubjects.length) && (isSheet ? selectableAssetTargetOptions.length > 0 : selectableImageSubjects.length > 0)} indeterminate={isSheet ? defaultAssetTargetKeys.length > 0 && defaultAssetTargetKeys.length < selectableAssetTargetOptions.length : imageSubjectIds.length > 0 && imageSubjectIds.length < selectableImageSubjects.length}
                            onChange={(event) => {
                                if (isSheet) setSelectedAssetTargetKeys(event.target.checked ? selectableAssetTargetOptions.map((option) => option.key) : []);
                                else setSelectedSubjectIds(event.target.checked ? selectableImageSubjects.map((node) => node.id) : []);
                            }}>{isSheet ? "全选资产与状态" : "全选当前组"}</Checkbox>
                        <span role="status" aria-label="资产选择数量">已选 {isSheet ? defaultAssetTargetKeys.length : imageSubjectIds.length} / {isSheet ? selectableAssetTargetOptions.length : selectableImageSubjects.length} 项{imageSubjects.length > selectableImageSubjects.length ? ` · 已生成 ${imageSubjects.length - selectableImageSubjects.length} 项` : ""}</span>
                    </div> : null}
                    <label>{step.stage === "assets" ? "生成资产" : "镜头来源"}<Select aria-label="图片生成对象" showSearch optionFilterProp="label" mode={step.stage === "assets" ? "multiple" : undefined} value={step.stage === "assets" ? (isSheet ? defaultAssetTargetKeys : imageSubjectIds) : imageSubjectIds[0]} onChange={(value: string | string[]) => {
                        if (isSheet) setSelectedAssetTargetKeys(Array.isArray(value) ? value : [value]);
                        else setSelectedSubjectIds(Array.isArray(value) ? value : [value]);
                        setImagePrompt(null); setSelectedShotId(null);
                    }} options={isSheet ? assetTargetOptions.map((option) => ({ value: option.key, label: option.label, disabled: option.generated })) : imageSubjects.map((node) => {
                        const generated = step.stage === "assets" && isImage && workflowImageSubjectHasGeneratedResult(step.id, node.id, nodes);
                        return { value: node.id, label: [[nodeWorkflow(node)?.assetIdentity?.code, node.title].filter(Boolean).join(" · "), generated ? "已生成" : ""].filter(Boolean).join(" · "), disabled: generated };
                    })} /></label>
                    {isAudio ? imageSubjects.filter(node => imageSubjectIds.includes(node.id)).map(node => <label key={node.id}>{node.title} · 声线<Select aria-label={`${node.title}声线`} value={soundVoices[node.id] || audioValues.audioVoice} options={audioVoiceOptions.map(option => ({ value: option.value, label: option.label }))} onChange={value => setSoundVoices(current => ({ ...current, [node.id]: value }))} /></label>) : null}
                    {imageShots.length ? <label>镜头<Select aria-label="生成镜头" value={imageShotId} onChange={(id) => { setSelectedShotId(id); setImagePrompt(null); }} options={imageShots.map((shot) => ({ value: shot.id, label: shot.title }))} /></label> : null}
                    {step.stage === "storyboard" ? <label>镜头编号与画面提示词<CanvasResourceMentionTextarea aria-label="镜头编号与画面提示词" value={effectiveImagePrompt} onChange={setImagePrompt} references={assetMentions} rows={4} sendOnEnter={false} /></label> : null}
                </> : null}
                {!isAssetRevision && step.id !== ShortDramaStep.Plan && ancestors.length ? <div className="canvas-workflow-generator-progress" role="status" aria-label="分集制作进度">
                    <strong>共 {total} 集 · 每集 {parameters.minutesPerEpisode} 分钟</strong>
                    {isRepair ? <span>第 {nodeWorkflow(ancestors[0])?.episodeNumber} 集 · 原稿保留 · 新版需复检</span> : step.id === ShortDramaStep.Body ? <><progress max={total} value={progress.complete} aria-label="正文完成集数" /><span>{episodeProgressLabel(progress)}</span>{target.continueGeneration ? <span>继续生成第 {continuation.start}–{continuation.start + continuation.count - 1} 集 · 按 10 集步进，剩余不足 10 集时生成剩余集数</span> : null}</> : null}
                    {step.id === ShortDramaStep.Episodes ? <span aria-label="集纲生成范围">第 1–{total} 集 · 1 个集纲节点</span> : !isImage && collections.length ? <span>{target.aggregate || step.scope === "project" ? "本次汇总" : "本次按集生成"} {nodeWorkflow(collections[0])!.sourceNodeIds.length} 份文稿{step.output === "asset-group" ? " · 生成 1 个资产分组" : step.scope === "project" ? " · 生成 1 份统一文稿" : ""}</span> : null}
                    {step.id === ShortDramaStep.Audit ? <span>诊断范围：第 {start}–{auditEnd} 集 · 本次可处理 {auditSelectedReady.length} 集 · 仅读取对应正文及其必要依据</span> : null}
                    {sourceLength > WORKFLOW_CONTEXT_LIMIT && !productionAgent && !isImage && step.id !== ShortDramaStep.Audit && !isRepair ? <span aria-label="自动分批">长正文 · 按集/单元分批提取后汇总 · 每批独立调用模型</span> : null}
                </div> : null}
                {step.id === ShortDramaStep.Plan ? <div className="canvas-workflow-generator-pair"><label>计划集数<InputNumber aria-label="计划集数" readOnly={Boolean(globalSettings)} min={1} max={200} precision={0} value={globalSettings ? total : episodeCount} onChange={(value) => setEpisodeCount(value || 1)} /></label><label>单集时长（分钟）<Input aria-label="单集时长" readOnly={Boolean(globalSettings)} value={globalSettings ? parameters.minutesPerEpisode : minutes} onChange={(event) => setMinutes(event.target.value)} /></label></div> : null}
                {step.id === ShortDramaStep.Shots ? <div className="canvas-workflow-generator-pair"><label>目标镜头时长（秒）<InputNumber aria-label="目标镜头时长" min={5} max={60} precision={0} value={shotDurationSeconds} onChange={value => setShotDuration(Math.max(5, Math.min(60, value || 10)))} /></label><label>时长浮动<Select aria-label="镜头时长浮动" value={shotDurationToleranceSeconds} onChange={setShotTolerance} options={[3, 4, 5].map(value => ({ value, label: `±${value} 秒` }))} /></label></div> : null}
                {step.id === ShortDramaStep.Body && !isRepair ? <div className="canvas-workflow-generator-pair"><label>起始集数<InputNumber aria-label="起始集数" min={1} max={total} precision={0} value={start} onChange={(value) => { const next = Math.max(1, Math.min(total, value || 1)); setStart(next); setCount((old) => target.continueGeneration ? Math.min(DEFAULT_WORKFLOW_CONTINUATION_SPAN, total - next + 1) : Math.min(old, total - next + 1)); }} /></label><label>本次生成集数<InputNumber aria-label="本次生成集数" min={1} max={Math.max(1, total - start + 1)} step={target.continueGeneration ? DEFAULT_WORKFLOW_CONTINUATION_SPAN : 1} precision={0} value={count} onChange={(value) => setCount(Math.max(1, Math.min(total - start + 1, value || 1)))} /></label></div> : null}
                {isAudit ? auditEpisodes.length > 1 ? <div className="canvas-workflow-generator-pair"><label>起始集数<InputNumber aria-label="诊断起始集数" min={1} max={total} precision={0} value={start} onChange={(value) => { const next = Math.max(1, Math.min(total, value || 1)); setStart(next); setCount((old) => Math.min(old, total - next + 1)); }} /></label><label>结束集数<InputNumber aria-label="诊断结束集数" min={start} max={total} precision={0} value={auditEnd} onChange={(value) => { const next = Math.max(start, Math.min(total, value || start)); setCount(next - start + 1); }} /></label></div> : <div className="canvas-workflow-generator-progress" role="status"><strong>当前第 {auditEpisodes[0] || "—"} 集</strong><span>单集正文一键诊断，不读取其他集和无关资产</span></div> : null}
                <label>补充要求<CanvasResourceMentionTextarea aria-label="补充要求" value={instruction} onChange={setInstruction} references={assetMentions} rows={4} sendOnEnter={false} style={{ height: 96, minHeight: 96, width: "100%", padding: 8, border: "1px solid var(--workflow-border)", borderRadius: 6, color: "var(--workflow-text)", background: "var(--workflow-bg)" }} /></label>
                {dependencyError || error || imageError || auditRangeError ? <span role="alert">{error || dependencyError || imageError || auditRangeError}</span> : null}
                <Button type="primary" icon={<Sparkles size={15} />} loading={submitting} disabled={submitting || Boolean(dependencyError || imageError || auditRangeError) || !selectableModelsByCapability(config, capability).includes(model)} onClick={() => {
                    setError("");
                    try {
                        void onGenerate({ ...target, globalSettings, sourceNodeIds: sources.filter(Boolean), model, ...(step.id === ShortDramaStep.Shots ? { shotDurationSeconds, shotDurationToleranceSeconds } : {}), ...(isImage ? { imageSubjectIds, ...(isSheet ? { assetImageTargets: selectedAssetTargets.map((asset) => ({ subjectId: asset.subjectId, variantCode: asset.variantCode || undefined })) } : {}), imagePrompt: effectiveImagePrompt, imageShotId, imageSettings } : isAudio ? { imageSubjectIds, soundVoices, soundSettings: { kind: soundKind, text: calibrationText, voice: audioValues.audioVoice, format: audioValues.audioFormat, speed: audioValues.audioSpeed, instructions: audioValues.audioInstructions } } : { reasoningEffort: config.textReasoningEffort || "medium" }), instruction, episodeCount: step.id === ShortDramaStep.Plan && !globalSettings ? episodeCount : total, minutesPerEpisode: step.id === ShortDramaStep.Plan && !globalSettings ? minutes : parameters.minutesPerEpisode, start, count });
                        onClose();
                    }
                    catch (failure) { setError(failure instanceof Error ? failure.message : "生成提交失败"); }
                }}>{isRepair ? "修复正文并生成新版" : step.id === ShortDramaStep.Audit ? `诊断第 ${start}–${auditEnd} 集` : isAssetRevision ? `重做 ${revisionCount} 项资产` : isImage ? `生成 ${imageTargetCount} 张图片` : isAudio ? `生成 ${imageTargetCount} 份试听` : step.id === ShortDramaStep.Episodes ? "生成全剧集纲" : target.aggregate ? "生成跨集汇总" : step.id === ShortDramaStep.Body ? `生成 ${count} 集正文` : `生成${step.label}`}</Button>
            </fieldset>
        </section>
    </AppModal>;
}
