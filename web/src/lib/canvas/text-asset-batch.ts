import type { AssetCategory } from "@/lib/asset-category";

export type TextAssetBatchCategory = Extract<AssetCategory, "character" | "environment">;
export type TextAssetSheetType = "character_sheet" | "scene_sheet";

export type TextAssetBatchItem = {
    id: string;
    category: TextAssetBatchCategory;
    title: string;
    prompt: string;
    enabled: boolean;
    /** 用于保存分析阶段生成的完整设定板提示词，生成时优先使用该提示词。 */
    sheetPrompt?: string;
    sheetType?: TextAssetSheetType;
    negativePrompt?: string;
    views?: string[];
    decomposition?: string[];
    props?: string[];
    materials?: string[];
    aliases?: string[];
    summary?: string;
    sourceEvidence?: string;
};

export type TextAssetBatchAnalysisResult = {
    items: TextAssetBatchItem[];
    sourceCount: number;
    mergedCount: number;
};

const CHARACTER_HINTS = ["角色", "人物", "演员", "男主", "女主", "character", "protagonist", "antagonist"];
const ENVIRONMENT_HINTS = ["场景", "环境", "地点", "空间", "室内", "室外", "外景", "建筑", "environment", "location", "interior", "exterior"];
const DETAIL_HEADING = /^(?:身份|性格|外貌|形象|服装|特征|别名|视觉化形象|视觉描述|三视图|提示词|生图提示词|空间|光线|时间|材质|用途|功能|氛围|备注|说明|正文未明确)\s*[:：]?$/;
const SECTION_HEADING = /^(?:\d+[.、]\s*|[一二三四五六七八九十]+[、.]\s*)?(?:角色|人物|场景|环境|地点)(?:资产|设定|列表|清单|信息|提取|汇总|总览)?$/;

