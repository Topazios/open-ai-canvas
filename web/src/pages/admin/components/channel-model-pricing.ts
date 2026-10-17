import type { ChannelModel, ChannelModelPriceTier, ChannelModelRepriceInput, ModelDefaultPricing } from "@/services/api/wallet";

export enum ModelRepriceMode {
    Multiplier = "multiplier",
    Margin = "margin",
}

const validPrice = (value: number | undefined): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function hasValidTierPrice(tier: ChannelModelPriceTier, capability: ChannelModel["capability"]) {
    if (tier.billingMode === "fixed_request" || tier.billingMode === "per_second") return validPrice(tier.unitPriceMicrocredits);
    if (tier.billingMode !== "token" || (capability !== "text" && capability !== "video")) return false;
    if (capability === "video" && (tier.inputTokenPriceMicrocredits !== 0 || tier.cachedTokenPriceMicrocredits !== 0)) return false;
    return [tier.inputTokenPriceMicrocredits, tier.outputTokenPriceMicrocredits, tier.cachedTokenPriceMicrocredits].every((value) => validPrice(value) && value <= 1_000_000_000_000);
}

export function formatModelPrice(value: number | undefined) {
    return validPrice(value) ? (value / 1_000_000).toLocaleString("zh-CN", { maximumFractionDigits: 6 }) : "—";
}

export function formatModelMargin(cost: number | undefined, sale: number | undefined) {
    if (!validPrice(cost) || !validPrice(sale) || sale === 0) return "—";
    return `${(((sale - cost) * 100) / sale).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}%`;
}

export function modelPriceFields(tier: ChannelModelPriceTier, capability: ChannelModel["capability"]) {
    if (tier.billingMode !== "token") return [{ key: "unitPriceMicrocredits" as const, label: "", unit: tier.billingMode === "per_second" ? "秒" : "次" }];
    if (capability === "video") return [{ key: "outputTokenPriceMicrocredits" as const, label: "视频", unit: "百万视频 Token" }];
    return [
        { key: "inputTokenPriceMicrocredits" as const, label: "输入", unit: "百万 Token" },
        { key: "outputTokenPriceMicrocredits" as const, label: "输出", unit: "百万 Token" },
        { key: "cachedTokenPriceMicrocredits" as const, label: "缓存", unit: "百万 Token" },
    ];
}

export function previewModelRepricing(items: ChannelModel[], marginPercent: number | null, decimalPlaces = 2): ChannelModel[] {
    if (marginPercent === null || !Number.isFinite(marginPercent) || marginPercent < 0 || marginPercent > 99.99 || Math.abs(marginPercent * 100 - Math.round(marginPercent * 100)) > 1e-8) {
        throw new Error("请输入 0% 到 99.99% 的目标利润率，最多两位小数");
    }
    if (!items.length || items.length > 100) throw new Error("请选择 1 到 100 个模型");
    if (!Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 6) throw new Error("请选择保留 0 到 6 位小数");
    const denominator = BigInt(10_000 - Math.round(marginPercent * 100));
    const quantum = BigInt(10 ** (6 - decimalPlaces));
    return items.map((item) => {
        if (!item.priceTiers.length) throw new Error(`${item.displayName || item.modelKey} 没有价格规格`);
        return {
            ...item,
            priceTiers: item.priceTiers.map((tier) => {
                const name = `${item.displayName || item.modelKey}（${tier.selectorKey}）`;
                if (!tier.id || !hasValidTierPrice(tier, item.capability) || !tier.costPricing?.configured) throw new Error(`${name}：请先保存完整的规格成本价和销售价配置`);
                const next = { ...tier };
                for (const { key } of modelPriceFields(tier, item.capability)) {
                    const cost = tier.costPricing[key];
                    if (!validPrice(cost) || cost > 1_000_000_000_000) throw new Error(`${name}：成本价无效`);
                    // Round once at the selected credit precision, with exact half-up ties.
                    const numerator = BigInt(cost) * BigInt(10_000);
                    const divisor = denominator * quantum;
                    const sale = Number(((numerator * BigInt(2) + divisor) / (divisor * BigInt(2))) * quantum);
                    if (!validPrice(sale) || (tier.billingMode === "token" && sale > 1_000_000_000_000)) throw new Error(`${name}：调整后售价超过上限`);
                    next[key] = sale;
                }
                return next;
            }),
        };
    });
}

