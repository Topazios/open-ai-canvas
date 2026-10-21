import { expect, test } from "bun:test";

test("selected models can have their usage status batch-set from the list action", async () => {
    const manager = await Bun.file(new URL("../src/pages/admin/components/channel-model-manager.tsx", import.meta.url)).text();
    const dialog = await Bun.file(new URL("../src/pages/admin/components/channel-model-batch-settings-dialog.tsx", import.meta.url)).text();

    expect(manager).toContain("selectedRowKeys: selectedModelIds");
    expect(manager).toContain("setBatchSettingsItems(items.filter((item) => selectedModelIds.includes(item.id)))");
    expect(manager).toContain("批量设置");
    expect(dialog).toContain("modelIds: items.map((item) => item.id)");
    expect(dialog).toContain("...(apply.enabled ? { enabled: enabled === \"enabled\" } : {})");
    expect(dialog).toContain('checked={apply.enabled} onToggle={() => toggle("enabled")} label="模型状态"');
    expect(dialog).toContain('{ label: "启用", value: "enabled" }');
    expect(dialog).toContain("停用");
    expect(dialog).toContain("积分成本");
    expect(dialog).toContain('checked={apply.costConfigured} onToggle={() => toggle("costConfigured")} label="积分成本"');
    expect(dialog).toContain('aria-label="启用积分成本配置"');
    expect(dialog).toContain("...(apply.costConfigured ? {");
    expect(dialog).toContain("costConfigured: costEnabled");
    expect(dialog).toContain("...(costEnabled ? { costMicrocredits: Math.round(costAmount * 1_000_000) } : {})");
    expect(dialog).toContain('aria-label="统一积分成本"');
    expect(dialog).toContain("{costEnabled ? (");
    expect(dialog).toContain('value={costAmount}');
    expect(dialog).toContain("useState<number>(0)");
});
