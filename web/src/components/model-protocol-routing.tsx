import { Checkbox, Segmented } from "antd";
import { groupedModelProtocols, protocolContractLabel, type ModelProtocolConfig, type ModelProtocolDefinition } from "@/lib/model-protocols";

export function ModelProtocolRouting({ value, onChange, primary, protocols, disabled }: {
    value?: ModelProtocolConfig;
    onChange: (value: ModelProtocolConfig) => void;
    primary?: string;
    protocols: ModelProtocolDefinition[];
    disabled?: boolean;
}) {
    const options = groupedModelProtocols(protocols.filter((item) => item.capability === "text"), primary);
    const supported = new Set([primary, ...(value?.supported || [])]);
    return <div className="model-protocol-routing space-y-2">
        <div className="text-xs font-medium">使用策略</div>
        <Segmented<ModelProtocolConfig["policy"]> disabled={disabled} value={value?.policy || "auto"} options={[{ label: "按任务自动选择", value: "auto" }, { label: "始终使用默认协议", value: "fixed" }]}
            onChange={(policy) => onChange({ policy, supported: [...supported].filter((id): id is string => Boolean(id)) })} />
        <div className="text-xs font-medium">该模型已确认支持的接口</div>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
            {options.map((item) => {
                const checked = item.adapters.some((adapter) => supported.has(adapter.value));
                const isPrimary = item.adapters.some((adapter) => adapter.value === primary);
                return <Checkbox key={item.value} disabled={disabled || isPrimary} checked={checked} onChange={(event) => {
                    const next = [...supported].filter((id): id is string => Boolean(id) && !item.adapters.some((adapter) => adapter.value === id));
                    if (event.target.checked) next.push(item.value);
                    onChange({ policy: value?.policy || "auto", supported: next });
                }}>{protocolContractLabel(item)}{isPrimary ? "（默认）" : ""}</Checkbox>;
            })}
        </div>
        <p className="m-0 text-xs text-foreground/55">仅勾选此渠道、此模型实际支持的接口。自动模式下文本生成和 Agent 优先使用已勾选的 Responses。</p>
    </div>;
}
