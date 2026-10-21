import { dramaDurationSeconds, type ShortDramaGlobalSettings } from "../short-drama-settings";

export type BodyWritingSpec = {
    version: 2;
    minSeconds: number;
    maxSeconds: number;
    targetSeconds: number;
    language: string;
};

export const bodyWritingRequirement = "依据本集集纲扩写可直接表演、配音和拍摄的完整场次剧本，不是剧情摘要或分镜表。每集呈现开场异常/冲突、明确目标、行动与阻力、升级或揭示、结果与结尾钩子，保留集纲因果和跨集边界。按场次、时间地点、人物动作、对白、必要旁白和声音组织；同一场可以容纳多个戏剧节拍，不为凑场次数换景。每个节拍写清可见行动、对方反应和局面变化，重要对话写出交锋过程，不能用“争执一番”“得知真相”等概述代替。对白驱动项目应展开真实对白，旁白驱动项目应写出完整解说并配套画面，混合叙事避免重复。禁止靠长停顿、空镜、慢动作、重复解释或虚标时长填满一集；资产编码和简短状态说明与戏剧正文分开，不重复资产档案、生图提示词或制作规范。";

export function bodyWritingSpec(minutes: string, settings?: ShortDramaGlobalSettings): BodyWritingSpec {
    const configured = settings && dramaDurationSeconds[settings.duration];
    // Legacy briefs store minutes as text; global settings use the duration enum.
    const match = minutes.trim().match(/^(\d+(?:\.\d+)?)\s*(?:[-–—~～至]\s*(\d+(?:\.\d+)?))?\s*(秒|s|分钟|分|m)?$/i);
    const scale = match?.[3] === "秒" || match?.[3]?.toLowerCase() === "s" ? 1 : 60;
    const min = configured?.min ?? (match ? Number(match[1]) * scale : NaN);
    const max = configured?.max ?? (match ? Number(match[2] || match[1]) * scale : NaN);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 10 || max < min || max > 3600) throw new Error("单集时长无效，请在全局设置中选择有效时长");
    return { version: 2, minSeconds: Math.round(min), maxSeconds: Math.round(max), targetSeconds: Math.round((min + max) / 2), language: settings?.language || "zh-CN" };
}

export function bodyWritingPrompt(spec: BodyWritingSpec) {
    const characterBased = /^(zh|ja|ko|th)/.test(spec.language);
    const unit = characterBased ? "字" : "词";
    const low = Math.round(spec.targetSeconds / 60 * (characterBased ? 450 : 180));
    const high = Math.round(spec.targetSeconds / 60 * (characterBased ? 700 : 280));
    return `【本集正文时长与展开要求】
单集范围 ${spec.minSeconds}–${spec.maxSeconds} 秒，以约 ${spec.targetSeconds} 秒设计，不默认压到下限。时长仅为创作估算，配音、表演和剪辑后仍需实测。
正文中的动作、对白和必要旁白建议约 ${low}–${high} ${unit}，不计标题、资产清单和制作附录；这是展开程度参考而非凑字数或实际时长证明。集纲的150–250字限制不适用于正文。
先在内部安排开场、目标建立、行动受阻、冲突升级、结果与钩子的节奏，再交付完整正文，不输出内部规划。前3秒引出异常/冲突，前15秒建立处境；中段至少有明确的行动、反应和局面变化，结尾完成本集变化并承接下一集，不提前消耗后集情节。
先写完整行动与交锋，再依据实际朗读、独立动作及有意义的反应估时，不先分配秒数再凑内容。每个连续节拍在动作/对白前使用独立一行“【节拍时长：N秒】”（N 为正整数），不设单段最短秒数，不把各段平均分配；短促反应可以只有1–3秒，不强拉到7秒或十几秒。不要另给重复的逐镜头时间表。
逐段内部核对：对白先按自然语速试读，结合口吻和情绪留出必要反应；动作与对白同时发生的部分不重复累计。人物的站位、衣着、布景颜色等静态事实只描述画面，不消耗额外表演时间。举相机、点头、放下手等瞬间动作不单独拉长。
“两人沉默”“停顿”“看着对方”不能充当补时器。需要留白时，写清谁先做什么、另一人如何回应、关系或信息因此怎样改变；不是加几句形容词或机械多加对白。行动引发可见反应，反应再影响下一步选择，才构成可拍的因果链；按本集剧情展开，不套用其他项目的情节。
对白按角色口吻完整展开，重要对话有具体诉求、应对或回避及后果；无对白段也要写清持续发生的行动和变化。若现有内容自然只能演3–4秒，就缩短该节拍，不虚标为7–11秒；若整集不足，则在本集集纲边界内补足导致结果的行动、阻力、对话交锋和选择，不靠沉默、慢动作、重复信息或后集剧情凑时长。全部节拍估时之和仍应在单集范围内，字数只作参考，不能替代逐段节奏判断。
涉及空间变化时写清人物相对位置、移动方向、谁向谁靠近或远离、接触是否发生及物件归属，不让未移动的人突然换位；人物自身左右与空间方位分开。正文保留叙事所需的相对关系即可，摄影机景别、人物占幅与技术距离由后续分镜设计，不堆砌摄影参数。
声音只补充画面，旁白不复述同一信息。不得以资产附录、约XX秒的声明或大段技术说明替代剧情。
只输出本集完整剧本，不附自我评价，不改变既定身份、声音、规则、结局和集纲边界。`;
}
