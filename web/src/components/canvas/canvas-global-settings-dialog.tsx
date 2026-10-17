import { useRef, useState } from "react";
import { Alert, Button, Input, InputNumber } from "antd";
import { ChevronDown, FileUp, Save, X } from "lucide-react";
import { Select } from "@/components/ui/base/select";
import { AppModal } from "@/components/ui/product/app-modal";
import { changeDramaSetting, defaultShortDramaSettings, DramaMarket, DramaSource, dramaOptionsForSettings, dramaSettingLabels, dramaSettingOptions, dramaSettingSections, resolvedDramaTargetMarket, validateShortDramaSettings, type ShortDramaGlobalSettings } from "@/lib/short-drama-settings";
import "./canvas-global-settings-dialog.css";

type Props = {
    title: string;
    settings?: ShortDramaGlobalSettings;
    editing?: boolean;
    onClose: () => void;
    onSave: (title: string, settings: ShortDramaGlobalSettings, sourceContent?: string) => Promise<void>;
};
const extraFields = ["ending", "contentRating"] as const;

export function CanvasGlobalSettingsDialog({ title: initialTitle, settings, editing, onClose, onSave }: Props) {
    const [title, setTitle] = useState(initialTitle);
    const [draft, setDraft] = useState(() => {
        const initial = settings || defaultShortDramaSettings();
        return { ...initial, targetMarket: resolvedDramaTargetMarket(initial) };
    });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [sourceContent, setSourceContent] = useState("");
    const fileInput = useRef<HTMLInputElement>(null);
    const saving = useRef(false);
    const initialRevision = useRef(settings?.revision || 0);
    const field = (key: keyof typeof dramaSettingOptions | "episodeCount") => key === "episodeCount"
        ? <div className="canvas-global-setting-field" key={key}><label htmlFor="drama-episodeCount">总集数</label><InputNumber id="drama-episodeCount" aria-label="总集数" min={1} max={200} precision={0} value={draft.episodeCount} disabled={busy} onChange={(value) => setDraft((current) => ({ ...current, episodeCount: value ?? 0 }))} /></div>
        : <div className="canvas-global-setting-field" key={key}>
        <label htmlFor={`drama-${key}`}>{dramaSettingLabels[key]}</label>
        <Select<string> id={`drama-${key}`} ariaLabel={dramaSettingLabels[key]} appearance="field" value={draft[key]} options={dramaOptionsForSettings(draft, key)} optionFilterProp="label" showSearch
            classNames={{ popup: { root: "canvas-global-settings-select-popup" } }}
            onChange={(value) => setDraft((current) => {
                const changed = changeDramaSetting(current, key, value);
                return { ...changed, targetMarket: resolvedDramaTargetMarket(changed) };
            })} disabled={busy || (key === "targetMarket" && draft.market === DramaMarket.Domestic)} />
    </div>;
    const submit = async () => {
        if (saving.current) return;
        setError("");
        try {
            if (!title.trim()) throw new Error("请填写作品名称");
            if (!editing && draft.source !== DramaSource.Original && !sourceContent.trim()) throw new Error("请导入或粘贴已有故事/剧本");
            const next = validateShortDramaSettings({ ...draft, revision: editing ? initialRevision.current + 1 : 1 });
            saving.current = true; setBusy(true);
            await onSave(title.trim(), next, sourceContent);
        } catch (failure) { setError(failure instanceof Error ? failure.message : "保存失败，请重试"); }
        finally { saving.current = false; setBusy(false); }
    };
    return <AppModal open centered flush footer={null} closable={false} mask={{ closable: false }} width={760} onCancel={() => { if (!saving.current) onClose(); }} className="canvas-global-settings-modal">
        <form className="canvas-global-settings" aria-label={editing ? "全局创作设定" : "新建短剧画布"} data-canvas-no-zoom data-canvas-wheel-scroll
            onSubmit={(event) => { event.preventDefault(); void submit(); }} onKeyDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
            <header><h2>{editing ? "全局创作设定" : "新建短剧画布"}</h2><Button type="text" icon={<X size={18} />} title="关闭" aria-label="关闭全局设定" disabled={busy} onClick={onClose} /></header>
            <div className="canvas-global-settings-body">
                {error ? <Alert type="error" showIcon title={error} /> : null}
                <div className="canvas-global-setting-field"><label htmlFor="drama-title">作品名称</label><Input id="drama-title" aria-label="作品名称" value={title} maxLength={100} disabled={busy} onChange={(event) => setTitle(event.target.value)} /></div>
                {dramaSettingSections.map((section, index) => <section className="canvas-global-settings-section" key={section.id} aria-labelledby={`drama-section-${section.id}`}>
                    <h3 id={`drama-section-${section.id}`}><span>{String(index + 1).padStart(2, "0")}</span>{section.title}</h3>
                    <div className="canvas-global-settings-grid">
                    {section.fields.map(field)}
                    {section.id === "story" && !editing && draft.source !== DramaSource.Original ? <div className="canvas-global-setting-field canvas-global-setting-wide">
                        <label htmlFor="drama-source-content">已有故事 / 剧本</label>
                        <Button icon={<FileUp size={15} />} disabled={busy} onClick={() => fileInput.current?.click()}>导入 TXT / Markdown</Button>
                        <input ref={fileInput} type="file" accept=".txt,.md,text/plain,text/markdown" hidden onChange={async (event) => {
                            const file = event.target.files?.[0]; event.target.value = "";
                            if (!file) return;
                            try { if (file.size > 512 * 1024) throw new Error("请导入不超过 512 KB 的文本文件"); setSourceContent(await file.text()); setError(""); }
                            catch (failure) { setError(failure instanceof Error ? failure.message : "文件读取失败"); }
                        }} />
                        <Input.TextArea id="drama-source-content" aria-label="已有故事或剧本" disabled={busy} value={sourceContent} autoSize={{ minRows: 3 }} maxLength={300000} onChange={(event) => setSourceContent(event.target.value)} />
                    </div> : null}
                    </div>
                </section>)}
                <details className="canvas-global-settings-extra"><summary><ChevronDown size={15} />更多设置</summary><div className="canvas-global-settings-grid">
                    {extraFields.map(field)}
                    <div className="canvas-global-setting-field canvas-global-setting-wide"><label htmlFor="drama-premise">补充设定（可选）</label><Input.TextArea id="drama-premise" aria-label="补充设定" value={draft.premise} maxLength={2000} rows={3} disabled={busy} onChange={(event) => setDraft((current) => ({ ...current, premise: event.target.value }))} /></div>
                </div></details>
            </div>
            <footer><Button disabled={busy} onClick={onClose}>取消</Button><Button type="primary" htmlType="submit" icon={<Save size={16} />} loading={busy}>{editing ? "保存设定" : "创建并进入"}</Button></footer>
        </form>
    </AppModal>;
}
