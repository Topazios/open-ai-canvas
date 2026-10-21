import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChannelModelRepriceTable } from "../src/pages/admin/components/channel-model-reprice-dialog";
import { modelRepricePayload, modelRepriceRows, previewModelRepricing } from "../src/pages/admin/components/channel-model-pricing";
import type { ChannelModel, ModelDefaultPricing } from "../src/services/api/wallet";

const model = {
    id: "image",
    modelKey: "image-model",
    displayName: "GPT Image 2.5",
    channelLabel: "特惠渠道",
    providerModelKey: "gpt-image-2.5",
    capability: "image",
    priceVersion: 9,
    priceTiers: ["1K", "2K", "4K"].map((resolution, index) => ({
        id: `tier-${index}`,
        selector: { vquality: resolution },
        selectorKey: resolution,
        resolution,
        enabled: true,
        priceConfigured: true,
        priceVersion: index + 1,
        billingMode: "fixed_request",
        unitPriceMicrocredits: 4_000 + index * 1_000,
        costPricing: { configured: true, unitPriceMicrocredits: 3_000 },
    })),
} as ChannelModel;

function render(items = [model], rows = modelRepriceRows(items)) {
    return renderToStaticMarkup(<ChannelModelRepriceTable items={items} rows={rows} channelName="所属渠道" decimalPlaces={3} disabled={false} onSaleChange={() => {}} />);
}

test("multi-spec models render once with aligned specifications and separate sale inputs", () => {
    const html = render();
    expect(html.match(/data-row-key="image"/g)).toHaveLength(1);
    expect(html.match(/class="admin-model-reprice-spec-row"/g)).toHaveLength(3);
    expect(html.match(/role="spinbutton"/g)).toHaveLength(3);
    expect(html).toContain('colSpan="3"');
    expect(html).toContain("渠道展示名（上游模型ID）");
    expect(html.match(/>GPT Image 2.5</g)).toHaveLength(1);
    expect(html.match(/>特惠渠道</g)).toHaveLength(1);
    expect(html).toContain("gpt-image-2.5");
    for (const value of ["0.004", "0.005", "0.006"]) expect(html).toContain(`value="${value}"`);
    for (const spec of ["1K", "2K", "4K"]) expect(html).toContain(`>${spec}<`);
});

test("recalculation resets all specifications; manual edit changes only its final submitted price", () => {
    const rows = modelRepriceRows(previewModelRepricing([model], 25, 3));
    expect(rows.map((row) => row.sale)).toEqual(["0.004", "0.004", "0.004"]);
    rows[1]!.sale = "0.0055";
    rows[1]!.manual = true;
    expect(modelRepricePayload([model], rows)[0]!.priceTiers.map((tier) => tier.prices.unitPriceMicrocredits)).toEqual([4_000, 5_500, 4_000]);
    const html = render([model], rows);
    expect(html).toContain('value="0.0055"');
    expect(html).toContain("手动修改");
    const reset = modelRepriceRows(previewModelRepricing([model], 25, 3));
    expect(reset.map((row) => row.sale)).toEqual(["0.004", "0.004", "0.004"]);
    expect(reset.every((row) => !row.manual)).toBe(true);
});

test("token fields stay inside a single model row and tier upstream overrides stay visible", () => {
    const token = {
        ...model,
        capability: "text" as const,
        channelLabel: "",
        priceTiers: [{ ...model.priceTiers[0]!, billingMode: "token" as const, providerModelKey: "spec-upstream", inputTokenPriceMicrocredits: 10, outputTokenPriceMicrocredits: 20, cachedTokenPriceMicrocredits: 30 }],
    };
    const html = render([token]);
    expect(html.match(/data-row-key="image"/g)).toHaveLength(1);
    expect(html.match(/role="spinbutton"/g)).toHaveLength(3);
    expect(html).toContain("所属渠道");
    expect(html).toContain("spec-upstream");
    for (const label of ["输入", "输出", "缓存"]) expect(html).toContain(`>${label}<`);
});

test("official model mapping, source, applicability and unsupported reasons are visible", () => {
    const defaults: ModelDefaultPricing = {
        currency: "USD", source: "厂商官方公开价快照", fetchedAt: "2026-10-17T00:00:00Z", verifiedAt: "2026-10-17",
        profiles: [{ id: "official-image", modelKey: "official-image", capability: "image", label: "官方图片模型", billingMode: "", sourceUrl: "https://developers.openai.com/api/docs/pricing", note: "多模态 Token", autoMatch: true }],
        prices: [{ modelId: "image", tierId: "tier-0", upstreamModel: "gpt-image-2.5", profileId: "official-image", supported: false, reason: "无法可靠换算按次价格", sourceUrl: "https://developers.openai.com/api/docs/pricing", note: "不含工具费用", unitPrice: 0, inputTokenPrice: 0, outputTokenPrice: 0, cachedTokenPrice: 0 }],
    };
    const html = renderToStaticMarkup(<ChannelModelRepriceTable items={[model]} rows={modelRepriceRows([model])} channelName="渠道" decimalPlaces={6} disabled={false} onSaleChange={() => {}} defaults={defaults} onProfileChange={() => {}} />);
    expect(html).toContain("官方模型 / 档位");
    expect(html).toContain("官方图片模型");
    expect(html).toContain("官方来源");
    expect(html).toContain("不含工具费用");
    expect(html).toContain("保留原价：无法可靠换算按次价格");
    expect(html).toContain('aria-valuenow="0.004"');
});

test("recalculate supports both modes and default-price fetch is abortable", async () => {
    const source = await Bun.file(new URL("../src/pages/admin/components/channel-model-reprice-dialog.tsx", import.meta.url)).text();
    expect(source).toContain("onClick={() => recalculate()}");
    expect(source).toContain("重新计算");
    expect(source).toContain("previewModelRepricing(items, next.margin, next.decimalPlaces)");
    expect(source).toContain("controller.signal");
    expect(source).toContain("modelRepricePayloadWithModes(items, preview, rows)");
});

test("batch repricing only changes prices and leaves model status to batch settings", async () => {
    const source = await Bun.file(new URL("../src/pages/admin/components/channel-model-reprice-dialog.tsx", import.meta.url)).text();
    expect(source).toContain("const result = await repriceAdminChannelModels(channelId, modelRepricePayloadWithModes(items, preview, rows))");
    expect(source).toContain("调价不修改成本或模型启停状态");
    expect(source).not.toContain("updateAdminChannelModelsSettings");
    expect(source).not.toContain("同时统一设置模型状态");
});
