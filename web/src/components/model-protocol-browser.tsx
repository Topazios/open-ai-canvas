import { ChoiceBrowser } from "./choice-browser";
import { Select } from "antd";
import { groupedModelProtocols, protocolContract, ProtocolContract, protocolEndpoint, type ModelProtocolDefinition, type ProtocolCapability } from "@/lib/model-protocols";

export function ModelProtocolBrowser({
    capability,
    protocols,
    ...props
}: {
    capability?: ProtocolCapability;
    protocols: ModelProtocolDefinition[];
    value?: string;
    onChange?: (value: string) => void;
    loading?: boolean;
    error?: string;
    disabled?: boolean;
    id?: string;
}) {
    const groups = groupedModelProtocols(protocols.filter((protocol) => !capability || protocol.capability === capability), props.value);
    const selected = groups.find((item) => item.value === props.value);
    const options = groups
        .map((protocol) => ({
            value: protocol.value,
            label: protocol.label,
            subtitle: protocolEndpoint(protocol.create),
            searchText: protocol.adapters.map((item) => `${item.value} ${item.label}`).join(" "),
            details: [
                { label: "请求", value: <code>{protocol.create}</code> },
                { label: "请求体", value: protocol.contentType },
                { label: "响应", value: protocol.poll ? "异步轮询" : "同步响应" },
                { label: "Agent", value: protocol.agentSupported ? "支持工具调用" : "未声明工具调用" },
            ],
        }));

    return <div className="space-y-2">
        <ChoiceBrowser key={capability || "all"} {...props} label="调用协议" placeholder="搜索接口协议或请求路径" options={options} />
        {selected && selected.adapters.length > 1 ? <details key={protocolContract(selected)} open={protocolContract(selected) === ProtocolContract.Custom || undefined} className="text-xs text-foreground/65">
            <summary className="cursor-pointer">适配配置 · {selected.adapters.find((item) => item.value === props.value)?.label}</summary>
            <Select className="mt-2 w-full" aria-label="协议适配配置" value={props.value} disabled={props.disabled || props.loading || Boolean(props.error)} onChange={props.onChange}
                options={selected.adapters.map((item) => ({ value: item.value, label: `${item.label} · ${item.create}` }))} />
        </details> : null}
    </div>;
}
