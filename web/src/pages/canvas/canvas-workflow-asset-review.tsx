import { useState } from "react";
import { Button, Input, InputNumber, Select, Switch } from "antd";
import { Check, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { AppModal } from "@/components/ui/product/app-modal";
import { assetContentSignature, assetMediaSignature, assetReferenceState, isAssetReference } from "@/lib/canvas/canvas-workflow-asset-profile";
import { nodeWorkflow, productionBibleReady, workflowSignature } from "@/lib/canvas/canvas-short-drama-workflow";
import type { WorkflowAssetProfile } from "@/lib/short-drama-steps";
import type { CanvasNodeData } from "@/types/canvas";
import { AssetStateSource, assetStateSourceOptions, assetStateTextFields, assetStateFieldLabels, validateAssetVariant } from "@/lib/production-continuity";
import { productionSoundKindOptions } from "@/lib/production-sound";

export function CanvasWorkflowAssetReview({ node, nodes, onClose, onEdit, onSave }: {
    node: CanvasNodeData; nodes: CanvasNodeData[]; onClose: () => void; onEdit: (node: CanvasNodeData) => void;
    onSave: (id: string, profile: WorkflowAssetProfile, expected: string) => void | Promise<void>;
}) {
    const data = nodeWorkflow(node)!;
    const bible = data.assetGroup?.kind === "bible";
    const [expected] = useState(() => workflowSignature(node));
    const [profile, setProfile] = useState<WorkflowAssetProfile>(() => data.assetProfile || { aliases: [], occurrences: [], variants: [], sounds: [], conflicts: [], indexContent: "", references: [] });
    const [error, setError] = useState("");
    const [saving, setSaving] = useState(false);
    const update = (patch: Partial<WorkflowAssetProfile>) => setProfile((current) => ({ ...current, ...patch }));
    const media = nodes.filter(isAssetReference);
    const save = async () => {
        if (saving) return;
        setSaving(true); setError("");
        try {
            if (bible) onClose();
            else {
                if (profile.occurrences.some((entry) => !Number.isInteger(entry.episode) || entry.episode < 1 || entry.episode > (data.parameters?.episodeCount || 200) || !entry.evidence.trim())) throw new Error("出场记录需填写有效集号和正文依据");
                profile.variants.forEach(validateAssetVariant);
                await onSave(node.id, { ...profile, indexContent: assetContentSignature(node.metadata?.content || "") }, expected);
            }
            onClose();
        } catch (failure) { setError(failure instanceof Error ? failure.message : "保存失败"); }
        finally { setSaving(false); }
    };
    return <AppModal open title={null} footer={null} closable={false} centered width="min(820px, calc(100vw - 24px))" flush onCancel={onClose}>
        <section className="flex max-h-[85dvh] flex-col p-4" data-canvas-no-zoom data-canvas-wheel-scroll aria-label={bible ? "统一制作规范" : "资产资料与参考"} onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
            <header className="mb-3 flex items-center justify-between gap-2"><strong className="min-w-0 break-words text-sm">{node.title}</strong><Button type="text" aria-label="关闭资产资料" icon={<X size={16} />} onClick={onClose} /></header>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
                {bible ? <>
                    <div role="status">{productionBibleReady(node, nodes) ? "已生成" : "生成中或待补齐"}</div>
                    {data.sourceNodeIds.map((id) => nodes.find((entry) => entry.id === id)).filter((entry): entry is CanvasNodeData => Boolean(entry && ["assets.settings", "assets.style"].includes(nodeWorkflow(entry)?.step || ""))).map((entry) => <section key={entry.id} className="border-t pt-3">
                        <div className="flex items-center justify-between"><strong className="text-sm">{entry.title}</strong><Button icon={<Pencil size={14} />} aria-label={`编辑${entry.title}`} onClick={() => { onClose(); onEdit(entry); }}>编辑</Button></div>
                        <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-xs leading-6">{entry.metadata?.content || "等待生成"}</pre>
                    </section>)}
                </> : <>
                    <div className="flex flex-wrap justify-between gap-2 text-xs" role="status"><span>{assetReferenceState(profile, nodes)}</span><span>{profile.indexContent === assetContentSignature(node.metadata?.content || "") ? "资料与正文一致" : "正文或资料待核对"}</span><Button icon={<Pencil size={14} />} onClick={() => { onClose(); onEdit(node); }}>编辑资产正文</Button></div>
                    <label className="block text-xs">别名<Select className="mt-1 w-full" mode="tags" value={profile.aliases} onChange={(aliases) => update({ aliases })} aria-label="资产别名" /></label>
                    {data.assetIdentity?.kind === "sound" ? <label className="block text-xs">声音类别<Select className="mt-1 w-full" aria-label="声音类别" value={profile.soundKind} options={productionSoundKindOptions} onChange={soundKind => update({ soundKind })} /></label> : null}
                    <section className="space-y-2 border-t pt-3"><div className="flex items-center justify-between"><strong className="text-sm">出场与连续性</strong><Button icon={<Plus size={14} />} onClick={() => update({ occurrences: [...profile.occurrences, { episode: 1, scene: "", state: "", owner: "", location: "", evidence: "" }] })}>添加出场</Button></div>
                        {profile.occurrences.map((entry, index) => <div key={index} className="grid grid-cols-2 gap-2 border-b py-2 sm:grid-cols-3">
                            <label className="text-xs">集号<InputNumber className="w-full" aria-label={`出场${index + 1}集号`} min={1} max={data.parameters?.episodeCount || 200} precision={0} value={entry.episode} onChange={(episode) => update({ occurrences: profile.occurrences.map((value, i) => i === index ? { ...value, episode: episode || 1 } : value) })} /></label>
                            {([['scene', '场次'], ['state', '状态'], ['owner', '所属人物'], ['location', '所在空间'], ['evidence', '正文依据']] as const).map(([key, label]) => <label key={key} className="text-xs">{label}<Input aria-label={`出场${index + 1}${label}`} value={entry[key]} onChange={(event) => update({ occurrences: profile.occurrences.map((value, i) => i === index ? { ...value, [key]: event.target.value } : value) })} /></label>)}
                            <Button type="text" icon={<Trash2 size={14} />} aria-label={`删除出场${index + 1}`} onClick={() => update({ occurrences: profile.occurrences.filter((_, i) => i !== index) })} />
                        </div>)}
                    </section>
                    <section className="space-y-2"><strong className="text-sm">造型与状态转换</strong>{profile.variants.map((variant, index) => <div key={index} className="grid grid-cols-2 gap-2 border-b py-2">
                        <label className="text-xs">{variant.code || "状态名称"}<Input aria-label={`变体${index + 1}名称`} value={variant.name} onChange={event => update({ variants: profile.variants.map((value, i) => i === index ? { ...value, name: event.target.value } : value) })} /></label>
                        <label className="text-xs">来源<Select className="w-full" aria-label={`变体${index + 1}来源`} allowClear options={assetStateSourceOptions} value={variant.source} onChange={source => update({ variants: profile.variants.map((value, i) => i === index ? { ...value, source } : value) })} /></label>
                        <label className="col-span-2 text-xs">固定特征与变化<Input.TextArea aria-label={`变体${index + 1}描述`} value={variant.description} onChange={event => update({ variants: profile.variants.map((value, i) => i === index ? { ...value, description: event.target.value } : value) })} autoSize /></label>
                        {assetStateTextFields.map(key => <label key={key} className="text-xs">{assetStateFieldLabels[key]}<Input aria-label={`变体${index + 1}${assetStateFieldLabels[key]}`} value={variant[key] || ""} onChange={event => update({ variants: profile.variants.map((value, i) => i === index ? { ...value, [key]: event.target.value } : value) })} /></label>)}
                        <Button type="text" icon={<Trash2 size={14} />} aria-label={`删除变体${index + 1}`} onClick={() => update({ variants: profile.variants.filter((_, i) => i !== index) })} />
                    </div>)}<Button icon={<Plus size={14} />} onClick={() => update({ variants: [...profile.variants, { name: "", description: "", source: AssetStateSource.Design }] })}>添加变体</Button></section>
                    <label className="block text-xs">关联声音<Input.TextArea aria-label="关联声音" value={profile.sounds.join("\n")} onChange={(event) => update({ sounds: event.target.value.split("\n") })} autoSize={{ minRows: 2, maxRows: 6 }} /></label>
                    <label className="block text-xs">冲突与影响<Input.TextArea aria-label="冲突与影响" value={profile.conflicts.join("\n")} onChange={(event) => update({ conflicts: event.target.value.split("\n") })} autoSize={{ minRows: 2, maxRows: 6 }} /></label>
                    <section className="space-y-2 border-t pt-3"><strong className="text-sm">参考图与声音版本</strong>
                        <Select<string> className="w-full" aria-label="添加参考素材" placeholder="选择画布中的图片、视频或音频" value={undefined} options={media.filter((entry) => !profile.references.some((ref) => ref.nodeId === entry.id)).map((entry) => ({ value: entry.id, label: entry.title }))} onChange={(id) => update({ references: [...profile.references, { nodeId: id, signature: assetMediaSignature(media.find((entry) => entry.id === id)!), variant: "基准", selected: false }] })} />
                        {profile.references.map((ref, index) => { const resource = nodes.find((entry) => entry.id === ref.nodeId); return <div key={ref.nodeId} className="flex flex-wrap items-center gap-2 border-b py-2 text-xs"><span className="min-w-0 flex-1 break-words">{resource?.title || "参考已删除"}</span><Input className="!w-28" aria-label={`参考${index + 1}用途或变体`} value={ref.variant} onChange={(event) => update({ references: profile.references.map((value, i) => i === index ? { ...value, variant: event.target.value } : value) })} /><Switch checkedChildren="选定" unCheckedChildren="候选" aria-label={`选定参考${index + 1}`} checked={ref.selected} onChange={(selected) => update({ references: profile.references.map((value, i) => i === index ? { ...value, selected } : value) })} /><Button type="text" title="更新参考版本" aria-label={`更新参考${index + 1}版本`} disabled={!resource || !isAssetReference(resource)} icon={<RefreshCw size={14} />} onClick={() => update({ references: profile.references.map((value, i) => i === index ? { ...value, signature: assetMediaSignature(resource!) } : value) })} /><Button type="text" aria-label={`移除参考${index + 1}`} icon={<Trash2 size={14} />} onClick={() => update({ references: profile.references.filter((_, i) => i !== index) })} /></div>; })}
                    </section>
                </>}
            </div>
            {!bible ? <footer className="mt-3 space-y-2 border-t pt-3">{error ? <div role="alert" className="text-sm">{error}</div> : null}<Button type="primary" loading={saving} icon={<Check size={15} />} onClick={() => void save()}>保存资料</Button></footer> : null}
        </section>
    </AppModal>;
}
