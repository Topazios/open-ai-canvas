// Persist enum values, never translated labels or market recommendation order.
export enum DramaSource { Original = "original", Adaptation = "adaptation", Script = "script" }
export enum DramaGenre {
    Urban = "urban", Romance = "romance", Suspense = "suspense", Fantasy = "fantasy", Scifi = "scifi", Historical = "historical", Family = "family", Comedy = "comedy", Adventure = "adventure",
    SweetRomance = "sweet-romance", ContractRomance = "contract-romance", SecondChance = "second-chance", Workplace = "workplace", Youth = "youth", Revenge = "revenge", FemaleGrowth = "female-growth", Underdog = "underdog", Rebirth = "rebirth", TimeTravel = "time-travel", PeriodLife = "period-life", RuralLife = "rural-life", Crime = "crime", Thriller = "thriller", Folklore = "folklore", Werewolf = "werewolf", Vampire = "vampire", RoyalRomance = "royal-romance", Xianxia = "xianxia", Wuxia = "wuxia", Survival = "survival", Sports = "sports", Music = "music",
}
export enum DramaTone { Tense = "tense", Warm = "warm", Uplifting = "uplifting", Light = "light", Dark = "dark", Moving = "moving", Sweet = "sweet", Bittersweet = "bittersweet", Cathartic = "cathartic", Romantic = "romantic", Restrained = "restrained", Absurd = "absurd", Epic = "epic", Eerie = "eerie", Nostalgic = "nostalgic" }
export enum DramaVisualForm { LiveAction = "live-action", Animation2D = "animation-2d", Animation3D = "animation-3d", MotionComic = "motion-comic" }
export enum DramaVisualStyle { Cinematic = "cinematic", Natural = "natural", Anime = "anime", Ink = "ink", Stylized = "stylized", Retro = "retro", Soft = "soft", Glossy = "glossy", Documentary = "documentary", Noir = "noir", Gothic = "gothic", Neon = "neon", Period = "period", Webtoon = "webtoon", Watercolor = "watercolor", Graphic = "graphic", Realistic3D = "realistic-3d", Toon3D = "toon-3d" }
export enum DramaNarration { Dialogue = "dialogue", Narrator = "narrator", Mixed = "mixed" }
export enum DramaAspectRatio { Portrait = "9:16", Landscape = "16:9", Square = "1:1", Classic = "4:3" }
export enum DramaLanguage { SimplifiedChinese = "zh-CN", TraditionalChinese = "zh-TW", English = "en", Japanese = "ja", Korean = "ko", Spanish = "es", French = "fr", Portuguese = "pt-BR", Thai = "th", Indonesian = "id", Vietnamese = "vi", Filipino = "fil", Hindi = "hi", Arabic = "ar", German = "de" }
export enum DramaVoiceLanguage { Mandarin = "cmn", Cantonese = "yue", English = "en", Japanese = "ja", Korean = "ko", Spanish = "es", French = "fr", Portuguese = "pt-BR", Thai = "th", Indonesian = "id", Vietnamese = "vi", Filipino = "fil", Hindi = "hi", Arabic = "ar", German = "de" }
export enum DramaRegion { China = "china", EastAsia = "east-asia", Europe = "europe", NorthAmerica = "north-america", SoutheastAsia = "southeast-asia", Fictional = "fictional", Japan = "japan", Korea = "korea", Thailand = "thailand", Indonesia = "indonesia", Vietnam = "vietnam", Philippines = "philippines", LatinAmerica = "latin-america", Brazil = "brazil", India = "india", MiddleEast = "middle-east" }
export enum DramaEra { Contemporary = "contemporary", Modern = "modern", Ancient = "ancient", Future = "future", Fictional = "fictional", Y2K = "y2k", Nineties = "1990s", Eighties = "1980s", Seventies = "1970s", MidCentury = "mid-century", Early20th = "early-20th", Nineteenth = "19th-century", Medieval = "medieval", NearFuture = "near-future", PostApocalyptic = "post-apocalyptic", Mythic = "mythic" }
export enum DramaDuration { Micro = "30-60s", Short = "1-2m", Standard = "2-3m", Extended = "3-5m", Long = "5-10m" }
export enum DramaAudience { General = "general", YoungAdults = "young-adults", Adults = "adults", Family = "family" }
export enum DramaMarket { Domestic = "domestic", Overseas = "overseas", Both = "both" }
export enum DramaTargetMarket { China = "china", NorthAmerica = "north-america", Japan = "japan", Korea = "korea", Thailand = "thailand", Indonesia = "indonesia", Vietnam = "vietnam", Philippines = "philippines", LatinAmerica = "latin-america", Brazil = "brazil", Europe = "europe", India = "india", MiddleEast = "middle-east", Global = "global" }
export enum DramaEnding { Resolved = "resolved", Happy = "happy", Tragic = "tragic", Open = "open" }
export enum DramaComplexity { Standard = "standard", Lean = "lean" }
export enum DramaContentRating { Restrained = "restrained", Dramatic = "dramatic" }

