import type { AiConfig } from "@/stores/use-config-store";
import { runBackendGenerationTask } from "@/services/api/generation-task";
import { parseTextAssetBatchModelJson, type TextAssetBatchAnalysisResult } from "@/lib/canvas/text-asset-batch";
import { skillRuntime } from "@/services/skill-runtime";
import { getSkill, type Skill } from "@/services/api/skills";

export const TEXT_ASSET_ANALYSIS_SKILL_ID = "builtin-canvas-asset-inventory";
export const TEXT_ASSET_ANALYSIS_RESPONSE_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["sourceCount", "mergedCount", "items"],
    properties: {
        sourceCount: { type: "integer", minimum: 0 },
        mergedCount: { type: "integer", minimum: 0 },
        items: {
            type: "array",
            maxItems: 60,
            items: {
                type: "object",
                additionalProperties: false,
                required: [
                    "category",
                    "name",
                    "aliases",
                    "summary",
                    "visualPrompt",
                    "sheetType",
                    "sheetPrompt",
                    "negativePrompt",
                    "views",
                    "decomposition",
                    "props",
                    "materials",
                    "sourceEvidence",
                ],
                properties: {
                    category: { type: "string", enum: ["character", "environment"] },
                    name: { type: "string" },
                    aliases: { type: "array", items: { type: "string" } },
                    summary: { type: "string" },
                    visualPrompt: { type: "string" },
                    sheetType: { type: "string", enum: ["character_sheet", "scene_sheet"] },
                    sheetPrompt: { type: "string" },
                    negativePrompt: { type: "string" },
                    views: { type: "array", maxItems: 8, items: { type: "string" } },
                    decomposition: { type: "array", maxItems: 8, items: { type: "string" } },
                    props: { type: "array", maxItems: 12, items: { type: "string" } },
                    materials: { type: "array", maxItems: 12, items: { type: "string" } },
                    sourceEvidence: { type: "string" },
                },
            },
        },
    },
} satisfies Record<string, unknown>;

const MAX_ANALYSIS_INPUT_CHARS = 60_000;
const MAX_ANALYSIS_OUTPUT_TOKENS = 8_192;
let builtinAssetSkillRequest: Promise<Skill> | null = null;

function loadBuiltinAssetSkill() {
    if (!builtinAssetSkillRequest) {
        builtinAssetSkillRequest = getSkill(TEXT_ASSET_ANALYSIS_SKILL_ID)
            .then(({ skill }) => skill)
            .catch((error) => {
                // 不缓存一次性的网络或后端同步失败，允许用户点击重试恢复。
                builtinAssetSkillRequest = null;
                throw error;
            });
    }
    return builtinAssetSkillRequest;
}

export async function analyzeTextAssetBatch(input: {
    content: string;
    config: AiConfig;
    projectId: string;
    skills?: Skill[];
    selectedSkillIds?: string[];
}): Promise<TextAssetBatchAnalysisResult> {
    const model = input.config.textModel || input.config.model;
    if (!model) throw new Error("当前没有可用的文本分析模型，请先在模型设置中选择文本模型");
    const content = input.content.trim();
    if (!content) return { items: [], sourceCount: 0, mergedCount: 0 };
    const analysisContent = content.length <= MAX_ANALYSIS_INPUT_CHARS
        ? content
        : `${content.slice(0, 48_000)}\n\n[中间内容过长，已省略；请只基于当前可见文本输出稳定、可复用的角色和场景]\n\n${content.slice(-12_000)}`;
    const builtinSkill = await loadBuiltinAssetSkill();
    const taskPrompt = `请使用已加载的影视角色与场景资产设定板 Skill 分析下面的 Note。

本次任务要求：
- 先分析并归并实体，再输出固定 JSON；
- 每个实体都要准备一张可直接用于生图的设定板 sheetPrompt；
- 只基于 Note、用户选择的 Skill 和项目画风生成内容，不要臆造额外资产；
- 不要返回 JSON 以外的解释或 Markdown。

<note>
${analysisContent}
</note>`;
    const preparedSkill = await skillRuntime.prepare({
        profile: "canvas",
        prompt: taskPrompt,
        skills: [builtinSkill, ...(input.skills || [])],
        selectedSkillIds: input.selectedSkillIds,
        systemSkillIds: [TEXT_ASSET_ANALYSIS_SKILL_ID],
    });
    const result = await runBackendGenerationTask({
        projectId: input.projectId,
        mode: "text",
        prompt: `${preparedSkill?.prompt || taskPrompt}\n\n待分析 Note：\n<note>\n${analysisContent}\n</note>`,
        config: { ...input.config, model, textModel: model },
        streamText: true,
        maxOutputTokens: MAX_ANALYSIS_OUTPUT_TOKENS,
        structuredOutput: {
            name: "canvas_asset_inventory",
            schema: TEXT_ASSET_ANALYSIS_RESPONSE_SCHEMA,
            strict: true,
        },
        metadata: { source: "canvas-text-asset-analysis", skillId: TEXT_ASSET_ANALYSIS_SKILL_ID },
    });
    const parsed = parseTextAssetBatchModelJson(result.text || "", "资产");
    if (!parsed) throw new Error("文本模型返回的资产清单格式无法识别，请重试");
    return parsed;
}
