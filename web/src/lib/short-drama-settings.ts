import type { StoryDevelopmentBrief } from "@/types/canvas";
import { DramaSource, DramaVisualForm, DramaVisualStyle, DramaNarration, DramaAspectRatio, DramaLanguage, DramaVoiceLanguage, DramaRegion, DramaEra, DramaDuration, DramaAudience, DramaMarket, DramaTargetMarket, DramaEnding, DramaComplexity, DramaContentRating, dramaSettingOptions, dramaSettingLabels, type DramaSettingValues } from "./short-drama-settings-catalog";
import { dramaMarketProfiles } from "./short-drama-market-profiles";
export * from "./short-drama-settings-catalog";
export { dramaMarketProfiles, dramaMarketResearchDate } from "./short-drama-market-profiles";

type SettingValues = DramaSettingValues;
export type ShortDramaGlobalSettings = Omit<SettingValues, "targetMarket"> & {
    // Existing settings and submitted task snapshots may predate regional presets.
    targetMarket?: DramaTargetMarket;
    schemaVersion: 1;
    revision: number;
    episodeCount: number;
    premise: string;
};

const dramaLanguageVoices: Record<DramaLanguage, DramaVoiceLanguage> = {
    [DramaLanguage.SimplifiedChinese]: DramaVoiceLanguage.Mandarin,
    [DramaLanguage.TraditionalChinese]: DramaVoiceLanguage.Mandarin,
    [DramaLanguage.English]: DramaVoiceLanguage.English,
    [DramaLanguage.Japanese]: DramaVoiceLanguage.Japanese,
    [DramaLanguage.Korean]: DramaVoiceLanguage.Korean,
    [DramaLanguage.Spanish]: DramaVoiceLanguage.Spanish,
    [DramaLanguage.French]: DramaVoiceLanguage.French,
    [DramaLanguage.Portuguese]: DramaVoiceLanguage.Portuguese,
    [DramaLanguage.Thai]: DramaVoiceLanguage.Thai,
    [DramaLanguage.Indonesian]: DramaVoiceLanguage.Indonesian,
    [DramaLanguage.Vietnamese]: DramaVoiceLanguage.Vietnamese,
    [DramaLanguage.Filipino]: DramaVoiceLanguage.Filipino,
    [DramaLanguage.Hindi]: DramaVoiceLanguage.Hindi,
    [DramaLanguage.Arabic]: DramaVoiceLanguage.Arabic,
    [DramaLanguage.German]: DramaVoiceLanguage.German,
};

export function dramaTargetMarketOptions(market: DramaMarket) {
    return dramaSettingOptions.targetMarket.filter(({ value }) => market === DramaMarket.Domestic ? value === DramaTargetMarket.China : value !== DramaTargetMarket.China);
}

export function resolvedDramaTargetMarket(settings: ShortDramaGlobalSettings): DramaTargetMarket {
    if (settings.targetMarket && dramaTargetMarketOptions(settings.market).some(({ value }) => value === settings.targetMarket)) return settings.targetMarket;
    if (settings.market === DramaMarket.Domestic) return DramaTargetMarket.China;
    if (settings.market === DramaMarket.Both) return DramaTargetMarket.Global;
    // Infer only the missing target label; never rewrite a saved creative choice.
    const regional = Object.entries(dramaMarketProfiles).find(([key, profile]) =>
        key !== DramaTargetMarket.China && key !== DramaTargetMarket.Global && profile.region === settings.region);
    if (regional) return regional[0] as DramaTargetMarket;
    const localized = Object.entries(dramaMarketProfiles).find(([key, profile]) =>
        key !== DramaTargetMarket.China && key !== DramaTargetMarket.Global && profile.language === settings.language);
    return (localized?.[0] as DramaTargetMarket | undefined) || DramaTargetMarket.NorthAmerica;
}

const regionalFields = ["genre", "tone", "visualStyle", "era"] as const;
type RegionalField = typeof regionalFields[number];
export type DramaSettingOption = { value: string; label: string };
export type DramaSettingOptionGroup = { label: string; options: DramaSettingOption[] };

