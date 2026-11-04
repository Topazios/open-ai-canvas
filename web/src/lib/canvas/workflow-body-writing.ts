import { dramaDurationSeconds, type ShortDramaGlobalSettings } from "../short-drama-settings";

export type BodyWritingSpec = {
    version: 2;
    minSeconds: number;
    maxSeconds: number;
    targetSeconds: number;
    language: string;
};

export const bodyWritingRequirement = "依据本集集纲写成完整、连贯、细节充分的小说式正文，不是剧情摘要、场次剧本或分镜表。用自然段和必要对白讲清本集开端、人物目标、行动与阻力、冲突升级、选择及后果、结尾变化或钩子，保留集纲因果和跨集边界。写出人物的神态、情绪变化、动作、反应、关系变化与真实交锋；重要事件展开过程，不以“争执一番”“得知真相”等概述带过。交代叙事所需的空间关系、环境感受、道具如何被拿取、使用、交接及状态变化，让剧情因果和动作逻辑可理解。对白驱动项目展开真实对白，旁白驱动项目写出完整解说，混合叙事避免重复。正文不按场次/镜头表格式编排，不写镜号、景别、机位、镜头参数、剪辑点、逐段演出秒数或拍摄指令；这些由后续场次与分镜阶段拆解。不得靠重复解释或无因果描写凑篇幅；不重复资产档案、生图提示词或制作规范。";

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
    return `【本集小说正文写作要求】
本集目标成片时长为 ${spec.minSeconds}–${spec.maxSeconds} 秒，中心参考约 ${spec.targetSeconds} 秒。该范围用于控制剧情体量，不是正文分段时长表，也不能据此虚报实际成片时长；配音、表演、剪辑时长留待下游实测。
正文建议约 ${low}–${high} ${unit}，不计标题与制作附录。该范围只用于避免内容过短或过度膨胀，不以凑字数代替完整叙事；集纲的150–250字限制不适用于正文。
先在内部梳理开场钩子、人物处境与目标、行动受阻、冲突升级、关键选择、结果和结尾钩子，再写成自然连贯的小说正文，不输出内部规划。尽早呈现异常或冲突，清楚交代观众理解后续所需的信息；中段通过行动、反应和局面变化推进，结尾完成本集应有的变化并承接后续，不提前消耗后集情节。
使用连贯自然段叙述，不将每个动作切成镜头式短句。通过具体行为、神态、语气、身体反应、心理变化和人物之间的应对体现情绪，不只贴情绪标签。关键对白写完整交锋过程，包括各自诉求、回避或反击、信息变化及其对选择的影响；不以“争执一番”“得知真相”等概述替代情节。动作要写清起因、执行、对象反应和结果。
写清支撑剧情理解所必需的空间关系、人物移动、接触、视线对象，以及道具的拿取、使用、交接、放置、损坏和前后状态。动作、人物位置与物件状态不得无故跳变；涉及多人和多件物品时，明确归属和相互关系。环境细节应参与人物感受或剧情，不堆砌静态陈设。
遵循已提供集纲、总纲、人物与世界规则，保留因果和跨集边界；不得擅自改变身份、关系、已知信息、能力限制、结局或另添关键事实。资料不足时避免把推测写成既定设定。
正文不使用“第几场/内外景/时间地点/人物表”等拍摄稿模板，不写镜号、景别、机位、构图参数、镜头运动、焦段/光圈/快门、灯位、剪辑点、节拍秒数或分段演出时长。小说叙事需要的地点、时间和空间信息仍应自然写入正文；其拍摄化组织由后续场次与分镜阶段完成。
旁白只在项目叙事需要时使用，不复述画面和已说出的信息。不得靠重复解释、空泛心理、无因果动作或无意义环境描写凑长度。
只输出本集完整小说正文，不附分镜表、自我评价或制作说明。`;
}
