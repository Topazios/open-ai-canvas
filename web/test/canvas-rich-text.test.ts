import { expect, test } from "bun:test";
import { canvasRichTextMarkdown, markdownToCanvasRichTextHTML } from "@/lib/canvas/canvas-rich-text";

test("Markdown source is converted to editable HTML including GFM tables", () => {
    const html = markdownToCanvasRichTextHTML("# 标题\n\n| 名称 | 状态 |\n| --- | --- |\n| 角色 | 已完成 |");

    expect(html).toContain("<h1>标题</h1>");
    expect(html).toContain("<table>");
    expect(html).toContain("<td>角色</td>");
});

test("visual editor JSON is written back as Markdown", () => {
    const markdown = canvasRichTextMarkdown({
        type: "doc",
        content: [
            { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "章节" }] },
            { type: "paragraph", content: [{ type: "text", text: "重点", marks: [{ type: "bold" }] }] },
            {
                type: "table",
                content: [
                    {
                        type: "tableRow",
                        content: [
                            { type: "tableHeader", content: [{ type: "text", text: "字段" }] },
                            { type: "tableHeader", content: [{ type: "text", text: "值" }] },
                        ],
                    },
                    {
                        type: "tableRow",
                        content: [
                            { type: "tableCell", content: [{ type: "text", text: "状态" }] },
                            { type: "tableCell", content: [{ type: "text", text: "完成" }] },
                        ],
                    },
                ],
            },
        ],
    });

    expect(markdown).toContain("## 章节");
    expect(markdown).toContain("**重点**");
    expect(markdown).toContain("| 字段 | 值 |");
    expect(markdown).toContain("| 状态 | 完成 |");
});
