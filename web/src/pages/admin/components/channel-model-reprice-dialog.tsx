import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, InputNumber, Segmented, Table } from "antd";
import { Download, RotateCcw } from "lucide-react";
import { AdminModal } from "@/pages/admin/ui/overlays";
import { previewAdminDefaultPricing, repriceAdminChannelModels, type ChannelModel, type ModelDefaultPricing } from "@/services/api/wallet";
import { specificationLabel } from "./channel-model-cost-summary";
import { formatModelMargin, formatModelPrice, modelRepriceChanges, modelRepricePayloadWithModes, modelRepriceRows, parseSaleInput, previewModelRepricing, previewModelMultiplier, ModelRepriceMode, type ModelRepriceRow } from "./channel-model-pricing";
import { Select } from "@/components/ui/base/select";

export function ChannelModelRepriceDialog({ channelId, channelName, items, onClose, onSaved }: { channelId: string; channelName: string; items: ChannelModel[]; onClose: () => void; onSaved: () => Promise<void> }) {
    const { message } = App.useApp();
    const [margin, setMargin] = useState<number | null>(null);
    const [mode, setMode] = useState(ModelRepriceMode.Multiplier);
    const [multiplier, setMultiplier] = useState<number | null>(1);
    const [creditsPerUSD, setCreditsPerUSD] = useState<number | null>(1);
    const [defaults, setDefaults] = useState<ModelDefaultPricing>();
    const [mappings, setMappings] = useState<Record<string, string>>({});
    const [useDefaults, setUseDefaults] = useState(false);
    const [loading, setLoading] = useState(false);
    const request = useRef<AbortController | null>(null);
    useEffect(() => () => request.current?.abort(), []);
    const [decimalPlaces, setDecimalPlaces] = useState(6);
    const [preview, setPreview] = useState(items);
    const [rows, setRows] = useState(() => modelRepriceRows(items));
    const [calculationError, setCalculationError] = useState("");
    const [saving, setSaving] = useState(false);
    let validationError = "";
    try {
        modelRepricePayloadWithModes(items, preview, rows);
    } catch (cause) {
        validationError = cause instanceof Error ? cause.message : "销售价无效";
    }
    const changed = modelRepriceChanges(items, rows);
    const busy = saving || loading;
    const recalculate = (next = { mode, margin, multiplier, decimalPlaces, creditsPerUSD, useDefaults, defaults }) => {
        try {
            if (next.mode === ModelRepriceMode.Multiplier && next.useDefaults && !next.defaults) throw new Error("请先读取官方定价");
            const result =
                next.mode === ModelRepriceMode.Margin
                    ? previewModelRepricing(items, next.margin, next.decimalPlaces)
                    : previewModelMultiplier(items, next.multiplier, next.decimalPlaces, next.useDefaults ? next.defaults : undefined, next.creditsPerUSD ?? 0);
            setPreview(result);
            setRows(modelRepriceRows(result));
            setCalculationError("");
        } catch (cause) {
            setCalculationError(cause instanceof Error ? cause.message : "无法计算销售价");
        }
    };
    const settings = { mode, margin, multiplier, decimalPlaces, creditsPerUSD, useDefaults, defaults };
    const fetchDefaults = async (nextMappings = mappings) => {
        if (busy) return;
        const controller = new AbortController();
        request.current = controller;
        setLoading(true);
        try {
            const result = await previewAdminDefaultPricing(
                channelId,
                items.map((item) => item.id),
                controller.signal,
                nextMappings,
            );
            if (controller.signal.aborted) return;
            setDefaults(result);
            setMappings(nextMappings);
            setUseDefaults(true);
            setMode(ModelRepriceMode.Multiplier);
            recalculate({ ...settings, mode: ModelRepriceMode.Multiplier, useDefaults: true, defaults: result });
        } catch (cause) {
            if (!controller.signal.aborted) message.error(cause instanceof Error ? cause.message : "拉取默认定价失败，价格未修改");
        } finally {
            if (!controller.signal.aborted) setLoading(false);
        }
    };
    const save = async () => {
        if (validationError || calculationError || !changed || busy) return;
        setSaving(true);
        try {
            const result = await repriceAdminChannelModels(channelId, modelRepricePayloadWithModes(items, preview, rows));
            message.success(`已保存 ${result.updated} 个模型的销售价`);
        } catch (cause) {
            message.error(cause instanceof Error ? cause.message : "统一调价失败");
            setSaving(false);
            return;
        }
        try {
            await onSaved();
        } catch {
            message.warning("价格已保存，但列表刷新失败，请手动刷新");
        } finally {
            setSaving(false);
            onClose();
        }
    };
    return (
        <AdminModal
            title={`统一调价 · ${items.length} 个模型`}
            open
            centered
            width={1180}
            rootClassName="admin-model-reprice-modal"
            onCancel={onClose}
            closable={!saving}
            mask={{ closable: !saving }}
            keyboard={!saving}
            confirmLoading={saving}
            cancelButtonProps={{ disabled: saving }}
            okButtonProps={{ disabled: busy || Boolean(validationError || calculationError) || !changed }}
            okText={`保存销售价${changed ? `（${changed} 项）` : ""}`}
            onOk={() => void save()}
        >
            <div className="admin-model-reprice">
                <div className="admin-model-reprice-controls">
                    <Segmented
                        aria-label="调价方式"
                        value={mode}
                        disabled={busy}
                        options={[
                            { label: "统一倍率", value: ModelRepriceMode.Multiplier },
                            { label: "目标利润率", value: ModelRepriceMode.Margin },
                        ]}
                        onChange={(value) => {
                            setMode(value);
                            recalculate({ ...settings, mode: value });
                        }}
                    />
                    {mode === ModelRepriceMode.Multiplier ? (
                        <>
                            <div className="admin-model-reprice-field">
                                <label htmlFor="reprice-source">基准价格</label>
                                <Select
                                    id="reprice-source"
                                    aria-label="基准价格"
                                    value={useDefaults ? "upstream" : "current"}
                                    disabled={busy}
                                    options={[
                                        { value: "current", label: "当前销售价" },
                                        { value: "upstream", label: "官方公开价", disabled: !defaults },
                                    ]}
                                    onChange={(value) => {
                                        setUseDefaults(value === "upstream");
                                        recalculate({ ...settings, useDefaults: value === "upstream" });
                                    }}
                                />
                            </div>
                            <Button icon={<Download size={16} />} loading={loading} disabled={busy} onClick={() => void fetchDefaults()}>
                                读取官方定价
                            </Button>
                            <div className="admin-model-reprice-field">
                                <label htmlFor="reprice-multiplier">统一倍率</label>
                                <InputNumber
                                    id="reprice-multiplier"
                                    aria-label="统一倍率"
                                    value={multiplier}
                                    min={0.0001}
                                    max={100}
                                    step={0.1}
                                    suffix="倍"
                                    disabled={busy}
                                    onChange={(value) => {
                                        setMultiplier(value);
                                        recalculate({ ...settings, multiplier: value });
                                    }}
                                />
                            </div>
                            {useDefaults && (
                                <div className="admin-model-reprice-field">
                                    <label htmlFor="reprice-conversion">1 USD 折合积分</label>
                                    <InputNumber
                                        id="reprice-conversion"
                                        aria-label="1 USD 折合积分"
                                        value={creditsPerUSD}
                                        min={0.000001}
                                        max={1_000_000}
                                        disabled={busy}
                                        onChange={(value) => {
                                            setCreditsPerUSD(value);
                                            recalculate({ ...settings, creditsPerUSD: value });
                                        }}
                                    />
                                </div>
                            )}
                        </>
                    ) : (
                        <div className="admin-model-reprice-field">
                            <label htmlFor="reprice-margin">目标利润率</label>
                            <InputNumber
                                id="reprice-margin"
                                aria-label="目标利润率"
                                value={margin}
                                onChange={(value) => {
                                    setMargin(value);
                                    recalculate({ ...settings, margin: value });
                                }}
                                min={0}
                                max={99.99}
                                step={1}
                                suffix="%"
                                placeholder="输入百分比"
                                disabled={busy}
                            />
                        </div>
                    )}
                    <div className="admin-model-reprice-field">
                        <label htmlFor="reprice-decimals">保留小数位</label>
                        <Select
                            id="reprice-decimals"
                            aria-label="保留小数位"
                            value={decimalPlaces}
                            disabled={busy}
                            onChange={(value) => {
                                setDecimalPlaces(value);
                                recalculate({ ...settings, decimalPlaces: value });
                            }}
                            options={Array.from({ length: 7 }, (_, value) => ({ value, label: `${value} 位小数` }))}
                        />
                    </div>
                    <Button icon={<RotateCcw size={16} />} disabled={busy} onClick={() => recalculate()}>
                        重新计算
                    </Button>
                    <div className="admin-model-reprice-formula">
                        <span>{mode === ModelRepriceMode.Margin ? "新售价 = 成本价 ÷（1 − 利润率）" : useDefaults ? "新售价 = 官方参考价 × 积分换算 × 统一倍率" : "新售价 = 当前销售价 × 统一倍率"}</span>
                    </div>
                </div>
                {useDefaults && mode === ModelRepriceMode.Multiplier && defaults && (
                    <p className="admin-model-reprice-note">
                        {defaults.source} · 核验于 {defaults.verifiedAt} · 匹配 {defaults.prices.filter((price) => price.supported).length}/{defaults.prices.length} 个规格；未匹配项保留原价。长上下文请选择对应档位。
                    </p>
                )}
                <p className="admin-model-reprice-note">修改调价参数会重新计算并覆盖手动编辑；保存前可逐项修改。此倍率只用于本次定价，结算仍按现有全局计费策略执行。</p>
                <div className="admin-model-reprice-list-heading">
                    <strong>模型价格</strong>
                    <span>
                        {rows.length} 个计费项 · 已修改 {changed} 项
                    </span>
                </div>
                <ChannelModelRepriceTable
                    items={preview}
                    defaults={mode === ModelRepriceMode.Multiplier && useDefaults ? defaults : undefined}
                    onProfileChange={(tierId, profileId) => void fetchDefaults({ ...mappings, [tierId]: profileId })}
                    rows={rows}
                    channelName={channelName}
                    decimalPlaces={decimalPlaces}
                    disabled={busy}
                    onSaleChange={(key, value) => setRows((current) => current.map((entry) => (entry.key === key ? { ...entry, sale: value, manual: true } : entry)))}
                />
                {calculationError || validationError ? <Alert type="warning" showIcon title={calculationError || validationError} /> : null}
                <p className="admin-model-reprice-note">官方价为核验后的目录快照，不是实时价格接口。适用条件见各项来源，不代表渠道实际成本；保存不修改成本和模型启停状态。</p>
            </div>
        </AdminModal>
    );
}