export function saleInputValue(microcredits: number) {
    if (!validPrice(microcredits)) return null;
    const value = BigInt(microcredits);
    return `${value / BigInt(1_000_000)}.${String(value % BigInt(1_000_000)).padStart(6, "0")}`.replace(/\.?0+$/, "");
}

export function parseSaleInput(value: string | null) {
    if (value === null || !/^\d+(?:\.\d{0,6})?$/.test(value)) throw new Error("销售价须为非负数，最多保留 6 位小数");
    const [integer, fraction = ""] = value.split(".");
    const amount = Number(BigInt(integer) * BigInt(1_000_000) + BigInt(fraction.padEnd(6, "0")));
    if (!validPrice(amount)) throw new Error("销售价超出有效范围");
    return amount;
}

export type ModelRepriceRow = {
    key: string;
    model: ChannelModel;
    tier: ChannelModelPriceTier;
    field: ReturnType<typeof modelPriceFields>[number];
    sale: string | null;
    manual: boolean;
};

export function modelRepriceRows(items: ChannelModel[]): ModelRepriceRow[] {
    return items.flatMap((model) =>
        model.priceTiers.flatMap((tier) =>
            modelPriceFields(tier, model.capability).map((field) => ({
                key: `${tier.id}:${field.key}`,
                model,
                tier,
                field,
                sale: hasValidTierPrice(tier, model.capability) ? saleInputValue(tier[field.key]) : null,
                manual: false,
            })),
        ),
    );
}

export function modelRepricePayload(items: ChannelModel[], rows: ModelRepriceRow[]): ChannelModelRepriceInput[] {
    if (!items.length || items.length > 100) throw new Error("请选择 1 到 100 个模型");
    const byKey = new Map(rows.map((row) => [row.key, row]));
    return items.map((item) => {
        const tiers = item.priceTiers;
        if (!tiers.length) throw new Error(`${item.displayName || item.modelKey} 没有价格规格`);
        return {
            modelId: item.id,
            priceVersion: item.priceVersion,
            priceTiers: tiers.map((tier) => {
                if (!tier.id) throw new Error(`${item.displayName || item.modelKey}：请先保存价格规格`);
                const prices: ChannelModelRepriceInput["priceTiers"][number]["prices"] = {};
                for (const { key } of modelPriceFields(tier, item.capability)) {
                    const sale = parseSaleInput(byKey.get(`${tier.id}:${key}`)?.sale ?? null);
                    if (tier.billingMode === "token" && sale > 1_000_000_000_000) throw new Error("Token 售价不能超过 1,000,000 积分");
                    prices[key] = sale;
                }
                return { id: tier.id, priceVersion: tier.priceVersion, prices };
            }),
        };
    });
}

function decimalFraction(value: number): [bigint, bigint] {
    const [mantissa, exponent = "0"] = String(value).toLowerCase().split("e");
    const [integer, fraction = ""] = mantissa!.split(".");
    const scale = fraction.length - Number(exponent);
    const digits = BigInt(`${integer}${fraction}`);
    return scale >= 0 ? [digits, BigInt(10) ** BigInt(scale)] : [digits * BigInt(10) ** BigInt(-scale), BigInt(1)];
}

function roundedPrice(value: number, factors: number[], decimalPlaces: number) {
    let [numerator, denominator] = decimalFraction(value);
    for (const factor of factors) {
        const [n, d] = decimalFraction(factor);
        numerator *= n;
        denominator *= d;
    }
    const quantum = BigInt(10) ** BigInt(6 - decimalPlaces);
    const divisor = denominator * quantum;
    const result = Number(((numerator * BigInt(2) + divisor) / (divisor * BigInt(2))) * quantum);
    if (!validPrice(result)) throw new Error("计算后售价超出有效范围");
    return result;
}