export function dramaOptionsForSettings(settings: ShortDramaGlobalSettings, key: keyof SettingValues): (DramaSettingOption | DramaSettingOptionGroup)[] {
    if (key === "targetMarket") return dramaTargetMarketOptions(settings.market);
    if (!regionalFields.includes(key as RegionalField)) return dramaSettingOptions[key];
    const preferred: readonly string[] = dramaMarketProfiles[resolvedDramaTargetMarket(settings)][key as RegionalField];
    const all: readonly DramaSettingOption[] = dramaSettingOptions[key];
    return [
        { label: "区域推荐", options: preferred.map((value) => all.find((option) => option.value === value)!) },
        { label: "其他选项", options: all.filter((option) => !preferred.includes(option.value)) },
    ];
}

function applyMarketProfile(current: ShortDramaGlobalSettings, market: DramaMarket, targetMarket: DramaTargetMarket): ShortDramaGlobalSettings {
    const profile = dramaMarketProfiles[targetMarket];
    const language = market === DramaMarket.Both ? DramaLanguage.SimplifiedChinese : profile.language;
    return {
        ...current, market, targetMarket, language, voiceLanguage: dramaLanguageVoices[language], subtitleLanguage: profile.language,
        region: market === DramaMarket.Both ? DramaRegion.China : profile.region,
        genre: profile.genre[0], tone: profile.tone[0], visualStyle: profile.visualStyle[0], era: profile.era[0],
    };
}

export function changeDramaSetting(current: ShortDramaGlobalSettings, key: keyof SettingValues, value: string): ShortDramaGlobalSettings {
    if (!dramaSettingOptions[key].some((option) => option.value === value)) throw new Error(`请选择有效的${dramaSettingLabels[key]}`);
    if (current[key] === value) return current;
    if (key === "market") {
        const market = value as DramaMarket;
        const target = market === DramaMarket.Domestic ? DramaTargetMarket.China
            : market === DramaMarket.Both ? DramaTargetMarket.Global : DramaTargetMarket.NorthAmerica;
        return applyMarketProfile(current, market, target);
    }
    if (key === "targetMarket") {
        if (!dramaTargetMarketOptions(current.market).some((option) => option.value === value)) throw new Error("目标市场与发行方向不匹配");
        if (resolvedDramaTargetMarket(current) === value) return current;
        return applyMarketProfile(current, current.market, value as DramaTargetMarket);
    }
    if (key === "language") {
        const language = value as DramaLanguage;
        return { ...current, language, voiceLanguage: dramaLanguageVoices[language],
            subtitleLanguage: current.subtitleLanguage === current.language ? language : current.subtitleLanguage };
    }
    return { ...current, [key]: value };
}

export const dramaDurationSeconds: Record<DramaDuration, { min: number; max: number }> = {
    "30-60s": { min: 30, max: 60 }, "1-2m": { min: 60, max: 120 }, "2-3m": { min: 120, max: 180 }, "3-5m": { min: 180, max: 300 }, "5-10m": { min: 300, max: 600 },
};

export function defaultShortDramaSettings(): ShortDramaGlobalSettings {
    return { schemaVersion: 1, revision: 1, source: DramaSource.Original, genre: dramaMarketProfiles[DramaTargetMarket.China].genre[0], tone: dramaMarketProfiles[DramaTargetMarket.China].tone[0],
        visualForm: DramaVisualForm.LiveAction, visualStyle: DramaVisualStyle.Cinematic, narration: DramaNarration.Dialogue, aspectRatio: DramaAspectRatio.Portrait,
        language: DramaLanguage.SimplifiedChinese, voiceLanguage: DramaVoiceLanguage.Mandarin, subtitleLanguage: DramaLanguage.SimplifiedChinese,
        region: DramaRegion.China, era: DramaEra.Contemporary, duration: DramaDuration.Extended, episodeCount: 12,
        audience: DramaAudience.General, market: DramaMarket.Domestic, targetMarket: DramaTargetMarket.China, ending: DramaEnding.Resolved, complexity: DramaComplexity.Standard,
        contentRating: DramaContentRating.Restrained, premise: "" };
}

