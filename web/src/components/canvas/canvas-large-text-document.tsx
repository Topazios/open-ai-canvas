import { App, Button, Input, Segmented } from "antd";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Pencil, Save, X } from "lucide-react";
import { AppModal } from "@/components/ui/product/app-modal";
import { canvasThemes } from "@/lib/canvas-theme";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import type { CanvasNodeData } from "@/types/canvas";
import { CanvasVirtualDocument } from "./canvas-virtual-document";
import "./canvas-large-text-document.css";

const CodeMirror = lazy(() => import("@uiw/react-codemirror"));

export function CanvasLargeTextDocument({ node, onClose, onSave }: { node: CanvasNodeData; onClose: () => void; onSave: (nodeId: string, title: string, content: string) => Promise<void> | void }) {
    const { message, modal } = App.useApp();
    const themeName = useActiveTheme();
    const theme = canvasThemes[themeName];
    const [title, setTitle] = useState(node.title);
    const [content, setContent] = useState(node.metadata?.content ?? "");
    const [preview, setPreview] = useState(content);
    const [mode, setMode] = useState<"preview" | "edit">("preview");
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);
    const savingRef = useRef(false);
    const revision = useRef(0);
    const save = async () => {
        if (savingRef.current) return;
        const saved = revision.current;
        savingRef.current = true;
        setSaving(true);
        try {
            await onSave(node.id, title.trim() || "文稿", content);
            if (revision.current === saved) setDirty(false);
            message.success("文稿已保存");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "文稿保存失败");
        } finally {
            savingRef.current = false;
            setSaving(false);
        }
    };
    const close = () => {
        if (savingRef.current) return;
        if (!dirty) return onClose();
        modal.confirm({ title: "放弃未保存的修改？", okText: "放弃修改", cancelText: "继续编辑", onOk: onClose });
    };
    useEffect(() => {
        const listener = (event: KeyboardEvent) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
                event.preventDefault();
                void save();
            }
        };
        window.addEventListener("keydown", listener);
        return () => window.removeEventListener("keydown", listener);
    });
    return (
        <AppModal open title={null} footer={null} closable={false} centered destroyOnHidden width="min(1360px, calc(100vw - 24px))" onCancel={close} flush>
            <section className="flex h-[min(88dvh,900px)] min-w-0 flex-col overflow-hidden" style={{ background: theme.node.panel, color: theme.node.text }}>
                <header className="canvas-large-document-header" style={{ borderColor: theme.node.stroke }}>
                    <div className="canvas-large-document-identity">
                        <Input
                            className="canvas-large-document-title"
                            variant="borderless"
                            aria-label="文稿标题"
                            value={title}
                            onChange={(event) => {
                                setTitle(event.target.value);
                                revision.current++;
                                setDirty(true);
                            }}
                        />
                        <span className="text-xs" style={{ color: theme.node.muted }}>
                            {content.length.toLocaleString("zh-CN")} 字
                        </span>
                    </div>
                    <div className="canvas-large-document-actions" role="toolbar" aria-label="文稿操作">
                        <Segmented<"preview" | "edit">
                            value={mode}
                            options={[
                                { label: "预览", value: "preview" },
                                {
                                    label: (
                                        <span className="inline-flex items-center gap-1">
                                            <Pencil className="size-3" />
                                            编辑
                                        </span>
                                    ),
                                    value: "edit",
                                },
                            ]}
                            onChange={(value) => {
                                if (value === "preview") setPreview(content);
                                setMode(value);
                            }}
                        />
                        <Button icon={<Save className="size-4" />} type="primary" disabled={!dirty} loading={saving} onClick={() => void save()}>
                            保存
                        </Button>
                        <Button icon={<X className="size-4" />} type="text" aria-label="关闭文稿" title="关闭文稿" onClick={close} />
                    </div>
                </header>
                {mode === "preview" ? (
                    <CanvasVirtualDocument source={preview} />
                ) : (
                    <div className="min-h-0 flex-1 overflow-hidden [&_.cm-editor]:h-full [&_.cm-scroller]:overflow-auto" data-canvas-no-zoom data-canvas-wheel-scroll>
                        <Suspense fallback={<div className="p-4">正在打开编辑器…</div>}>
                            <CodeMirror
                                className="h-full"
                                value={content}
                                height="100%"
                                theme={themeName === "dark" ? "dark" : "light"}
                                basicSetup={{ lineNumbers: true, foldGutter: true }}
                                onChange={(value) => {
                                    setContent(value);
                                    revision.current++;
                                    setDirty(true);
                                }}
                            />
                        </Suspense>
                    </div>
                )}
            </section>
        </AppModal>
    );
}
