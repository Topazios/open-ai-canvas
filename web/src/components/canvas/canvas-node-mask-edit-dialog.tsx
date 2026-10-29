import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button, Input, Modal, Segmented, Slider } from "antd";
import { Brush, ChevronDown, Eraser, RotateCcw, WandSparkles, X } from "lucide-react";

import { readImageMeta } from "@/lib/image-utils";
import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { ModelPicker } from "@/components/model-picker";
import { defaultImageParamsForModel } from "@/lib/model-selection";
import type { AiConfig } from "@/stores/use-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";

export type CanvasImageMaskEditPayload = {
    prompt: string;
    maskDataUrl: string;
    generationConfig?: Partial<Pick<AiConfig, "model" | "imageModel" | "size" | "quality" | "count" | "transparentBackground">>;
};

type DrawMode = "paint" | "erase";
type RedrawTab = "prompt" | "mask";

type CanvasNodeRedrawDialogProps = {
    dataUrl: string;
    open: boolean;
    config: AiConfig;
    initialPrompt?: string;
    canEditPrompt?: boolean;
    canAutoAdjust?: boolean;
    onClose: () => void;
    onConfirm: (payload: CanvasImageMaskEditPayload) => void;
    onRegenerate?: (prompt: string) => void;
    onAutoAdjust?: () => void;
};

const defaultBrushSize = 100;
const maskFillColor = "rgba(37, 99, 235, .38)";
const maskBorderColor = "rgba(255, 255, 255, .72)";

