import type { AssetSheetKind } from "./asset-reference-sheet";
import { documentSections } from "./asset-sheet-material";

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const lengthUnit = "(?:毫米|厘米|千米|米|mm|cm|km|m)(?![a-zA-Z²2])";
const massUnit = "(?:千克|公斤|克|kg|g|斤)(?![a-zA-Z])";
const amount = (units: string) => new RegExp(`(?:约\\s*)?\\d+(?:\\.\\d+)?\\s*${units}`, "iu");

// Read actual table cells before prose. A row label is never allowed to consume
// the next row's value; optional design/source annotations are not part of it.
export function assetSpecificationValue(content: string, labels: string[]) {
    const text = content.replace(/\*\*|`/g, "");
    const key = `(?:${labels.map(escaped).join("|")})(?:\\s*[（(][^）)\\n]{0,32}[）)])?`;
    const rowLabel = new RegExp(`^${key}$`, "iu");
    for (const line of text.split(/\r?\n/)) {
        if (line.trim().startsWith("|")) {
            const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
            if (cells.length >= 2 && rowLabel.test(cells[0])) return cells[1];
        }
    }
    return new RegExp(`(?:^|[\\s；;，,。])${key}\\s*[:：]\\s*([^；;。\\n|]{1,160})`, "imu").exec(text)?.[1].trim() || "";
}

export function assetSheetSpecificationContent(content: string, kind: AssetSheetKind) {
    const titles = kind === "character" ? ["年龄感、体型、面部与辨识特征"] : kind === "environment" ? ["空间布局、尺度与固定陈设"] : ["道具形状、尺寸、比例与辨识特征"];
    const section = documentSections(content).find(({ title }) => titles.includes(title));
    return section ? section.lines.slice(1).join("\n") : content;
}

export function assetSheetDimensions(content: string, kind: AssetSheetKind) {
    const text = assetSheetSpecificationContent(content, kind).replace(/[*]/g, "");
    const result: string[] = [];
    const add = (label: string, aliases: string[], units = lengthUnit) => {
        const value = assetSpecificationValue(text, [label, ...aliases]);
        const numeric = amount(units).exec(value)?.[0]
            || new RegExp(`(?:${[label, ...aliases].map(escaped).join("|")})\\s*[:：]?\\s*(${amount(units).source})`, "iu").exec(text)?.[1];
        if (numeric) result.push(`${label}：${numeric}`);
    };
    if (kind === "character") {
        add("身高", ["净身高", "height"]);
        add("体重", ["weight"], massUnit);
        for (const label of ["肩宽", "胸围", "腰围", "臀围"]) add(label, []);
        const triple = assetSpecificationValue(text, ["三围"]);
        if (/\d+(?:\.\d+)?\s*(?:mm|cm|厘米|毫米)?\s*[/、,，×xX]\s*\d+(?:\.\d+)?\s*(?:mm|cm|厘米|毫米)?\s*[/、,，×xX]\s*\d+(?:\.\d+)?\s*(?:mm|cm|厘米|毫米)/iu.test(triple)) result.push(`三围：${triple}`);
    } else {
        add("长", ["长度", "length"]);
        add("宽", ["宽度", "width"]);
        add("高", ["净高", "层高", "高度", "height"]);
        add("直径", ["跨度", "depth"]);
        add("面积", ["占地面积", "建筑面积", "area"], "(?:平方米|平米|m²|m2|㎡)");
        const combined = assetSpecificationValue(text, ["长宽高", "长×宽×高", "外形尺寸", "空间尺寸"]);
        if (!["长：", "宽：", "高："].every((prefix) => result.some((entry) => entry.startsWith(prefix))) && /\d/u.test(combined) && amount(lengthUnit).test(combined)) result.push(`长×宽×高：${combined}`);
    }
    return result;
}
