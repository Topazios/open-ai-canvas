import { expect, test } from "bun:test";
import { Form } from "antd";
import { renderToStaticMarkup } from "react-dom/server";
import { PriceTierFields } from "../src/pages/admin/components/channel-model-price-tier-fields";
import { defaultPriceTier } from "../src/pages/admin/components/channel-model-price-tier-form";
import type { ChannelModelFormValues } from "../src/pages/admin/components/channel-model-editor-form";

test("price editor has no user availability switch and retains pricing controls", () => {
    function Editor() {
        const [form] = Form.useForm<ChannelModelFormValues>();
        return <Form form={form} initialValues={{ priceTiers: [defaultPriceTier()] }}>
            <Form.List name="priceTiers">{() => <PriceTierFields index={0} ordinal={1} form={form} capability="text" protocol="chat-completion" modelUpstream="model" onDirty={() => {}} onRemove={() => {}} />}</Form.List>
        </Form>;
    }
    const html = renderToStaticMarkup(<Editor />);
    expect(html).not.toContain("可供用户使用");
    expect(html).toContain("销售价格");
    expect(html).toContain("每次消耗积分");
    expect(html).toContain("删除价格档 1");
});
