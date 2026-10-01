import { useEffect, useState } from "react";
import { Button, Input, InputNumber, Select, Switch, Tag } from "antd";
import { Image as ImageIcon, Palette, Plus, RefreshCw, Trash2, WandSparkles, X } from "lucide-react";

import { AppModal } from "@/components/ui/product/app-modal";
import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { ModelPicker } from "@/components/model-picker";
import { CanvasCameraControlPopover } from "@/components/canvas/canvas-camera-control-popover";
import { CanvasChooseImageStylePicker } from "@/components/canvas/canvas-choose-image-style-picker";
import { CanvasStylePickerModal, type CanvasStylePreset } from "@/components/canvas/canvas-style-picker-modal";
import { SkillRuntimePicker, useSkillRuntimeCatalog } from "@/components/skills/skill-runtime-picker";
import { canvasThemes } from "@/lib/canvas-theme";
import { createStyleProfileSnapshot, serializeStyleProfile } from "@/lib/canvas/style-profile";
import { defaultImageParamsForModel } from "@/lib/model-selection";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import type { AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import type { CanvasNodeData } from "@/types/canvas";
import type { CameraControlOptions } from "@/lib/canvas/camera-prompt-library";
import { analyzeTextAssetBatch } from "@/lib/canvas/text-asset-batch-analysis";
import type { TextAssetBatchAnalysisResult, TextAssetBatchCategory, TextAssetBatchItem } from "@/lib/canvas/text-asset-batch";

export type TextAssetBatchGenerationSettings = {
    model: string;
    imageModel?: string;
    quality?: string;
    size?: string;
    transparentBackground?: string;
    count: string;
    concurrency: number;
    cameraControl?: CameraControlOptions;
    skillIds?: string[];
    styleTool?: { id: number; label: string };
    stylePresetId?: string;
    styleProfileJson?: string;
};

type Props = {
    open: boolean;
    sourceNode: CanvasNodeData | null;
    projectId: string;
    config: AiConfig;
    projectStyle?: CanvasStylePreset | null;
    onClose: () => void;
    onConfirm: (items: TextAssetBatchItem[], settings: TextAssetBatchGenerationSettings) => void;
};

const CATEGORY_OPTIONS = [
    { value: "character", label: "角色" },
    { value: "environment", label: "场景" },
] satisfies Array<{ value: TextAssetBatchCategory; label: string }>;

const CONCURRENCY_OPTIONS = [1, 3, 5, 10].map((value) => ({ value, label: `${value} 个并发` }));
const TEXT_ASSET_ANALYSIS_MODEL_KEY = "yingce.canvas.text-asset-analysis-model";
type AnalysisStatus = "idle" | "analyzing" | "success" | "error";

export function CanvasTextBatchGenerationModal({ open, sourceNode, projectId, config, projectStyle, onClose, onConfirm }: Props) {
    const theme = canvasThemes[useActiveTheme()];
    const [items, setItems] = useState<TextAssetBatchItem[]>([]);
    const [generationConfig, setGenerationConfig] = useState<AiConfig>(config);
    const [concurrency, setConcurrency] = useState(5);
    const [cameraControl, setCameraControl] = useState<CameraControlOptions | undefined>();
    const [skillIds, setSkillIds] = useState<string[]>([]);
    const [styleTool, setStyleTool] = useState<{ id: number; label: string } | null>(null);
    const [selectedStyle, setSelectedStyle] = useState<CanvasStylePreset | null>(projectStyle || null);
    const [stylePickerOpen, setStylePickerOpen] = useState(false);
    const { skills, loading: skillsLoading } = useSkillRuntimeCatalog();
    const activeTaskLimit = useUserStore((state) => state.runtimeLimits.activeTaskLimit);
    const [analysis, setAnalysis] = useState<Omit<TextAssetBatchAnalysisResult, "items">>({ sourceCount: 0, mergedCount: 0 });
    const [analysisModel, setAnalysisModel] = useState("");
    const [analyzing, setAnalyzing] = useState(false);
    const [analysisStatus, setAnalysisStatus] = useState<AnalysisStatus>("idle");
    const [analysisError, setAnalysisError] = useState("");

    useEffect(() => {
        if (!open) return;
        setGenerationConfig(config);
        setConcurrency(5);
        setCameraControl(undefined);
        setSkillIds([]);
        setStyleTool(null);
        setSelectedStyle(projectStyle || null);
        setStylePickerOpen(false);
        setItems([]);
        setAnalysis({ sourceCount: 0, mergedCount: 0 });
        setAnalysisStatus("idle");
        setAnalysisError("");
        const previousModel = sourceNode?.metadata?.model;
        const rememberedModel = typeof window !== "undefined" ? window.localStorage.getItem(TEXT_ASSET_ANALYSIS_MODEL_KEY) || "" : "";
        const preferredModel = rememberedModel || previousModel || config.textModel || config.textModels[0] || config.model || "";
        setAnalysisModel(preferredModel && (config.textModels.includes(preferredModel) || !config.textModels.length) ? preferredModel : config.textModel || config.textModels[0] || config.model || "");
    }, [open, projectStyle, sourceNode?.id]);

    const analyze = async () => {
        const content = (sourceNode?.metadata?.content || sourceNode?.metadata?.prompt || "").trim();
        if (!content) {
            setAnalysisError("文本节点为空，无法分析资产");
            return;
        }
        if (!analysisModel.trim()) {
            setAnalysisError("请先选择文本分析模型");
            return;
        }
        setAnalyzing(true);
        setAnalysisStatus("analyzing");
        setAnalysisError("");
        try {
            const result = await analyzeTextAssetBatch({
                content,
                config: { ...config, model: analysisModel, textModel: analysisModel },
                projectId,
                skills,
                selectedSkillIds: skillIds,
            });
            setItems(result.items);
            setAnalysis({ sourceCount: result.sourceCount, mergedCount: result.mergedCount });
            setAnalysisStatus("success");
        } catch (error) {
            setAnalysisError(error instanceof Error ? error.message : "资产分析失败，请重试");
            setItems([]);
            setAnalysisStatus("error");
        } finally {
            setAnalyzing(false);
        }
    };

    const enabledCount = items.filter((item) => item.enabled && item.title.trim() && item.prompt.trim()).length;
    const imageModel = generationConfig.imageModel || generationConfig.model;
    const analysisPickerConfig = { ...config, model: analysisModel, textModel: analysisModel };

    const updateItem = (id: string, patch: Partial<TextAssetBatchItem>) => {
        setItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
    };

    const handleModelChange = (model: string) => {
        setGenerationConfig((current) => ({ ...current, model, imageModel: model, ...defaultImageParamsForModel(current, model) }));
    };

    const handleAnalysisModelChange = (model: string) => {
        setAnalysisModel(model);
        if (typeof window !== "undefined") window.localStorage.setItem(TEXT_ASSET_ANALYSIS_MODEL_KEY, model);
    };

    const updateConcurrency = (value: number | null) => {
        if (value === null || !Number.isFinite(value)) return;
        setConcurrency(Math.max(1, Math.floor(value)));
    };

    const addItem = () => {
        setItems((current) => [...current, { id: `asset-batch-manual-${Date.now()}`, category: "character", title: "", prompt: "", enabled: true }]);
    };

    return (
        <AppModal
            rootClassName="canvas-text-batch-generation-modal"
            open={open}
            onCancel={onClose}
            footer={null}
            centered
            destroyOnHidden
            width="min(920px, calc(100vw - 32px))"
            title="按 Note 批量生成角色与场景"
        >
            <div className="flex h-[min(760px,calc(100dvh-136px))] max-h-[calc(100dvh-136px)] min-h-0 flex-col gap-4 py-2">
                <div className="thin-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
                    <div className="rounded-lg bg-black/5 px-3 py-3 dark:bg-white/[0.04]">
                        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(220px,280px)_auto] lg:items-end">
                            <div className="min-w-0">
                                <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
                                    <ImageIcon className="size-4 shrink-0" />
                                    <span className="truncate">
                                        {analyzing ? "正在用内置资产分析 Skill 分析 Note…" : analysisStatus === "success" ? `已从「${sourceNode?.title || "文本节点"}」完成资产分析` : `分析「${sourceNode?.title || "文本节点"}」`}
                                    </span>
                                </div>
                                <div className="mt-1 text-xs leading-5 opacity-70">选择或沿用文本模型及可选制作 Skill 后，点击“开始分析”。模型会保守合并同一人物或地点，并为每项准备完整设定板提示词。</div>
                                {analysisStatus === "success" ? (
                                    <div className="mt-1 text-xs opacity-70">
                                        原文候选 {analysis.sourceCount} 项，已归并 {analysis.mergedCount} 项重复内容。
                                    </div>
                                ) : null}
                            </div>
                            <div className={analyzing ? "pointer-events-none opacity-60" : ""}>
                                <div className="mb-1 text-xs font-medium opacity-70">文本分析模型</div>
                                <ModelPicker config={analysisPickerConfig} value={analysisModel} capability="text" fullWidth showSelectedPrice={false} onChange={handleAnalysisModelChange} />
                            </div>
                            <Button className="!m-0 inline-flex h-8 items-center justify-center" icon={<RefreshCw className="size-3.5" />} loading={analyzing} disabled={!analysisModel.trim()} onClick={() => void analyze()}>
                                {analysisStatus === "success" ? "重新分析" : "开始分析"}
                            </Button>
                        </div>
                        <div className="mt-2 min-h-5">
                            {analysisError ? (
                                <div className="flex items-center justify-between gap-2 text-xs text-red-500">
                                    <span>{analysisError}</span>
                                    <Button size="small" danger type="link" onClick={() => void analyze()}>
                                        重试
                                    </Button>
                                </div>
                            ) : null}
                        </div>
                    </div>

                    {analysisStatus === "success" ? (
                        <div className="space-y-2">
                            <div className="text-sm font-medium opacity-80">资产条目</div>
                            {items.map((item, index) => (
                                <div key={item.id} className={`rounded-lg border p-3 ${item.enabled ? "" : "opacity-55"}`} style={{ borderColor: theme.node.stroke }}>
                                    <div className="flex items-center gap-2">
                                        <Switch size="small" checked={item.enabled} onChange={(enabled) => updateItem(item.id, { enabled })} aria-label={`启用第 ${index + 1} 个资产`} />
                                        <Tag color={item.category === "character" ? "blue" : "green"}>{item.category === "character" ? "角色" : "场景"}</Tag>
                                        <Input size="small" value={item.title} placeholder={`资产 ${index + 1} 名称`} className="min-w-0 flex-1" onChange={(event) => updateItem(item.id, { title: event.target.value })} />
                                        <Select size="small" value={item.category} options={CATEGORY_OPTIONS} onChange={(category) => updateItem(item.id, { category })} />
                                        <Button
                                            type="text"
                                            danger
                                            icon={<Trash2 className="size-4" />}
                                            aria-label={`删除 ${item.title || `资产 ${index + 1}`}`}
                                            onClick={() => setItems((current) => current.filter((candidate) => candidate.id !== item.id))}
                                        />
                                    </div>
                                    {item.aliases?.length ? <div className="mt-2 text-xs opacity-70">已合并别名：{item.aliases.join("、")}</div> : null}
                                    {item.summary ? <div className="mt-1 text-xs opacity-70">归并摘要：{item.summary}</div> : null}
                                    <Input.TextArea value={item.prompt} autoSize={{ minRows: 2, maxRows: 6 }} className="mt-2" placeholder="用于生成这张角色/场景参考图的完整描述" onChange={(event) => updateItem(item.id, { prompt: event.target.value })} />
                                    {item.sourceEvidence ? <div className="mt-2 rounded bg-black/[0.03] px-2 py-1.5 text-xs opacity-70 dark:bg-white/[0.03]">来源证据：{item.sourceEvidence}</div> : null}
                                </div>
                            ))}
                            {!items.length ? <div className="py-8 text-center text-sm opacity-60">未识别到可复用的角色或场景。</div> : null}
                            <Button type="dashed" icon={<Plus className="size-4" />} onClick={addItem}>
                                添加资产条目
                            </Button>
                        </div>
                    ) : null}

                    <div className="grid gap-3 border-t pt-3 md:grid-cols-[minmax(0,1fr)_220px]" style={{ borderColor: theme.node.stroke }}>
                        <div>
                            <div className="mb-2 text-sm font-medium opacity-75">生成模型</div>
                            <ModelPicker config={generationConfig} value={imageModel} capability="image" fullWidth showSelectedPrice={false} onChange={handleModelChange} />
                        </div>
                        <div>
                            <div className="mb-2 text-sm font-medium opacity-75">并发数量</div>
                            <div className="flex gap-2">
                                <Select className="min-w-0 flex-1" value={CONCURRENCY_OPTIONS.some((option) => option.value === concurrency) ? concurrency : undefined} options={CONCURRENCY_OPTIONS} placeholder="预设" onChange={setConcurrency} />
                                <InputNumber className="w-[92px] shrink-0" min={1} value={concurrency} onChange={updateConcurrency} />
                            </div>
                            <div className="mt-1 text-xs leading-5 opacity-60">{activeTaskLimit > 0 ? `本账号当前最多同时处理 ${activeTaskLimit} 个任务，超过后会自动排队。` : "本账号活动任务不设总数上限，实际执行仍受 Worker 和渠道并发配置控制。"}</div>
                        </div>
                    </div>

                    <div className="border-t pt-3" style={{ borderColor: theme.node.stroke }}>
                        <ImageSettingsPanel
                            config={generationConfig}
                            onConfigChange={(key, value) => setGenerationConfig((current) => ({ ...current, [key]: value }))}
                            theme={theme}
                            showTitle={false}
                            showCount={false}
                            quickCount={4}
                            maxCount={10}
                            bypassPriceGuard
                            className="w-full space-y-3"
                        />
                    </div>

                    <div className="border-t pt-3" style={{ borderColor: theme.node.stroke }}>
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                                <div className="text-sm font-medium opacity-75">风格工具</div>
                                <div className="mt-1 text-xs leading-5 opacity-60">与单张生图的风格选择相同，统一应用到本批次所有资产。</div>
                            </div>
                            <CanvasChooseImageStylePicker activeToolId={styleTool?.id} activeLabel={styleTool?.label} onSelect={(id, label) => setStyleTool({ id, label })} onClear={() => setStyleTool(null)} />
                        </div>
                    </div>

                    <div className="border-t pt-3" style={{ borderColor: theme.node.stroke }}>
                        <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
                            <div>
                                <div className="text-sm font-medium opacity-75">项目画风</div>
                                <div className="mt-1 text-xs leading-5 opacity-60">未选择显式画风时，按内置资产 Skill 规则生成；选择后按项目画风规范生成。</div>
                            </div>
                            <Button className="!m-0 shrink-0" icon={<Palette className="size-3.5" />} onClick={() => setStylePickerOpen(true)}>
                                {selectedStyle?.title || "选择项目画风"}
                            </Button>
                        </div>
                        {selectedStyle ? (
                            <div className="flex items-center justify-between gap-3 rounded-md px-3 py-2 text-xs" style={{ background: theme.canvas.background, border: `1px solid ${theme.node.stroke}` }}>
                                <span className="min-w-0 truncate">{projectStyle?.id === selectedStyle.id ? "沿用项目画风" : selectedStyle.description || selectedStyle.title}</span>
                                <Button type="text" size="small" onClick={() => setSelectedStyle(null)}>
                                    不使用
                                </Button>
                            </div>
                        ) : (
                            <div className="rounded-md px-3 py-2 text-xs opacity-60" style={{ background: theme.canvas.background, border: `1px solid ${theme.node.stroke}` }}>
                                当前未选择显式画风，将使用内置资产 Skill 规则。
                            </div>
                        )}
                    </div>

                    <div className="border-t pt-3" style={{ borderColor: theme.node.stroke }}>
                        <div className="mb-2 text-sm font-medium opacity-75">制作 Skill</div>
                        <SkillRuntimePicker skills={skills} loading={skillsLoading} value={skillIds} onChange={setSkillIds} placeholder="可选：选择本批次使用的制作 Skill" profile="canvas" />
                    </div>

                    <div className="flex items-center justify-between border-t pt-3" style={{ borderColor: theme.node.stroke }}>
                        <div>
                            <div className="text-sm font-medium">摄像机控制</div>
                            <div className="mt-1 text-xs opacity-60">为本批次统一应用镜头、焦段和光圈提示</div>
                        </div>
                        <CanvasCameraControlPopover cameraControl={cameraControl} onCameraControlChange={setCameraControl} theme={theme} compact />
                    </div>
                </div>

                <div className="flex shrink-0 items-center justify-end gap-2 border-t pt-3" style={{ borderColor: theme.node.stroke }}>
                    <Button className="!m-0 inline-flex h-9 min-w-[96px] items-center justify-center" icon={<X className="size-4" />} onClick={onClose}>
                        取消
                    </Button>
                    <Button
                        className="!m-0 inline-flex h-9 min-w-[176px] items-center justify-center"
                        type="primary"
                        icon={<WandSparkles className="size-4" />}
                        disabled={analyzing || !enabledCount}
                        onClick={() =>
                            onConfirm(
                                items.filter((item) => item.enabled && item.title.trim() && item.prompt.trim()),
                                {
                                    model: generationConfig.model,
                                    imageModel: generationConfig.imageModel,
                                    quality: generationConfig.quality,
                                    size: generationConfig.size,
                                    transparentBackground: generationConfig.transparentBackground,
                                    count: "1",
                                    concurrency,
                                    cameraControl,
                                    skillIds,
                                    styleTool: styleTool || undefined,
                                    stylePresetId: selectedStyle?.id,
                                    styleProfileJson: selectedStyle ? serializeStyleProfile(selectedStyle.profile || createStyleProfileSnapshot(selectedStyle)) : undefined,
                                },
                            )
                        }
                    >
                        开始生成 {enabledCount} 个资产
                    </Button>
                </div>
            </div>
            <CanvasStylePickerModal
                open={stylePickerOpen}
                value={selectedStyle?.id}
                currentProfile={selectedStyle?.profile || null}
                onClose={() => setStylePickerOpen(false)}
                onSelect={(preset) => {
                    setSelectedStyle(preset);
                    setStylePickerOpen(false);
                }}
            />
        </AppModal>
    );
}