export function CanvasNodeMaskEditDialog({ dataUrl, open, config, initialPrompt = "", canEditPrompt = false, canAutoAdjust = false, onClose, onConfirm, onRegenerate, onAutoAdjust }: CanvasNodeRedrawDialogProps) {
    const maskCanvasRef = useRef<HTMLCanvasElement>(null);
    const previewCanvasRef = useRef<HTMLCanvasElement>(null);
    const drawingRef = useRef<{ active: boolean; last: { x: number; y: number } | null }>({ active: false, last: null });
    const [image, setImage] = useState<{ width: number; height: number } | null>(null);
    const [prompt, setPrompt] = useState("");
    const [brushSize, setBrushSize] = useState(defaultBrushSize);
    const [mode, setMode] = useState<DrawMode>("paint");
    const [error, setError] = useState("");
    const [generationConfig, setGenerationConfig] = useState<AiConfig>(() => config);
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const [tab, setTab] = useState<RedrawTab>("prompt");
    const [regenPrompt, setRegenPrompt] = useState(initialPrompt);
    const [regenError, setRegenError] = useState("");
    const hasImage = Boolean(dataUrl);
    const showPromptTab = canEditPrompt && Boolean(onRegenerate);
    const activeTab: RedrawTab = !hasImage ? "prompt" : showPromptTab ? tab : "mask";
    const theme = canvasThemes[useActiveTheme()];

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        setPrompt("");
        setBrushSize(defaultBrushSize);
        setMode("paint");
        setError("");
        setAdvancedOpen(false);
        setTab(showPromptTab ? "prompt" : "mask");
        setRegenPrompt(initialPrompt);
        setRegenError("");
        setGenerationConfig(config);
        setImage(null);
        if (dataUrl) {
            void readImageMeta(dataUrl).then((meta) => {
                if (!cancelled) setImage(meta);
            });
        }
        return () => {
            cancelled = true;
        };
    }, [dataUrl, open, initialPrompt]);

    useEffect(() => {
        clearCanvas(maskCanvasRef.current);
        clearCanvas(previewCanvasRef.current);
    }, [image]);

    const draw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        const point = readCanvasPoint(event.currentTarget, event.clientX, event.clientY);
        const maskCanvas = maskCanvasRef.current;
        const context = maskCanvas?.getContext("2d");
        if (!maskCanvas || !context) return;
        context.lineCap = "round";
        context.lineJoin = "round";
        context.lineWidth = brushSize;
        context.globalCompositeOperation = mode === "paint" ? "source-over" : "destination-out";
        context.strokeStyle = "#000";
        context.fillStyle = "#000";
        if (!drawingRef.current.last) {
            drawMaskStroke(context, point, point, brushSize);
        } else {
            drawMaskStroke(context, drawingRef.current.last, point, brushSize);
        }
        renderMaskPreview(maskCanvas, previewCanvasRef.current);
        drawingRef.current.last = point;
        if (mode === "paint") {
            setError("");
        }
    };

    const startDraw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        if (activeTab !== "mask") return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        drawingRef.current = { active: true, last: null };
        if (maskCanvasRef.current) renderMaskPreview(maskCanvasRef.current, previewCanvasRef.current);
        draw(event);
    };

    const moveDraw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        if (activeTab !== "mask" || !drawingRef.current.active) return;
        event.preventDefault();
        draw(event);
    };

    const stopDraw = () => {
        drawingRef.current = { active: false, last: null };
        const maskCanvas = maskCanvasRef.current;
        if (maskCanvas) renderMaskPreview(maskCanvas, previewCanvasRef.current, canvasHasPaint(maskCanvas));
    };

    const resetMask = () => {
        clearCanvas(maskCanvasRef.current);
        clearCanvas(previewCanvasRef.current);
        setError("");
    };

    const submitRegenerate = () => {
        const nextPrompt = regenPrompt.trim();
        if (!nextPrompt) return setRegenError("请输入提示词");
        onRegenerate?.(nextPrompt);
    };

    const submit = () => {
        const nextPrompt = prompt.trim();
        const canvas = maskCanvasRef.current;
        if (!nextPrompt) return setError("请输入修改要求");
        if (!canvas) return;
        if (!canvasHasPaint(canvas)) return setError("请先涂抹局部区域");
        onConfirm({ prompt: nextPrompt, maskDataUrl: buildEditMask(canvas), generationConfig: { model: generationConfig.model, imageModel: generationConfig.imageModel, size: generationConfig.size, quality: generationConfig.quality, count: generationConfig.count, transparentBackground: generationConfig.transparentBackground } });
    };

    const subtitle = !hasImage ? "图片生成失败，可修改提示词后重新生成" : image ? `${image.width} x ${image.height}px` : "读取中";

    return (
        <Modal className={hasImage ? "workspace-modal workspace-modal-wide" : "workspace-modal"} title={null} open={open} onCancel={onClose} footer={null} width={hasImage ? undefined : 520} centered destroyOnHidden>
            <div className={hasImage ? "flex min-w-0 flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-5" : "flex min-w-0 flex-col"} style={hasImage ? undefined : { height: "min(480px, calc(100dvh - 96px))" }}>
                {hasImage ? (
                    <div className="flex h-[34dvh] min-h-0 min-w-0 items-center justify-center overflow-hidden rounded-lg bg-surface-active lg:h-[min(640px,calc(100dvh-96px))]">
                        <div className="relative inline-block max-w-full overflow-hidden rounded-lg bg-transparent select-none">
                            <img src={dataUrl} alt="" className="relative z-0 block max-h-[34dvh] max-w-full bg-transparent lg:max-h-[min(640px,calc(100dvh-96px))]" draggable={false} />
                            {image ? (
                                <>
                                    <canvas ref={maskCanvasRef} width={image.width} height={image.height} className="hidden" />
                                    <canvas
                                        ref={previewCanvasRef}
                                        width={image.width}
                                        height={image.height}
                                        className={`absolute inset-0 z-10 h-full w-full touch-none ${activeTab === "mask" ? "cursor-crosshair" : "pointer-events-none"}`}
                                        onPointerDown={startDraw}
                                        onPointerMove={moveDraw}
                                        onPointerUp={stopDraw}
                                        onPointerCancel={stopDraw}
                                    />
                                </>
                            ) : null}
                        </div>
                    </div>
                ) : null}

                <div className={`flex min-h-0 min-w-0 flex-col gap-4 overflow-hidden ${hasImage ? "h-[calc(66dvh-72px)] min-h-[360px] lg:h-[min(640px,calc(100dvh-96px))]" : "h-full"}`}>
                    <div className="flex shrink-0 flex-col gap-3">
                        <div className="flex min-w-0 flex-col gap-1">
                            <h2 className="text-xl font-semibold leading-7">重绘</h2>
                            <div className="text-sm leading-5 opacity-60">{subtitle}</div>
                        </div>
                        {hasImage && showPromptTab ? <Segmented block value={activeTab} options={[{ label: "提示词", value: "prompt" }, { label: "局部重绘", value: "mask" }]} onChange={(value) => setTab(value as RedrawTab)} /> : null}
                    </div>

                    <div className="thin-scrollbar min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden pr-1 [scrollbar-gutter:stable]">
                        {activeTab === "prompt" ? (
                            <div className="flex h-full min-h-[240px] min-w-0 flex-col gap-2">
                                <div className="flex shrink-0 items-center justify-between gap-2">
                                    <span className="text-sm font-medium opacity-75">提示词</span>
                                    {canAutoAdjust && onAutoAdjust ? (
                                        <Button size="small" className="shrink-0 whitespace-nowrap" icon={<WandSparkles className="size-3.5" />} onClick={onAutoAdjust}>
                                            自动调整
                                        </Button>
                                    ) : null}
                                </div>
                                <div className="min-h-0 flex-1">
                                    <Input.TextArea
                                        className="!h-full !resize-none"
                                        value={regenPrompt}
                                        status={regenError ? "error" : undefined}
                                        placeholder="修改后将按新提示词整体重新生成这张图"
                                        onChange={(event) => {
                                            setRegenPrompt(event.target.value);
                                            setRegenError("");
                                        }}
                                    />
                                </div>
                                {regenError ? <div className="shrink-0 text-xs font-medium text-destructive">{regenError}</div> : null}
                                <div className="shrink-0 break-words text-xs leading-5 opacity-60">整体重新生成会发起新的计费调用，原图保留在历史中。</div>
                            </div>
                        ) : (
                            <div className="flex min-w-0 flex-col gap-4">
                                <div className="grid grid-cols-2 gap-2">
                                    <Button className="whitespace-nowrap" type={mode === "paint" ? "primary" : "default"} aria-pressed={mode === "paint"} icon={<Brush className="size-4" />} onClick={() => setMode("paint")}>
                                        画笔
                                    </Button>
                                    <Button className="whitespace-nowrap" type={mode === "erase" ? "primary" : "default"} aria-pressed={mode === "erase"} icon={<Eraser className="size-4" />} onClick={() => setMode("erase")}>
                                        擦除
                                    </Button>
                                </div>

                                <div className="flex flex-col gap-2">
                                    <div className="flex items-center justify-between gap-2 text-sm">
                                        <span className="font-medium opacity-75">笔刷大小</span>
                                        <span className="font-semibold">{brushSize}px</span>
                                    </div>
                                    <Slider min={8} max={160} step={2} value={brushSize} onChange={setBrushSize} />
                                </div>

                                <div className="flex flex-col gap-2">
                                    <div className="text-sm font-medium opacity-75">修改要求</div>
                                    <Input.TextArea
                                        rows={3}
                                        value={prompt}
                                        status={error && !prompt.trim() ? "error" : undefined}
                                        placeholder="例如：把选中区域改成金属材质，保持原图光影"
                                        onChange={(event) => {
                                            setPrompt(event.target.value);
                                            setError("");
                                        }}
                                    />
                                    {error ? <div className="text-xs font-medium text-destructive">{error}</div> : null}
                                </div>

                                <div className="rounded-xl border border-border/60">
                                    <button
                                        type="button"
                                        className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-sm font-medium"
                                        aria-expanded={advancedOpen}
                                        onClick={() => setAdvancedOpen((current) => !current)}
                                    >
                                        <span>高级生成设置</span>
                                        <ChevronDown className={`size-4 shrink-0 opacity-60 transition-transform ${advancedOpen ? "rotate-180" : ""}`} />
                                    </button>
                                    {advancedOpen ? (
                                        <div className="flex flex-col gap-3 border-t border-border/60 px-3 pb-3 pt-3">
                                            <div className="flex flex-col gap-2">
                                                <div className="text-sm font-medium opacity-75">生成模型</div>
                                                <ModelPicker
                                                    config={generationConfig}
                                                    value={generationConfig.imageModel || generationConfig.model}
                                                    capability="image"
                                                    fullWidth
                                                    showSelectedPrice={false}
                                                    onChange={(model) => setGenerationConfig((current) => ({ ...current, model, imageModel: model, ...defaultImageParamsForModel(current, model) }))}
                                                />
                                            </div>
                                            <ImageSettingsPanel
                                                config={generationConfig}
                                                showTitle={false}
                                                showCount={false}
                                                bypassPriceGuard
                                                className="space-y-3"
                                                theme={theme}
                                                onConfigChange={(key, value) => setGenerationConfig((current) => ({ ...current, [key]: value }))}
                                            />
                                        </div>
                                    ) : null}
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-t border-border/50 pt-3">
                        {activeTab === "mask" ? (
                            <Button className="shrink-0 whitespace-nowrap" icon={<RotateCcw className="size-4" />} onClick={resetMask}>
                                重置
                            </Button>
                        ) : (
                            <span />
                        )}
                        <div className="flex shrink-0 items-center gap-2">
                            <Button className="whitespace-nowrap" icon={<X className="size-4" />} onClick={onClose}>
                                取消
                            </Button>
                            {activeTab === "mask" ? (
                                <Button className="whitespace-nowrap" type="primary" icon={<WandSparkles className="size-4" />} onClick={submit}>
                                    AI 修改
                                </Button>
                            ) : (
                                <Button className="whitespace-nowrap" type="primary" icon={<WandSparkles className="size-4" />} onClick={submitRegenerate}>
                                    保存并重新生成
                                </Button>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </Modal>
    );
}

function readCanvasPoint(canvas: HTMLCanvasElement, clientX: number, clientY: number) {
    const rect = canvas.getBoundingClientRect();
    return {
        x: ((clientX - rect.left) / Math.max(1, rect.width)) * canvas.width,
        y: ((clientY - rect.top) / Math.max(1, rect.height)) * canvas.height,
    };
}

function clearCanvas(canvas: HTMLCanvasElement | null) {
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
}

function drawMaskStroke(context: CanvasRenderingContext2D, from: { x: number; y: number }, to: { x: number; y: number }, size: number) {
    if (from.x === to.x && from.y === to.y) {
        context.beginPath();
        context.arc(to.x, to.y, size / 2, 0, Math.PI * 2);
        context.fill();
        return;
    }
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
}

function canvasHasPaint(canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d");
    if (!context) return false;
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let index = 3; index < data.length; index += 4) {
        if (data[index] > 0) return true;
    }
    return false;
}

function renderMaskPreview(maskCanvas: HTMLCanvasElement, previewCanvas: HTMLCanvasElement | null, withBorder = false) {
    const context = previewCanvas?.getContext("2d");
    if (!previewCanvas || !context) return;
    context.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    context.fillStyle = maskFillColor;
    context.fillRect(0, 0, previewCanvas.width, previewCanvas.height);
    context.globalCompositeOperation = "destination-in";
    context.drawImage(maskCanvas, 0, 0);
    context.globalCompositeOperation = "source-over";
    if (withBorder) drawDashedMaskBorder(context, maskCanvas);
}

function drawDashedMaskBorder(context: CanvasRenderingContext2D, maskCanvas: HTMLCanvasElement) {
    const maskContext = maskCanvas.getContext("2d");
    if (!maskContext) return;
    const { width, height } = maskCanvas;
    const data = maskContext.getImageData(0, 0, width, height).data;
    const step = Math.max(1, Math.round(Math.max(width, height) / 1200));
    const dash = step * 8;
    const gap = step * 5;
    const period = dash + gap;

    context.save();
    context.fillStyle = maskBorderColor;
    context.shadowColor = "rgba(0, 0, 0, .24)";
    context.shadowBlur = step * 1.5;
    for (let y = step; y < height - step; y += step) {
        for (let x = step; x < width - step; x += step) {
            const offset = (y * width + x) * 4 + 3;
            if (data[offset] === 0 || !isMaskEdge(data, width, x, y, step)) continue;
            if ((x + y) % period > dash) continue;
            context.fillRect(x - step / 2, y - step / 2, Math.max(1.5, step), Math.max(1.5, step));
        }
    }
    context.restore();
}

function isMaskEdge(data: Uint8ClampedArray, width: number, x: number, y: number, step: number) {
    return data[((y - step) * width + x) * 4 + 3] === 0 || data[((y + step) * width + x) * 4 + 3] === 0 || data[(y * width + x - step) * 4 + 3] === 0 || data[(y * width + x + step) * 4 + 3] === 0;
}

function buildEditMask(selectionCanvas: HTMLCanvasElement) {
    const canvas = document.createElement("canvas");
    canvas.width = selectionCanvas.width;
    canvas.height = selectionCanvas.height;
    const context = canvas.getContext("2d");
    if (!context) return selectionCanvas.toDataURL("image/png");
    const selectionContext = selectionCanvas.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (!selectionContext) return canvas.toDataURL("image/png");
    const selection = selectionContext.getImageData(0, 0, canvas.width, canvas.height);
    const mask = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let index = 3; index < mask.data.length; index += 4) {
        if (selection.data[index] > 0) mask.data[index] = 0;
    }
    context.putImageData(mask, 0, 0);
    return canvas.toDataURL("image/png");
}
