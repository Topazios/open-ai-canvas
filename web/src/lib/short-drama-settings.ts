import type { StoryDevelopmentBrief } from "@/types/canvas";
import { DramaSource, DramaVisualForm, DramaVisualStyle, DramaNarration, DramaAspectRatio, DramaLanguage, DramaVoiceLanguage, DramaRegion, DramaEra, DramaDuration, DramaAudience, DramaMarket, DramaTargetMarket, DramaEnding, DramaComplexity, DramaContentRating, dramaSettingOptions, dramaSettingLabels, type DramaSettingValues } from "./short-drama-settings-catalog";
import { dramaMarketProfiles } from "./short-drama-market-profiles";
import { dramaGenreContract } from "./drama-storycraft";
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
    voiceCalibrationText?: string;
    voiceCalibrationLanguage?: DramaVoiceLanguage;
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
    if (value.voiceCalibrationText !== undefined && (typeof value.voiceCalibrationText !== "string" || value.voiceCalibrationText.length > 2000)) throw new Error("声音校准文本最多 2000 字");
    if (value.voiceCalibrationLanguage !== undefined && !Object.values(DramaVoiceLanguage).includes(value.voiceCalibrationLanguage)) throw new Error("声音校准文本语言无效");
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

type DramaWorldPolicyMode = "domestic" | "international" | "fictional";

const dramaWorldPolicyModes: Record<DramaWorldPolicyMode, string> = {
    domestic: "故事发生地为中国。未被选题或原文明确改变的部分，按中国当地的社会制度、机构、生活方式、城市空间、职业语境和常用称谓设计。",
    international: "故事发生地不在中国。人物身份、国籍或族裔、姓名、家庭关系、社会制度、机构、职业环境、法律与生活细节必须以所选故事发生地为准；未被选题或原文明确指定为中国籍、华裔、华人或移民时，不得因为正文使用中文而自动加入这些身份，也不得自动套用中国式豪门、家庭、学校、职场、法律、货币、节日或城市称谓。",
    fictional: "故事发生地为架空地域。按照选题或原文已经给出的世界规则设计社会制度、身份、机构、生活方式和空间，不擅自套用中国或任何现实地区的默认设定。",
};

export function dramaWorldSettingsPrompt(settings: ShortDramaGlobalSettings, includeDistribution = true) {
    const mode: DramaWorldPolicyMode = settings.region === DramaRegion.China ? "domestic" : settings.region === DramaRegion.Fictional ? "fictional" : "international";
    const region = dramaSettingLabel("region", settings.region);
    const language = dramaSettingLabel("language", settings.language);
    const distribution = includeDistribution ? "发行方向和目标市场只影响发行受众与区域偏好，不得改写故事发生地；" : "故事发生地不得被视觉风格或输出语言改写；";
    return `故事世界与输出语言必须分开解释：\n故事发生地是权威世界设定：${region}。${distribution}正文语言是${language}，只决定正文、对白、文稿和提示词使用的书写语言，不决定人物国籍、族裔、姓名、制度或生活方式。\n${dramaWorldPolicyModes[mode]}\n即使使用中文输出，也应使用所选地区真实或合理的本地人物与环境细节；本地姓名可以按中文习惯音译或译写，但不能把本地身份改写成中国背景。除非选题、补充创作材料或原文明确提出，不能擅自添加跨地域身份转换。`;
}

function dramaLocalStorycraftPrompt(settings: ShortDramaGlobalSettings) {
    const region = dramaSettingLabel("region", settings.region);
    return `本土叙事执行要求：故事地点“${region}”必须参与核心关系、权力来源、可行策略及选择后果；从本故事人物欲望和对抗关系出发，不预设全部题材都讲日常生活或现实事务。大区域不是同质文化，具体地点、角色圈层及其语言须连贯；不把任何国家或族群简化成刻板标签，不把无来源的法律、制度、习俗写成事实。中文仅是输出语言，不代表国内叙事腔；对白按角色关系、目的、性格和潜台词创作。\n${dramaGenreContract(settings.genre, settings.tone)}`;
}

export function globalSettingsPrompt(settings: ShortDramaGlobalSettings | undefined, stage: string, media: "text" | "image" = "text") {
    if (!settings) return "";
    validateShortDramaSettings(settings);
    if (media === "image" && stage === "assets") {
        const visualKeys: (keyof SettingValues)[] = ["visualForm", "visualStyle", "tone", "region", "era"];
        return `项目视觉设定：\n${visualKeys.map((key) => `${dramaSettingLabels[key]}：${dramaSettingLabel(key, settings[key])}`).join("\n")}\n${dramaWorldSettingsPrompt(settings, false)}`;
    }
    const keys: (keyof SettingValues)[] = media === "image"
        ? ["visualForm", "visualStyle", "tone", "region", "era", ...(stage === "assets" ? [] : ["aspectRatio" as const])]
        : stage === "story" ? ["source", "genre", "tone", "narration", "language", "voiceLanguage", "subtitleLanguage", "region", "era", "audience", "ending", "complexity", "contentRating", "visualForm", "visualStyle"]
        : ["genre", "tone", "visualForm", "visualStyle", "narration", "language", "voiceLanguage", "subtitleLanguage", "region", "era", "aspectRatio", "complexity", "contentRating"];
    const target = settings.targetMarket ? `\n目标市场：${dramaSettingLabel("targetMarket", settings.targetMarket)}（发行受众；故事发生地与语言以各自设定为准）` : "";
    const storycraft = stage === "story" && media === "text" ? `\n${dramaLocalStorycraftPrompt(settings)}` : "";
    return `全局创作设定（第 ${settings.revision} 版，明确约束不得擅自替换）：\n发行方向：${dramaSettingLabel("market", settings.market)}${target}\n${keys.map((key) => `${dramaSettingLabels[key]}：${dramaSettingLabel(key, settings[key])}`).join("\n")}\n${dramaWorldSettingsPrompt(settings)}${storycraft}\n总集数：${settings.episodeCount}；单集时长：${dramaSettingLabel("duration", settings.duration)}${media === "image" && stage === "assets" ? "\n资产设定板继续采用统一横向排版，成片画幅不改变设定板布局。" : ""}${settings.premise.trim() ? `\n补充创作材料：${JSON.stringify(settings.premise.trim())}` : ""}`;
}
