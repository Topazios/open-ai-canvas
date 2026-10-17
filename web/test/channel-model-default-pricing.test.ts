import { expect, test } from "bun:test";
import { modelRepriceChanges, modelRepricePayloadWithModes, modelRepriceRows, previewModelMultiplier } from "../src/pages/admin/components/channel-model-pricing";
import type { ChannelModel, ModelDefaultPricing } from "../src/services/api/wallet";

const item = {
    id: "m",
    modelKey: "upstream",
    capability: "text",
    priceVersion: 4,
    priceTiers: [{ id: "t", priceVersion: 3, billingMode: "fixed_request", unitPriceMicrocredits: 1_005_000, inputTokenPriceMicrocredits: 0, outputTokenPriceMicrocredits: 0, cachedTokenPriceMicrocredits: 0 }],
} as ChannelModel;
const defaults: ModelDefaultPricing = {
    currency: "USD",
    source: "public",
    fetchedAt: "2026-10-17T00:00:00Z",
    prices: [{ modelId: "m", tierId: "t", upstreamModel: "upstream", supported: true, billingMode: "token", unitPrice: 0, inputTokenPrice: 5, outputTokenPrice: 40, cachedTokenPrice: 0.5 }],
};

test("multiplier works without costs and recomputes from original without compounding", () => {
    expect(previewModelMultiplier([item], 1, 2)[0]!.priceTiers[0]!.unitPriceMicrocredits).toBe(1_010_000);
    expect(previewModelMultiplier([item], 2, 6)[0]!.priceTiers[0]!.unitPriceMicrocredits).toBe(2_010_000);
    expect(previewModelMultiplier([item], 3, 6)[0]!.priceTiers[0]!.unitPriceMicrocredits).toBe(3_015_000);
    expect(item.priceTiers[0]!.unitPriceMicrocredits).toBe(1_005_000);
    const zero = { ...item, priceTiers: [{ ...item.priceTiers[0]!, unitPriceMicrocredits: 0 }] };
    expect(previewModelMultiplier([zero], 10, 6)[0]!.priceTiers[0]!.unitPriceMicrocredits).toBe(0);
});

test("USD import preserves separate token rates, units, versions and final manual prices", () => {
    const result = previewModelMultiplier([item], 1.2, 6, defaults, 7);
    const tier = result[0]!.priceTiers[0]!;
    expect(tier.billingMode).toBe("token");
    expect([tier.inputTokenPriceMicrocredits, tier.outputTokenPriceMicrocredits, tier.cachedTokenPriceMicrocredits]).toEqual([42_000_000, 336_000_000, 4_200_000]);
    const rows = modelRepriceRows(result);
    rows[1]!.sale = "300";
    expect(modelRepriceChanges([item], rows)).toBe(3);
    const saved = modelRepricePayloadWithModes([item], result, rows)[0]!;
    expect(saved.priceVersion).toBe(4);
    expect(saved.priceTiers[0]).toMatchObject({ billingMode: "token", priceVersion: 3, prices: { outputTokenPriceMicrocredits: 300_000_000 } });
});

test("unmatched defaults preserve references and are excluded from writes; unchanged is a no-op", () => {
    const unknown = { ...item, id: "unknown", priceTiers: [{ ...item.priceTiers[0]!, id: "unknown-tier" }] };
    const result = previewModelMultiplier([item, unknown], 2, 6, defaults);
    expect(result[1]!.priceTiers[0]).toBe(unknown.priceTiers[0]);
    expect(modelRepricePayloadWithModes([item, unknown], result, modelRepriceRows(result)).map((model) => model.modelId)).toEqual(["m"]);
    expect(modelRepricePayloadWithModes([item], [item], modelRepriceRows([item]))).toEqual([]);
    const blocked = { ...defaults, prices: defaults.prices.map((price) => ({ ...price, supported: false })) };
    expect(previewModelMultiplier([item], 10, 6, blocked)[0]!.priceTiers[0]).toBe(item.priceTiers[0]);
    const invalidUnknown = { ...unknown, priceTiers: [{ ...unknown.priceTiers[0]!, unitPriceMicrocredits: -1 }] };
    const partial = previewModelMultiplier([item, invalidUnknown], 2, 6, defaults);
    expect(modelRepricePayloadWithModes([item, invalidUnknown], partial, modelRepriceRows(partial)).map((model) => model.modelId)).toEqual(["m"]);
    const cleared = modelRepriceRows([item]);
    cleared[0]!.sale = null;
    expect(() => modelRepricePayloadWithModes([item], [item], cleared)).toThrow();
});

test("invalid pricing and conversion never become zero; precision rounds only once", () => {
    for (const multiplier of [null, 0, -1, NaN, Infinity, 101, 1.00001]) expect(() => previewModelMultiplier([item], multiplier, 6)).toThrow();
    for (const conversion of [0, -1, NaN, Infinity, 1_000_001]) expect(() => previewModelMultiplier([item], 1, 6, defaults, conversion)).toThrow();
    expect(() => previewModelMultiplier([item], 1, 6, { ...defaults, currency: "CNY" })).toThrow();
    const tiny = { ...defaults, prices: [{ ...defaults.prices[0]!, billingMode: "fixed_request" as const, unitPrice: 0.00000025 }] };
    expect(previewModelMultiplier([item], 2, 6, tiny)[0]!.priceTiers[0]!.unitPriceMicrocredits).toBe(1);
    const invalid = { ...item, priceTiers: [{ ...item.priceTiers[0]!, unitPriceMicrocredits: -1 }] };
    const rows = modelRepriceRows([invalid]);
    rows[0]!.sale = "1";
    expect(modelRepriceChanges([invalid], rows)).toBe(1);
    expect(modelRepricePayloadWithModes([invalid], [invalid], rows)[0]!.priceTiers[0]!.prices.unitPriceMicrocredits).toBe(1_000_000);
});
