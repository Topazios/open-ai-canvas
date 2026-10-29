import { DramaGenre, DramaRegion, DramaTone } from "./short-drama-settings-catalog";

export enum StoryGenrePromise {
    Relationships = "relationships", Investigation = "investigation", Speculative = "speculative",
    Revenge = "revenge", Growth = "growth", Comedy = "comedy", Adventure = "adventure",
}

// Creative contracts, not claims about regional audiences or fixed story plots.
export const dramaGenrePromises: Record<DramaGenre, StoryGenrePromise> = {
    [DramaGenre.Urban]: StoryGenrePromise.Relationships, [DramaGenre.Romance]: StoryGenrePromise.Relationships,
    [DramaGenre.SweetRomance]: StoryGenrePromise.Relationships, [DramaGenre.ContractRomance]: StoryGenrePromise.Relationships,
    [DramaGenre.SecondChance]: StoryGenrePromise.Relationships, [DramaGenre.Family]: StoryGenrePromise.Relationships,
    [DramaGenre.RoyalRomance]: StoryGenrePromise.Relationships, [DramaGenre.PeriodLife]: StoryGenrePromise.Relationships,
    [DramaGenre.RuralLife]: StoryGenrePromise.Relationships, [DramaGenre.Historical]: StoryGenrePromise.Relationships,
    [DramaGenre.Suspense]: StoryGenrePromise.Investigation, [DramaGenre.Crime]: StoryGenrePromise.Investigation,
    [DramaGenre.Thriller]: StoryGenrePromise.Investigation,
    [DramaGenre.Fantasy]: StoryGenrePromise.Speculative, [DramaGenre.Scifi]: StoryGenrePromise.Speculative,
    [DramaGenre.Folklore]: StoryGenrePromise.Speculative, [DramaGenre.Werewolf]: StoryGenrePromise.Speculative,
    [DramaGenre.Vampire]: StoryGenrePromise.Speculative, [DramaGenre.Xianxia]: StoryGenrePromise.Speculative,
    [DramaGenre.TimeTravel]: StoryGenrePromise.Speculative, [DramaGenre.Rebirth]: StoryGenrePromise.Speculative,
    [DramaGenre.Revenge]: StoryGenrePromise.Revenge,
    [DramaGenre.FemaleGrowth]: StoryGenrePromise.Growth, [DramaGenre.Underdog]: StoryGenrePromise.Growth,
    [DramaGenre.Workplace]: StoryGenrePromise.Growth, [DramaGenre.Youth]: StoryGenrePromise.Growth,
    [DramaGenre.Sports]: StoryGenrePromise.Growth, [DramaGenre.Music]: StoryGenrePromise.Growth,
    [DramaGenre.Comedy]: StoryGenrePromise.Comedy,
    [DramaGenre.Adventure]: StoryGenrePromise.Adventure, [DramaGenre.Survival]: StoryGenrePromise.Adventure,
    [DramaGenre.Wuxia]: StoryGenrePromise.Adventure,
};

const genreContracts: Record<StoryGenrePromise, string> = {
    relationships: "核心关系中的相互欲望、吸引或牵绊与不可兼得的目标持续碰撞，每次选择改变信任、亲密或权力。不能仅以经营项目或完成任务替代关系推进。",
    investigation: "开场出现具体异常或威胁，调查与反制带来新危险、误判及可回溯揭示，揭晓必须改变人物选择。不能只有文件核对和最终口头解释。",
    speculative: "所选题材的非现实机制必须改变欲望、危险、关系和解决路径，并有明确代价。删除该机制后若故事仍完全成立，应重构；不能只给日常职业故事贴超自然身份或未来标签。",
    revenge: "明确不可逆的背叛或损害、具体对手、主角主动反击与对手反制，让对手失去其珍视的控制或利益，让主角获得有代价的胜利。证据、谈判、经营可以是工具，不能把整批候选统一写成取证、开店、投票或学会划清边界；不默认以和解代替复仇兑现。",
    growth: "主角有可观察的能力或处境差距，主动挑战、失败付费、调整策略，再以行动取得变化；胜利同时改变其关系或自我选择，不能只用别人认可代替成长过程。",
    comedy: "人物欲望、认知错位与行动后果构成可持续的喜剧机制，笑点源于选择与反应，升级后仍有清楚的情感和利益目标。",
    adventure: "明确任务、危险环境、资源限制和对抗力量，主角的决定改变生存或任务局面；逐步升级的障碍与代价不能只靠说明交代。",
};

export function dramaGenreContract(genre: DramaGenre, tone: DramaTone) {
    const payoff = tone === DramaTone.Cathartic
        ? "爽感解压必须有当场可见的局面反转、对手代价和主角收益；不能把所有爽点重新解释为克制、退让、互惠或接受现状。"
        : "按所选情感基调落实可见的情绪事件，基调不替代剧情，也不覆盖已选题材。";
    return `题材兑现约定：${genreContracts[dramaGenrePromises[genre]]}\n情绪兑现约定：${payoff}\n本土化、中文表达和制作复杂度均不降低上述戏剧强度；常规制作不等于所有项目都只能用室内谈判、文件和低风险日常事务。`;
}

export const localizedTopicFields = ["locale", "language", "nativeTitle", "nativeLogline", "dramaticEngine", "culturalCausality", "nativeDialogue", "dialogueTranslation"] as const;
export type LocalizedTopic = Record<typeof localizedTopicFields[number], string>;

export function requiresLocalizedTopic(region: DramaRegion | undefined) {
    return region !== undefined && region !== DramaRegion.China && region !== DramaRegion.Fictional;
}

export const localizedTopicInstruction = `本土选题创作顺序（在同一次响应内完成，不调用额外工具）：
1. 按故事发生地落实一个具体国家、城市及角色圈层，并选择角色在该场合实际使用的语言；按该语言先写原创片名和一至两句故事概念，再转写为指定正文语言。中文是呈现层，不从中文短剧标题或关系模板反向翻译。目标市场决定受众叙事包装，不能替换故事发生地或角色身份；多语地区按本故事角色决定语言。
2. 每个候选选定不同的核心欲望、关系结构、对抗策略及反转机制。保留选定题材的强冲突，不能全变成经营、资源协商或关系疗愈；地域真实也不等于每部都写社区生活。标题和对白按本故事语境创作，不用统一的“某人家的某物”“时间/地点归谁”“离开谁以后”句模换名凑批次。
3. 给出一个立即发生的开场冲突，以及双方各一句当地语言对白和对应中文/指定语言表达。人物用各自目的与潜台词交锋，不借人物讲创作道理。对白、片名与故事概念须在语义和人物关系上对应，不能用原文装饰不相干的中文故事。
4. 用简短的本土创作依据说明一条具体的“当地关系或生活机制 → 人物选择 → 对手反制/后果”因果链，不能只写地标、气候和外文姓名。历史/现实事实与虚构机制分开，不声称虚构规则是当地法律或普遍习惯。近未来必须有改变核心冲突的推演，不只加智能设备作装饰。
5. 输出前比较整批候选的冲突机制和结局兑现；对照题材、情感基调与本土因果自行改写不符项，只输出完成稿，不输出审查过程。`;