export function parseTextAssetBatch(content: string, fallbackTitle = "文本节点"): TextAssetBatchItem[] {
    const lines = content
        .replace(/\r/g, "")
        .split("\n")
        .map((line) => line.replace(/^\s*>\s?/, "").trimEnd());
    const candidates: Array<{ categoryHint: string; title: string; lines: string[] }> = [];
    let section = "";
    let current: { categoryHint: string; title: string; lines: string[] } | null = null;

    const flush = () => {
        if (!current) return;
        const body = current.lines.filter(Boolean);
        if (body.length || current.title) candidates.push({ ...current, lines: body });
        current = null;
    };

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
            if (current?.lines.length && current.lines.at(-1) !== "") current.lines.push("");
            continue;
        }
        const heading = line.match(/^(#{1,6})\s+(.+)$/);
        if (heading) {
            const headingText = cleanMarkdown(heading[2]);
            if (SECTION_HEADING.test(headingText)) {
                flush();
                section = headingText;
                continue;
            }
            if (heading[1].length === 1) {
                flush();
                section = "";
                continue;
            }
            if (current && DETAIL_HEADING.test(headingText)) {
                current.lines.push(`${headingText}：`);
                continue;
            }
            if (heading[1].length === 2 && !section) {
                flush();
                section = headingText;
                continue;
            }
            flush();
            current = { categoryHint: section, title: cleanItemTitle(headingText), lines: [headingText] };
            continue;
        }

        const boldItem = line.match(/^(?:[-*+]\s+)?\*\*(.+?)\*\*\s*[:：-]?\s*(.*)$/);
        const numberedItem = line.match(/^(?:[-*+]\s+)?\d+[.)、]\s+(.+)$/);
        const labeledItem = line.match(/^(?:[-*+]\s+)?(?:角色|人物|场景|环境|地点)\s*[:：]\s*(.+)$/);
        if (labeledItem) {
            flush();
            const title = cleanItemTitle(labeledItem[1].split(/[，,。；;]/)[0]);
            current = { categoryHint: line, title: title || line, lines: [line] };
            continue;
        }
        if (boldItem && (section || current) && !DETAIL_HEADING.test(cleanMarkdown(boldItem[1]))) {
            flush();
            const title = cleanItemTitle(boldItem[1]);
            current = { categoryHint: section, title, lines: [boldItem[2] ? `${title}：${boldItem[2]}` : title] };
            continue;
        }
        if (boldItem && current) {
            current.lines.push(`${cleanMarkdown(boldItem[1])}：${boldItem[2]}`);
            continue;
        }
        if (numberedItem && section && !current) {
            flush();
            const title = cleanItemTitle(numberedItem[1]);
            current = { categoryHint: section, title, lines: [title] };
            continue;
        }
        if (current) current.lines.push(line);
    }
    flush();

    let items = candidates
        .map((candidate, index) => {
            const prompt = cleanPrompt(candidate.lines.join("\n"));
            const category = SECTION_HEADING.test(candidate.categoryHint)
                ? inferCategory(candidate.categoryHint)
                : inferCategory(`${candidate.categoryHint}\n${candidate.title}\n${prompt}`);
            return prompt ? { id: `asset-batch-${index + 1}`, category, title: candidate.title || `资产 ${index + 1}`, prompt, enabled: true } : null;
        })
        .filter((item): item is TextAssetBatchItem => Boolean(item));

    if (!items.length) {
        items = content
            .split(/\n\s*\n/)
            .map((block) => cleanPrompt(block))
            .filter((block) => block.length >= 12)
            .map((prompt, index) => ({
                id: `asset-batch-${index + 1}`,
                category: inferCategory(prompt),
                title: cleanItemTitle(prompt.split("\n")[0]) || `${fallbackTitle} ${index + 1}`,
                prompt,
                enabled: true,
            }));
    }

    const seen = new Set<string>();
    return items.filter((item) => {
        const key = `${item.category}:${item.title}:${item.prompt}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/**
 * 解析资产分析 skill 的严格 JSON 输出。前端正则解析只保留给无模型/模型失败时的手动兜底，
 * 不再作为正常的 Note 拆分路径。
 */
export function parseTextAssetBatchModelJson(text: string, fallbackTitle = "文本节点"): TextAssetBatchAnalysisResult | null {
    const candidates = [
        text.trim(),
        ...Array.from(text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi), (match) => match[1].trim()),
        ...balancedJsonObjects(text),
    ];
    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate) as {
                items?: unknown;
                sourceCount?: unknown;
                mergedCount?: unknown;
            };
            if (!Array.isArray(parsed.items)) continue;
            const items = parsed.items
                .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
                .map((item, index): TextAssetBatchItem | null => {
                    const category = item.category === "environment" ? "environment" : item.category === "character" ? "character" : inferCategory(String(item.summary || item.visualPrompt || item.name || ""));
                    const title = textValue(item.name) || `${fallbackTitle} ${index + 1}`;
                    const sheetType = item.sheetType === "scene_sheet" || item.sheetType === "character_sheet"
                        ? item.sheetType
                        : category === "environment"
                          ? "scene_sheet"
                          : "character_sheet";
                    const sheetPrompt = textValue(item.sheetPrompt) || textValue(item.visualPrompt) || textValue(item.summary);
                    const prompt = sheetPrompt;
                    if (!prompt) return null;
                    const aliases = Array.isArray(item.aliases) ? item.aliases.map(textValue).filter(Boolean).filter((alias) => alias !== title) : [];
                    return {
                        id: `asset-batch-model-${index + 1}`,
                        category,
                        title,
                        prompt,
                        enabled: true,
                        sheetPrompt,
                        sheetType,
                        negativePrompt: textValue(item.negativePrompt),
                        views: textArray(item.views),
                        decomposition: textArray(item.decomposition),
                        props: textArray(item.props),
                        materials: textArray(item.materials),
                        aliases: Array.from(new Set(aliases)),
                        summary: textValue(item.summary),
                        sourceEvidence: textValue(item.sourceEvidence),
                    } satisfies TextAssetBatchItem;
                })
                .filter((item): item is TextAssetBatchItem => item !== null);

            const unique: TextAssetBatchItem[] = [];
            const seen = new Set<string>();
            for (const item of items) {
                const key = `${item.category}:${normalizeAssetKey(item.title)}`;
                if (seen.has(key)) continue;
                seen.add(key);
                unique.push({ ...item, id: `asset-batch-model-${unique.length + 1}` });
            }
            const bounded = unique.slice(0, 60);
            const parsedSourceCount = nonNegativeInteger(parsed.sourceCount);
            const parsedMergedCount = nonNegativeInteger(parsed.mergedCount);
            const sourceCount = bounded.length ? Math.max(bounded.length, parsedSourceCount ?? bounded.length) : parsedSourceCount ?? 0;
            const mergedCount = parsedMergedCount ?? Math.max(0, sourceCount - bounded.length);
            return { items: bounded, sourceCount, mergedCount };
        } catch {
            // Continue with the next JSON candidate.
        }
    }
    return null;
}

export function inferCategory(value: string): TextAssetBatchCategory {
    const normalized = value.toLowerCase();
    const environmentScore = ENVIRONMENT_HINTS.reduce((score, hint) => score + (normalized.includes(hint.toLowerCase()) ? 1 : 0), 0);
    const characterScore = CHARACTER_HINTS.reduce((score, hint) => score + (normalized.includes(hint.toLowerCase()) ? 1 : 0), 0);
    return environmentScore > characterScore ? "environment" : "character";
}

function cleanItemTitle(value: string) {
    return cleanMarkdown(value)
        .replace(/^\s*(?:\d+[.)、]\s*|[-*+]\s+)/, "")
        .replace(/^(?:角色|人物|场景|环境|地点)\s*[:：]\s*/i, "")
        .replace(/[：:]\s*$/, "")
        .trim();
}

function cleanMarkdown(value: string) {
    return value.replace(/[`*_~]/g, "").replace(/\s+/g, " ").trim();
}

function cleanPrompt(value: string) {
    return value
        .split("\n")
        .map((line) => line.replace(/^\s*[-*+]\s+/, "").trim())
        .filter((line) => line && !/^说明\s*[:：]/.test(line))
        .join("\n")
        .trim();
}

function balancedJsonObjects(text: string) {
    const results: string[] = [];
    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (inString) {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') {
            inString = true;
            continue;
        }
        if (char === "{") {
            if (depth === 0) start = index;
            depth += 1;
        } else if (char === "}" && depth > 0) {
            depth -= 1;
            if (depth === 0 && start >= 0) {
                results.push(text.slice(start, index + 1));
                start = -1;
            }
        }
    }
    return results;
}

function textValue(value: unknown) {
    return typeof value === "string" ? value.trim() : value === null || value === undefined ? "" : String(value).trim();
}

function textArray(value: unknown) {
    if (!Array.isArray(value)) return [];
    return value.map(textValue).filter(Boolean);
}

function nonNegativeInteger(value: unknown) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
    return Math.floor(value);
}

function normalizeAssetKey(value: string) {
    return value.trim().toLocaleLowerCase().replace(/[\s\-_/：:，,。.!！？?（）()【】\[\]]/g, "");
}
