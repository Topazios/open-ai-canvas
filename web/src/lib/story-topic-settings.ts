import { changeDramaSetting, type ShortDramaGlobalSettings } from "./short-drama-settings";

export const storyTopicSettingFields = ["market", "targetMarket", "audience", "genre", "tone", "region", "era", "ending"] as const;
export type StoryTopicSettingKey = typeof storyTopicSettingFields[number] | "premise";
export type StoryTopicSettingsPatch = Partial<Omit<ShortDramaGlobalSettings, "schemaVersion" | "revision">>;

// Persist only edited fields, so unrelated settings can still follow the latest canvas revision.
export function changeStoryTopicSettings(settings: ShortDramaGlobalSettings, patch: StoryTopicSettingsPatch | undefined, key: StoryTopicSettingKey, value: string): StoryTopicSettingsPatch {
    const current = { ...settings, ...patch };
    const next = key === "premise" ? { ...current, premise: value } : changeDramaSetting(current, key, value);
    return Object.fromEntries(Object.entries(next).filter(([field, entry]) => field !== "revision" && field !== "schemaVersion" && entry !== settings[field as keyof ShortDramaGlobalSettings]));
}
