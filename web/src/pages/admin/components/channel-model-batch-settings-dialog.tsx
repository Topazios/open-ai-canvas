import { useState } from "react";
import { Alert, App, Button, Checkbox, Input, Radio, Segmented } from "antd";
import { AdminModal } from "@/pages/admin/ui/overlays";
import { ModelIconPicker } from "@/components/model-logo";
import { ModelProtocolBrowser } from "@/components/model-protocol-browser";
import type { ModelProtocolDefinition, ProtocolCapability } from "@/lib/model-protocols";
import { updateAdminChannelModelsSettings, type ChannelModel } from "@/services/api/wallet";

type ApplyState = {
    enabled: boolean;
    displayName: boolean;
    channelLabel: boolean;
    description: boolean;
    icon: boolean;
    contract: boolean;
};

export function ChannelModelBatchSettingsDialog({
    channelId,
    items,
    protocols,
    protocolLoading,
    protocolError,
    onRetryProtocols,
    onClose,
    onSaved,
}: {
    channelId: string;
    items: ChannelModel[];
    protocols: ModelProtocolDefinition[];
    protocolLoading: boolean;
    protocolError: string;
    onRetryProtocols: () => void;
    onClose: () => void;
    onSaved: () => Promise<void>;
}) {
    const { message } = App.useApp();
    const [apply, setApply] = useState<ApplyState>({ enabled: false, displayName: false, channelLabel: false, description: false, icon: false, contract: false });
    const [enabled, setEnabled] = useState<"enabled" | "disabled">("enabled");
    const [displayName, setDisplayName] = useState("");
    const [channelLabel, setChannelLabel] = useState("");
    const [description, setDescription] = useState("");
    const [icon, setIcon] = useState("");
    const [capability, setCapability] = useState<ProtocolCapability>(getCommonCapability(items));
    const [protocol, setProtocol] = useState<string | undefined>(() => getInitialProtocol(items, protocols, getCommonCapability(items)));
    const [saving, setSaving] = useState(false);

    const selectedCount = Object.values(apply).filter(Boolean).length;
    const availableProtocols = protocols.filter((item) => item.capability === capability && item.enabled !== false);
    const selectedProtocol = availableProtocols.some((item) => item.value === protocol) ? protocol : availableProtocols[0]?.value;
    const save = async () => {
        if (!selectedCount || saving) return;
        if (apply.displayName && !displayName.trim()) {
            message.warning("请填写要批量设置的模型展示名");
            return;
        }
        if (apply.contract && (!selectedProtocol || protocolLoading || protocolError)) {
            message.warning(protocolError ? "协议目录读取失败，请重试后再保存" : "请选择当前能力下可用的调用协议");
            return;
        }
        setSaving(true);
        try {
            const result = await updateAdminChannelModelsSettings(channelId, {
                modelIds: items.map((item) => item.id),
                ...(apply.enabled ? { enabled: enabled === "enabled" } : {}),
                ...(apply.displayName ? { displayName: displayName.trim() } : {}),
                ...(apply.channelLabel ? { channelLabel: channelLabel.trim() } : {}),
                ...(apply.description ? { description: description.trim() } : {}),
                ...(apply.icon ? { icon: icon.trim() } : {}),
                ...(apply.contract ? { capability, protocol: selectedProtocol } : {}),
            });
            message.success(`已更新 ${result.updated} 个模型`);
            await onSaved();
            onClose();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "批量设置失败");
        } finally {
            setSaving(false);
        }
    };

    const toggle = (key: keyof ApplyState) => setApply((current) => ({ ...current, [key]: !current[key] }));

    return (
        <AdminModal
            open
            centered
            width={760}
            rootClassName="admin-modal-root admin-model-batch-settings-modal"
            title={`批量设置 · ${items.length} 个模型`}
            onCancel={saving ? undefined : onClose}
            closable={!saving}
            mask={{ closable: !saving }}
            keyboard={!saving}
            confirmLoading={saving}
            okButtonProps={{ disabled: !selectedCount }}
            okText={`保存设置${selectedCount ? `（${selectedCount} 项）` : ""}`}
            cancelText="取消"
            onOk={() => void save()}
        >
            <div className="space-y-4">
                <Alert type="info" showIcon title="只修改勾选的参数。能力或协议变更后，对应能力参数会恢复为当前模型的默认值，价格仍需单独核对。" />
                <div className="grid gap-3">
                    <BatchSettingRow checked={apply.enabled} onToggle={() => toggle("enabled")} label="模型状态">
                        <Radio.Group
                            value={enabled}
                            onChange={(event) => setEnabled(event.target.value)}
                            disabled={!apply.enabled}
                            options={[
                                { label: "启用", value: "enabled" },
                                { label: "停用", value: "disabled" },
                            ]}
                        />
                    </BatchSettingRow>
                    <BatchSettingRow checked={apply.contract} onToggle={() => toggle("contract")} label="能力与调用协议">
                        <div className="space-y-3">
                            <Segmented
                                block
                                value={capability}
                                disabled={!apply.contract}
                                options={[
                                    { label: "文本", value: "text" },
                                    { label: "图片", value: "image" },
                                    { label: "视频", value: "video" },
                                    { label: "音频", value: "audio" },
                                ]}
                                onChange={(value) => {
                                    const nextCapability = value as ProtocolCapability;
                                    setCapability(nextCapability);
                                    setProtocol(protocols.find((item) => item.capability === nextCapability && item.enabled !== false)?.value);
                                }}
                            />
                            <ModelProtocolBrowser value={selectedProtocol} onChange={setProtocol} capability={capability} protocols={protocols} loading={protocolLoading} error={protocolError} disabled={!apply.contract} />
                            {protocolError ? (
                                <Button size="small" onClick={onRetryProtocols}>
                                    重试读取协议目录
                                </Button>
                            ) : null}
                        </div>
                    </BatchSettingRow>
                    <BatchSettingRow checked={apply.displayName} onToggle={() => toggle("displayName")} label="模型展示名（一级目录）">
                        <Input value={displayName} disabled={!apply.displayName} maxLength={160} placeholder="例如：GPT-6" onChange={(event) => setDisplayName(event.target.value)} />
                    </BatchSettingRow>
                    <BatchSettingRow checked={apply.channelLabel} onToggle={() => toggle("channelLabel")} label="渠道展示名（二级目录）">
                        <Input value={channelLabel} disabled={!apply.channelLabel} maxLength={80} placeholder="留空表示清除渠道展示名" onChange={(event) => setChannelLabel(event.target.value)} />
                    </BatchSettingRow>
                    <BatchSettingRow checked={apply.description} onToggle={() => toggle("description")} label="模型描述">
                        <Input.TextArea value={description} disabled={!apply.description} maxLength={500} rows={3} placeholder="留空表示清除模型描述" onChange={(event) => setDescription(event.target.value)} />
                    </BatchSettingRow>
                    <BatchSettingRow checked={apply.icon} onToggle={() => toggle("icon")} label="模型 Logo">
                        <div className={!apply.icon ? "pointer-events-none opacity-50" : ""}>
                            <ModelIconPicker value={icon} onChange={setIcon} />
                        </div>
                    </BatchSettingRow>
                </div>
            </div>
        </AdminModal>
    );
}

function BatchSettingRow({ checked, onToggle, label, children }: { checked: boolean; onToggle: () => void; label: string; children: React.ReactNode }) {
    return (
        <div className="grid items-start gap-3 rounded-md border border-border/70 p-3 md:grid-cols-[190px_minmax(0,1fr)]">
            <Checkbox checked={checked} onChange={onToggle}>
                <span className="font-medium">{label}</span>
            </Checkbox>
            <div className="min-w-0">{children}</div>
        </div>
    );
}

function getCommonCapability(items: ChannelModel[]): ProtocolCapability {
    const capability = items[0]?.capability;
    return capability && items.every((item) => item.capability === capability) ? capability : "text";
}

function getInitialProtocol(items: ChannelModel[], protocols: ModelProtocolDefinition[], capability: ProtocolCapability) {
    const protocol = items[0]?.protocol;
    if (protocol && items.every((item) => item.protocol === protocol) && protocols.some((item) => item.value === protocol && item.capability === capability && item.enabled !== false)) {
        return protocol;
    }
    return protocols.find((item) => item.capability === capability && item.enabled !== false)?.value;
}