export function validateShortDramaSettings(value: ShortDramaGlobalSettings) {
    if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error("全局设定版本无效");
    for (const key of Object.keys(dramaSettingOptions) as (keyof SettingValues)[]) {
        if (key === "targetMarket" && value.targetMarket === undefined) continue;
        if (!dramaSettingOptions[key].some((option) => option.value === value[key])) throw new Error(`请选择有效的${dramaSettingLabels[key]}`);
    }
    if (value.targetMarket !== undefined && !dramaTargetMarketOptions(value.market).some((option) => option.value === value.targetMarket)) throw new Error("目标市场与发行方向不匹配");
    if (!Number.isInteger(value.episodeCount) || value.episodeCount < 1 || value.episodeCount > 200) throw new Error("总集数应为 1–200 的整数");
    if (typeof value.premise !== "string" || value.premise.length > 2000) throw new Error("补充设定最多 2000 字");
    return value;
}

export function dramaSettingLabel<K extends keyof SettingValues>(key: K, value: SettingValues[K] | undefined) {
    return dramaSettingOptions[key].find((option) => option.value === value)?.label || "";
}

export function storyBriefFromSettings(settings: ShortDramaGlobalSettings): StoryDevelopmentBrief {
    validateShortDramaSettings(settings);
    const seconds = dramaDurationSeconds[settings.duration];
    return { genre: dramaSettingLabel("genre", settings.genre), style: dramaSettingLabel("tone", settings.tone),
        premise: settings.premise.trim() || `${dramaSettingLabel("era", settings.era)}，${dramaSettingLabel("region", settings.region)}。${settings.source === DramaSource.Original ? "根据既定题材设计原创人物与核心冲突。" : "依据提供的原文保留人物、情节与核心冲突，不另起无关故事。"}`,
        audience: dramaSettingLabel("audience", settings.audience), episodeCount: settings.episodeCount, minutesPerEpisode: `${seconds.min / 60}-${seconds.max / 60}`,
        topicCount: 4, globalSettings: { ...settings } };
}

export function globalSettingsPrompt(settings: ShortDramaGlobalSettings | undefined, stage: string, media: "text" | "image" = "text") {
    if (!settings) return "";
    validateShortDramaSettings(settings);
    if (media === "image" && stage === "assets") {
        const visualKeys: (keyof SettingValues)[] = ["visualForm", "visualStyle", "tone", "region", "era"];
        return `项目视觉设定：\n${visualKeys.map((key) => `${dramaSettingLabels[key]}：${dramaSettingLabel(key, settings[key])}`).join("\n")}`;
    }
    const keys: (keyof SettingValues)[] = media === "image"
        ? ["visualForm", "visualStyle", "tone", "region", "era", ...(stage === "assets" ? [] : ["aspectRatio" as const])]
        : stage === "story" ? ["source", "genre", "tone", "narration", "language", "voiceLanguage", "subtitleLanguage", "region", "era", "audience", "ending", "complexity", "contentRating", "visualForm", "visualStyle"]
        : ["genre", "tone", "visualForm", "visualStyle", "narration", "language", "voiceLanguage", "subtitleLanguage", "region", "era", "aspectRatio", "complexity", "contentRating"];
    const target = settings.targetMarket ? `\n目标市场：${dramaSettingLabel("targetMarket", settings.targetMarket)}（发行受众；故事发生地与语言以各自设定为准）` : "";
    return `全局创作设定（第 ${settings.revision} 版，明确约束不得擅自替换）：\n发行方向：${dramaSettingLabel("market", settings.market)}${target}\n${keys.map((key) => `${dramaSettingLabels[key]}：${dramaSettingLabel(key, settings[key])}`).join("\n")}\n总集数：${settings.episodeCount}；单集时长：${dramaSettingLabel("duration", settings.duration)}${media === "image" && stage === "assets" ? "\n资产设定板继续采用统一横向排版，成片画幅不改变设定板布局。" : ""}${settings.premise.trim() ? `\n补充创作材料：${JSON.stringify(settings.premise.trim())}` : ""}`;
}