function choices<T extends string>(labels: Record<T, string>) {
    return Object.entries(labels).map(([value, label]) => ({ value: value as T, label: label as string }));
}
const languageLabels: Record<DramaLanguage, string> = { "zh-CN": "简体中文", "zh-TW": "繁体中文", en: "英语", ja: "日语", ko: "韩语", es: "西班牙语", fr: "法语", "pt-BR": "巴西葡萄牙语", th: "泰语", id: "印度尼西亚语", vi: "越南语", fil: "菲律宾语", hi: "印地语", ar: "阿拉伯语", de: "德语" };

export const dramaSettingOptions = {
    source: choices<DramaSource>({ original: "原创选题", adaptation: "已有故事改编", script: "已有剧本" }),
    genre: choices<DramaGenre>({ urban: "都市", romance: "爱情", suspense: "悬疑", fantasy: "奇幻", scifi: "科幻", historical: "古装", family: "家庭", comedy: "喜剧", adventure: "冒险", "sweet-romance": "甜宠爱情", "contract-romance": "契约婚恋", "second-chance": "破镜重圆", workplace: "职场成长", youth: "青春校园", revenge: "复仇逆袭", "female-growth": "女性成长", underdog: "小人物逆袭", rebirth: "重生改命", "time-travel": "穿越时空", "period-life": "年代生活", "rural-life": "乡土生活", crime: "犯罪探案", thriller: "惊悚", folklore: "民俗奇谈", werewolf: "狼人奇幻", vampire: "吸血鬼奇幻", "royal-romance": "王室爱情", xianxia: "仙侠修真", wuxia: "武侠江湖", survival: "末日求生", sports: "竞技运动", music: "音乐成长" }),
    tone: choices<DramaTone>({ tense: "紧张悬疑", warm: "温暖治愈", uplifting: "热血励志", light: "轻松幽默", dark: "冷峻暗黑", moving: "细腻感人", sweet: "甜蜜心动", bittersweet: "虐恋揪心", cathartic: "爽感解压", romantic: "浪漫梦幻", restrained: "克制留白", absurd: "荒诞讽刺", epic: "史诗壮阔", eerie: "诡谲惊悚", nostalgic: "怀旧温情" }),
    visualForm: choices<DramaVisualForm>({ "live-action": "真人质感", "animation-2d": "二维动画", "animation-3d": "三维动画", "motion-comic": "动态漫画" }),
    visualStyle: choices<DramaVisualStyle>({ cinematic: "电影质感", natural: "自然写实", anime: "赛璐璐动漫", ink: "水墨国风", stylized: "风格化插画", retro: "复古胶片", soft: "清透柔光", glossy: "精致时尚", documentary: "纪实生活", noir: "黑色电影", gothic: "哥特暗黑", neon: "霓虹赛博", period: "古典工笔", webtoon: "现代条漫", watercolor: "水彩绘本", graphic: "高对比漫画", "realistic-3d": "写实三维", "toon-3d": "卡通三维" }),
    narration: choices<DramaNarration>({ dialogue: "对白驱动", narrator: "旁白解说", mixed: "对白与旁白混合" }),
    aspectRatio: choices<DramaAspectRatio>({ "9:16": "9:16 竖屏", "16:9": "16:9 横屏", "1:1": "1:1 方形", "4:3": "4:3 横屏" }),
    language: choices(languageLabels),
    voiceLanguage: choices<DramaVoiceLanguage>({ cmn: "普通话", yue: "粤语", en: "英语", ja: "日语", ko: "韩语", es: "西班牙语", fr: "法语", "pt-BR": "巴西葡萄牙语", th: "泰语", id: "印度尼西亚语", vi: "越南语", fil: "菲律宾语", hi: "印地语", ar: "阿拉伯语", de: "德语" }),
    subtitleLanguage: choices(languageLabels),
    region: choices<DramaRegion>({ china: "中国", "east-asia": "东亚", europe: "欧洲", "north-america": "北美", "southeast-asia": "东南亚", fictional: "架空地域", japan: "日本", korea: "韩国", thailand: "泰国", indonesia: "印度尼西亚", vietnam: "越南", philippines: "菲律宾", "latin-america": "拉丁美洲（西语）", brazil: "巴西", india: "印度", "middle-east": "中东与北非" }),
    era: choices<DramaEra>({ contemporary: "当代", modern: "近现代", ancient: "古代", future: "未来", fictional: "架空时代", y2k: "2000 年代", "1990s": "1990 年代", "1980s": "1980 年代", "1970s": "1970 年代", "mid-century": "20 世纪中叶", "early-20th": "20 世纪初", "19th-century": "19 世纪", medieval: "中世纪", "near-future": "近未来", "post-apocalyptic": "末世", mythic: "神话时代" }),
    duration: choices<DramaDuration>({ "30-60s": "30–60 秒", "1-2m": "1–2 分钟", "2-3m": "2–3 分钟", "3-5m": "3–5 分钟", "5-10m": "5–10 分钟" }),
    audience: choices<DramaAudience>({ general: "大众观众", "young-adults": "青年观众", adults: "成年观众", family: "家庭观众" }),
    market: choices<DramaMarket>({ domestic: "国内", overseas: "海外", both: "国内与海外" }),
    targetMarket: choices<DramaTargetMarket>({ china: "中国大陆", "north-america": "北美（英语）", japan: "日本", korea: "韩国", thailand: "泰国", indonesia: "印度尼西亚", vietnam: "越南", philippines: "菲律宾", "latin-america": "拉美（西语）", brazil: "巴西（葡语）", europe: "欧洲", india: "印度（印地语）", "middle-east": "中东与北非（阿语）", global: "跨区域发行" }),
    ending: choices<DramaEnding>({ resolved: "主线完整收束", happy: "圆满结局", tragic: "悲剧结局", open: "开放结局" }),
    complexity: choices<DramaComplexity>({ standard: "常规制作", lean: "精简制作，优先复用资产" }),
    contentRating: choices<DramaContentRating>({ restrained: "表达克制，无露骨描写", dramatic: "冲突鲜明，无露骨描写" }),
};

