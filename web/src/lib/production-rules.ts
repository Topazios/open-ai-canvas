import { productionRuleCatalog } from "./production-rules.generated";
import type { ShortDramaStageId } from "./short-drama-stages";

export const PRODUCTION_RULES_VERSION = productionRuleCatalog.version;
export type ProductionRuleMode = keyof typeof productionRuleCatalog.media;

export function productionRuleBlock(stage: ShortDramaStageId, mode: ProductionRuleMode) {
    return [`【制作执行规范 v${PRODUCTION_RULES_VERSION} · ${stage}/${mode}】`, ...productionRuleCatalog.common,
        ...productionRuleCatalog.stages[stage], ...productionRuleCatalog.media[mode], "【制作执行规范结束】"].join("\n");
}

export function applyProductionRules(prompt: string, stage: ShortDramaStageId, mode: ProductionRuleMode) {
    if (mode === "audio") return prompt;
    const block = productionRuleBlock(stage, mode);
    return prompt.startsWith(block + "\n\n") ? prompt : block + "\n\n" + prompt;
}
