import { Input } from "antd";
import { Select } from "@/components/ui/base/select";
import { DramaMarket, dramaOptionsForSettings, dramaSettingLabels, resolvedDramaTargetMarket, type ShortDramaGlobalSettings } from "@/lib/short-drama-settings";
import { storyTopicSettingFields, type StoryTopicSettingKey } from "@/lib/story-topic-settings";

export function CanvasTopicSettingsFields({ settings, disabled, onChange }: { settings: ShortDramaGlobalSettings; disabled: boolean; onChange: (key: StoryTopicSettingKey, value: string) => void }) {
    return <section className="story-topic-settings" aria-label="选题条件">
        <strong>选题条件</strong>
        <div className="story-topic-settings-grid">
            {storyTopicSettingFields.map((key) => <div key={key} className="story-topic-setting-field">
                <label htmlFor={`topic-${key}`}>{dramaSettingLabels[key]}</label>
                <Select<string> id={`topic-${key}`} ariaLabel={dramaSettingLabels[key]} appearance="field" value={key === "targetMarket" ? resolvedDramaTargetMarket(settings) : settings[key]}
                    options={dramaOptionsForSettings(settings, key)} showSearch optionFilterProp="label" disabled={disabled || (key === "targetMarket" && settings.market === DramaMarket.Domestic)}
                    onChange={(value) => onChange(key, value)} />
            </div>)}
            <div className="story-topic-setting-field story-development-premise">
                <label htmlFor="topic-premise">核心设定（可选）</label>
                <Input.TextArea id="topic-premise" aria-label="核心设定" value={settings.premise} maxLength={2000} autoSize={{ minRows: 3 }} disabled={disabled} placeholder="例如：主角能看见每个人曾经放弃的人生" onChange={(event) => onChange("premise", event.target.value)} />
            </div>
        </div>
    </section>;
}
