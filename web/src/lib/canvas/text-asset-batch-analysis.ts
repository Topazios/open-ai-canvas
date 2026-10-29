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
                    "priority",
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
                    priority: { type: "integer", minimum: 1, maximum: 60, description: "同一类别中的剧情重要性排名，1最重要且不得重复" },
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
- 先分析并归并实体，再按剧情主次排序并输出固定 JSON；priority 必须在同类别内从 1 开始连续且唯一，1 最重要。人物按主线驱动者、核心对手/共同主角、主要配角、次要角色、群演排序；场景按主线核心、反复出现、高潮空间到次要空间排序；不得按名称、来源顺序或模型输出习惯随机排列；
- 每个实体都要准备一张完整设定板的生图提示词 sheetPrompt：参考用户示例的浅暖灰底、细边框、左侧资料栏、右侧多区域视图标签和清晰分隔线；人物为左侧肖像/资料、右上四视图、右下服装/道具/细节，场景为左侧空间缩略图/资料、右上主视角/正立面/侧剖面/俯视平面、右下空间拆解/尺寸/动线/道具/材质；必须一次生成整张图，禁止只画素材供程序切图拼版；
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
