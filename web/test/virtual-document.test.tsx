import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasVirtualDocument, CanvasVirtualDocumentView } from "../src/components/canvas/canvas-virtual-document";
import { parseVirtualDocument, previewDocumentSource } from "../src/lib/canvas/virtual-document";

test("table rows retain escaped pipes, inline content and exact source offsets", () => {
    const source = "# 总表\r\n\r\n| 编码 | 名称 |\r\n| --- | --- |\r\n| CHR-001 | **林岚**\\|少年<br>时期 |\r\n\r\n结尾。";
    const blocks = parseVirtualDocument(source);
    const row = blocks.find((block) => block.table && !block.header)!;
    expect(row.cells).toEqual(["CHR-001", "林岚|少年\n时期"]);
    expect(source.slice(row.start, row.end)).toBe("| CHR-001 | **林岚**\\|少年<br>时期 |");
    expect(blocks.at(-1)?.text).toBe("结尾。");
    expect(source).toContain("**林岚**");
});

test("a very long table renders a bounded viewport rather than all its DOM rows", () => {
    const source = "| 序号 | 名称 | 剧情功能 |\n| --- | --- | --- |\n" + Array.from({ length: 5000 }, (_, i) => `| ${i + 1} | 人物${i + 1} | ${"连续行动与人物选择。".repeat(8)} |`).join("\n");
    expect(source.length).toBeGreaterThan(400000);
    const blocks = parseVirtualDocument(source);
    expect(blocks).toHaveLength(5001);
    const html = renderToStaticMarkup(<CanvasVirtualDocumentView blocks={blocks} />);
    const mounted = (html.match(/data-index=/g) ?? []).length;
    expect(mounted).toBeGreaterThan(1);
    expect(mounted).toBeLessThan(40);
    expect(html).toContain("人物1");
    expect(html).not.toContain("人物5000");
    expect(html).toContain("360px");
    expect(html).toContain("40px");
    expect(html).toContain('aria-expanded="false"');
    expect(blocks.at(-1)?.cells?.[1]).toBe("人物5000");
}, 20000);

test("large source does not synchronously parse or render inside the UI wrapper", () => {
    const html = renderToStaticMarkup(<CanvasVirtualDocument source={"| 保留完整原文 |\n".repeat(10000)} />);
    expect(html).toContain("正在打开文稿");
    expect(html).not.toContain("data-index=");
});

test("node previews cap parsing without losing the full document source", () => {
    const source = "正文一行。\n".repeat(6000);
    const preview = previewDocumentSource(source);
    expect(preview.length).toBeLessThan(6100);
    expect(source.length).toBeGreaterThan(24000);
    expect(previewDocumentSource("小文稿")).toBe("小文稿");
});

test("large lists are virtualized by item rather than mounted as a single block", () => {
    const source = Array.from({ length: 3000 }, (_, i) => `- 第${i + 1}项说明`).join("\n");
    expect(parseVirtualDocument(source)).toHaveLength(3000);
});

test("a pathological long paragraph is split without losing text or emoji boundaries", () => {
    const source = "连贯正文😀".repeat(10000);
    const blocks = parseVirtualDocument(source);
    expect(blocks.length).toBeGreaterThanOrEqual(10);
    expect(blocks.every((block) => block.plain && block.text.length <= 6000)).toBe(true);
    expect(blocks.map((block) => block.text).join("")).toBe(source);
    expect(blocks.every((block) => !/[\uD800-\uDBFF]$/.test(block.text))).toBe(true);
});