export const dramaSettingLabels: Record<keyof typeof dramaSettingOptions, string> = {
    source: "内容来源", genre: "题材", tone: "情感基调", visualForm: "视觉形式", visualStyle: "视觉画风", narration: "叙事方式", aspectRatio: "成片画幅",
    language: "正文语言", voiceLanguage: "配音语言", subtitleLanguage: "字幕语言", region: "故事发生地", era: "故事年代", duration: "单集时长",
    audience: "目标观众", market: "发行方向", targetMarket: "目标市场", ending: "结局偏好", complexity: "制作复杂度", contentRating: "内容尺度",
};
export type DramaSettingValues = { [K in keyof typeof dramaSettingOptions]: (typeof dramaSettingOptions)[K][number]["value"] };

export const dramaSettingSections: readonly { id: string; title: string; fields: readonly (keyof DramaSettingValues | "episodeCount")[] }[] = [
    { id: "distribution", title: "发行与语言", fields: ["market", "targetMarket", "audience", "language", "voiceLanguage", "subtitleLanguage"] },
    { id: "story", title: "故事内容", fields: ["source", "genre", "tone", "region", "era", "narration"] },
    { id: "visual", title: "视觉表现", fields: ["visualForm", "visualStyle", "aspectRatio"] },
    { id: "production", title: "制作规格", fields: ["episodeCount", "duration", "complexity"] },
];
