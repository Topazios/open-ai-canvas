import type { AssetSheetKind } from "./asset-reference-sheet";

export function assetSheetDimensions(content: string, kind: AssetSheetKind) {
    const text = content.replace(/[*]/g, "").replace(/\s+/g, " ");
    const units = "(?:毫米|厘米|米|mm|cm|m|千克|公斤|kg|斤)";
    const amount = "(?:约\\s*)?\\d+(?:\\.\\d+)?\\s*" + units;
    const matches = (pattern: RegExp) => [...text.matchAll(pattern)].map((match) => match[0].trim());
    if (kind === "character") return [...new Set([
        ...matches(new RegExp("(?:身高|height)\\s*[:：]?\\s*" + amount, "giu")),
        ...matches(new RegExp("(?:体重|weight)\\s*[:：]?\\s*" + amount, "giu")),
        ...matches(new RegExp("(?:三围|胸围|腰围|臀围|肩宽)\\s*[:：]?\\s*" + amount + "(?:\\s*[/、,，×xX]\\s*" + amount + "){0,2}", "giu")),
    ])].slice(0, 6);
    return [...new Set([
        ...matches(new RegExp("(?:长|长度|length)\\s*[:：]?\\s*" + amount, "giu")),
        ...matches(new RegExp("(?:宽|宽度|width)\\s*[:：]?\\s*" + amount, "giu")),
        ...matches(new RegExp("(?:净高|层高|高度|高|height)\\s*[:：]?\\s*" + amount, "giu")),
        ...matches(/(?:面积|占地面积|建筑面积|area)\s*[:：]?\s*\d+(?:\.\d+)?\s*(?:平方米|平米|m²|㎡)/giu),
        ...matches(new RegExp("(?:直径|跨度|depth)\\s*[:：]?\\s*" + amount, "giu")),
    ])].slice(0, 8);
}