export function ChannelModelRepriceTable({
    items,
    rows,
    channelName,
    decimalPlaces,
    disabled,
    onSaleChange,
    defaults,
    onProfileChange,
}: {
    items: ChannelModel[];
    rows: ModelRepriceRow[];
    channelName: string;
    decimalPlaces: number;
    disabled: boolean;
    onSaleChange: (key: string, value: string | null) => void;
    defaults?: ModelDefaultPricing;
    onProfileChange?: (tierId: string, profileId: string) => void;
}) {
    const byModel = new Map<string, ModelRepriceRow[]>();
    for (const row of rows) {
        const group = byModel.get(row.model.id) ?? [];
        group.push(row);
        byModel.set(row.model.id, group);
    }
    return (
        <Table<ChannelModel>
            className="admin-model-reprice-table"
            rowKey="id"
            dataSource={items}
            pagination={false}
            tableLayout="fixed"
            scroll={{ x: 1040 }}
            locale={{ emptyText: "暂无所选模型" }}
            columns={[
                {
                    title: "模型展示名",
                    width: 180,
                    render: (_, model) => (
                        <div className="admin-model-reprice-identity">
                            <strong>{model.displayName || model.modelKey}</strong>
                            {defaults &&
                                model.priceTiers.map((tier) => {
                                    const reference = defaults.prices.find((price) => price.modelId === model.id && price.tierId === tier.id);
                                    return (
                                        <div key={tier.id} className="admin-model-reprice-identity">
                                            <small>{model.priceTiers.length > 1 ? `${specificationLabel(tier)} · ` : ""}官方模型 / 档位</small>
                                            <Select
                                                aria-label={`${model.displayName || model.modelKey} ${specificationLabel(tier)} 官方模型/档位`}
                                                value={reference?.profileId ?? ""}
                                                disabled={disabled}
                                                showSearch
                                                optionFilterProp="label"
                                                onChange={(value) => onProfileChange?.(tier.id, value)}
                                                options={[{ value: "", label: "自动匹配" }, ...(defaults.profiles ?? []).filter((profile) => profile.capability === model.capability).map((profile) => ({ value: profile.id, label: profile.label }))]}
                                            />
                                            {reference?.sourceUrl && (
                                                <a href={reference.sourceUrl} target="_blank" rel="noreferrer">
                                                    官方来源
                                                </a>
                                            )}
                                            {reference?.note && <small>{reference.note}</small>}
                                        </div>
                                    );
                                })}
                        </div>
                    ),
                },
                {
                    title: "渠道展示名（上游模型ID）",
                    width: 220,
                    render: (_, model) => (
                        <div className="admin-model-reprice-identity">
                            <span>{model.channelLabel || channelName}</span>
                            <small className="admin-monospace">{model.providerModelKey || model.modelKey}</small>
                        </div>
                    ),
                },
                // One model per table row; the shared grid keeps each specification and its prices aligned even when labels wrap.
                {
                    title: "规格",
                    width: 140,
                    onCell: () => ({ colSpan: 3, className: "admin-model-reprice-spec-cell" }),
                    render: (_, model) => (
                        <div className="admin-model-reprice-specs">
                            {(byModel.get(model.id) ?? []).map((row) => {
                                let sale: number | undefined;
                                try {
                                    sale = parseSaleInput(row.sale);
                                } catch {
                                    /* Incomplete input remains visible and blocks saving. */
                                }
                                const cost = row.tier.costPricing?.configured ? row.tier.costPricing[row.field.key] : undefined;
                                const reference = defaults?.prices.find((price) => price.modelId === model.id && price.tierId === row.tier.id);
                                return (
                                    <div key={row.key} className="admin-model-reprice-spec-row">
                                        <div className="admin-model-reprice-identity">
                                            <span>{specificationLabel(row.tier)}</span>
                                            {row.field.label && <small>{row.field.label}</small>}
                                            {reference && (
                                                <small>
                                                    {reference.supported
                                                        ? `默认 ${reference[row.field.key.replace("Microcredits", "") as "unitPrice" | "inputTokenPrice" | "outputTokenPrice" | "cachedTokenPrice"]} USD / ${row.field.unit}`
                                                        : `保留原价：${reference.reason}`}
                                                </small>
                                            )}
                                            {row.tier.providerModelKey && row.tier.providerModelKey !== (model.providerModelKey || model.modelKey) && <small className="admin-monospace">上游：{row.tier.providerModelKey}</small>}
                                        </div>
                                        <div className="admin-model-reprice-identity">
                                            <span>{cost === undefined ? "未配置成本" : formatModelPrice(cost)}</span>
                                            <small>积分 / {row.field.unit}</small>
                                        </div>
                                        <div className="admin-model-reprice-sale">
                                            <InputNumber<string>
                                                stringMode
                                                aria-label={`${model.displayName || model.modelKey} ${specificationLabel(row.tier)} ${row.field.label} 销售价`}
                                                size="middle"
                                                value={row.sale}
                                                min="0"
                                                step={String(10 ** -decimalPlaces)}
                                                disabled={disabled}
                                                status={sale === undefined ? "error" : undefined}
                                                onChange={(value) => onSaleChange(row.key, value)}
                                            />
                                            <small>
                                                {row.manual ? "手动修改 · " : ""}利润率 {formatModelMargin(cost, sale)}
                                            </small>
                                        </div>
                                    </div>
                                );
                            })}
                            {!byModel.get(model.id)?.length && <div className="admin-model-reprice-no-spec">暂无价格规格</div>}
                        </div>
                    ),
                },
                { title: "成本价", width: 160, onCell: () => ({ colSpan: 0 }) },
                { title: "销售价（积分）", width: 340, onCell: () => ({ colSpan: 0 }) },
            ]}
        />
    );
}
