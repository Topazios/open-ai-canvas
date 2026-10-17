import { productionRuleCatalog } from "./production-rules.generated";
import type { ShortDramaStageId } from "./short-drama-stages";

export const PRODUCTION_RULES_VERSION = productionRuleCatalog.version;
export type ProductionRuleMode = keyof typeof productionRuleCatalog.media;

export function productionRuleBlock(stage: ShortDramaStageId, mode: ProductionRuleMode) {
    if (stage === "assets" && mode === "image") {
        return [`【制作执行规范 v${PRODUCTION_RULES_VERSION} · assets/image】`, ...productionRuleCatalog.assetImage, "【制作执行规范结束】"].join("\n");
    }
    return [`【制作执行规范 v${PRODUCTION_RULES_VERSION} · ${stage}/${mode}】`, ...productionRuleCatalog.common,
        ...productionRuleCatalog.stages[stage], ...productionRuleCatalog.media[mode], "【制作执行规范结束】"].join("\n");
}

export function applyProductionRules(prompt: string, stage: ShortDramaStageId, mode: ProductionRuleMode) {
    if (mode === "audio") return prompt;
    const block = productionRuleBlock(stage, mode);
    if (prompt.startsWith(block + "\n\n")) return prompt;
    if (stage === "assets" && mode === "image") {
        const header = `【制作执行规范 v${PRODUCTION_RULES_VERSION} · assets/image】\n`;
        const end = "\n【制作执行规范结束】\n\n";
        while (prompt.startsWith(header)) {
            const index = prompt.indexOf(end);
            if (index < 0) break;
            prompt = prompt.slice(index + end.length);
        }
    }
    return block + "\n\n" + prompt;
}
