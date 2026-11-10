import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[]; position?: { start: { offset?: number }; end: { offset?: number } } };
export type DocumentTable = { id: number; headers: string[]; widths: number[] };
export type DocumentBlock = { id: number; start: number; end: number; text: string; table?: DocumentTable; cells?: string[]; header?: boolean; plain?: boolean };
export const largeDocumentThreshold = 24000;

function plainText(node: MarkdownNode): string {
    if (node.type === "break") return "\n";
    if (node.type === "html" && /^<br\s*\/?\s*>$/i.test(node.value ?? "")) return "\n";
    return node.value ?? node.children?.map(plainText).join("") ?? "";
}

function columnWidth(title: string) {
    if (/序号|主次/.test(title)) return 80;
    if (/编码|集号|类别|处理/.test(title)) return 160;
    if (/名称|需求|主体|集数|集段|前置/.test(title)) return 220;
    return 360;
}

// Parse once, but flatten tables into rows so a large table never becomes one
// enormous mounted editor node. Offsets always refer to the untouched source.
export function parseVirtualDocument(source: string): DocumentBlock[] {
    const tree = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
    const blocks: DocumentBlock[] = [];
    const addText = (start: number, end: number) => {
        if (end - start <= 12000) {
            blocks.push({ id: blocks.length, start, end, text: source.slice(start, end) });
            return;
        }
        // Pathological single paragraphs/code blocks also need bounded DOM.
        // Exact source is retained; split fragments render as unformatted text.
        for (let at = start; at < end;) {
            let to = Math.min(at + 6000, end);
            if (to < end && /[\uD800-\uDBFF]/.test(source[to - 1])) to--;
            blocks.push({ id: blocks.length, start: at, end: to, text: source.slice(at, to), plain: true });
            at = to;
        }
    };
    for (const node of tree.children as MarkdownNode[]) {
        const start = node.position?.start.offset ?? 0;
        const end = node.position?.end.offset ?? start;
        if (node.type === "table" && node.children?.length) {
            const headers = node.children[0].children?.map(plainText) ?? [];
            const table = { id: start, headers, widths: headers.map(columnWidth) };
            for (const [index, row] of node.children.entries()) {
                blocks.push({ id: blocks.length, start: row.position?.start.offset ?? start, end: row.position?.end.offset ?? end, text: "", table, header: index === 0, cells: row.children?.map(plainText) ?? [] });
            }
        } else if (node.type === "list" && node.children?.length) {
            for (const item of node.children) {
                const itemStart = item.position?.start.offset ?? start;
                const itemEnd = item.position?.end.offset ?? end;
                addText(itemStart, itemEnd);
            }
        } else {
            addText(start, end);
        }
    }
    return blocks;
}

export function previewDocumentSource(source: string) {
    if (source.length <= largeDocumentThreshold) return source;
    const end = source.lastIndexOf("\n", 6000);
    return source.slice(0, end > 0 ? end : 6000) + "\n\n…";
}