// Always recalculate from the original snapshot, never from the previous preview.
export function previewModelMultiplier(items: ChannelModel[], multiplier: number | null, decimalPlaces: number, defaults?: ModelDefaultPricing, creditsPerUSD = 1): ChannelModel[] {
    if (multiplier === null || !Number.isFinite(multiplier) || multiplier < 0.0001 || multiplier > 100 || Math.abs(multiplier * 10_000 - Math.round(multiplier * 10_000)) > 1e-7) throw new Error("倍率须为 0.0001–100，最多 4 位小数");
    if (!Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 6) throw new Error("请选择保留 0 到 6 位小数");
    if (!items.length || items.length > 100) throw new Error("请选择 1 到 100 个模型");
    if (defaults && (defaults.currency !== "USD" || !Number.isFinite(creditsPerUSD) || creditsPerUSD <= 0 || creditsPerUSD > 1_000_000)) throw new Error("请填写有效的美元兑积分比例");
    const prices = new Map(defaults?.prices.map((price) => [`${price.modelId}:${price.tierId}`, price]));
    return items.map((item) => ({
        ...item,
        priceTiers: item.priceTiers.map((tier) => {
            const reference = prices.get(`${item.id}:${tier.id}`);
            if (defaults && !reference?.supported) return tier;
            const next = { ...tier };
            if (reference) {
                if (reference.billingMode !== "fixed_request" && reference.billingMode !== "token" && reference.billingMode !== "per_second") throw new Error("官方价格计费单位缺失");
                next.billingMode = reference.billingMode;
                next.unitPriceMicrocredits = next.inputTokenPriceMicrocredits = next.outputTokenPriceMicrocredits = next.cachedTokenPriceMicrocredits = 0;
            }
            for (const { key } of modelPriceFields(next, item.capability)) {
                const value = reference ? reference[key.replace("Microcredits", "") as "unitPrice" | "inputTokenPrice" | "outputTokenPrice" | "cachedTokenPrice"] : tier[key];
                if (!Number.isFinite(value) || value < 0 || (!reference && !validPrice(value))) throw new Error(`${item.displayName || item.modelKey}：基准价格无效`);
                next[key] = roundedPrice(value, reference ? [1_000_000, creditsPerUSD, multiplier] : [multiplier], decimalPlaces);
            }
            if (!hasValidTierPrice(next, item.capability)) throw new Error(`${item.displayName || item.modelKey}：计算后的计费价格无效或超过上限`);
            return next;
        }),
    }));
}

export function modelRepriceChanges(original: ChannelModel[], rows: ModelRepriceRow[]) {
    const originalRows = new Map(modelRepriceRows(original).map((row) => [row.key, row]));
    const modes = new Map(original.flatMap((item) => item.priceTiers.map((tier) => [tier.id, tier.billingMode] as const)));
    return rows.filter((row) => {
        if (modes.get(row.tier.id) !== row.tier.billingMode) return true;
        try {
            const sale = parseSaleInput(row.sale);
            const old = originalRows.get(row.key)?.sale;
            return old == null || sale !== parseSaleInput(old);
        } catch {
            return row.sale !== originalRows.get(row.key)?.sale;
        }
    }).length;
}

export function modelRepricePayloadWithModes(original: ChannelModel[], preview: ChannelModel[], rows: ModelRepriceRow[]) {
    const modes = new Map(original.flatMap((item) => item.priceTiers.map((tier) => [tier.id, tier.billingMode] as const)));
    const changed = preview.filter(
        (item) =>
            modelRepriceChanges(
                original.filter((old) => old.id === item.id),
                rows.filter((row) => row.model.id === item.id),
            ) > 0,
    );
    if (!changed.length) return [];
    return modelRepricePayload(changed, rows).map((item) => ({
        ...item,
        priceTiers: item.priceTiers.map((tier) => {
            const mode = rows.find((row) => row.tier.id === tier.id)?.tier.billingMode;
            return mode && modes.get(tier.id) !== mode ? { ...tier, billingMode: mode } : tier;
        }),
    }));
}
