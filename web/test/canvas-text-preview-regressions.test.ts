import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasNodeActionBar } from "../src/components/canvas/canvas-node-action-bar";
import { canvasThemes } from "../src/lib/canvas-theme";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

const component = (name: string) => readFileSync(new URL(`../src/components/canvas/${name}.tsx`, import.meta.url), "utf8");

test("real node toolbar renders the full count beside actions in both themes", () => {
    const node = { id: "text", title: "规范", type: CanvasNodeType.Text, metadata: { content: "正文".repeat(50000) } } as CanvasNodeData;
    for (const theme of [canvasThemes.light, canvasThemes.dark]) {
        const html = renderToStaticMarkup(createElement(CanvasNodeActionBar, { node, theme, onOpenTextEditor: () => {} }));
        expect(html).toContain("100,000");
        expect(html).toContain('aria-label="文稿字数"');
        expect(html).toContain('aria-label="编辑"');
        expect(html).not.toContain("正文");
    }
});

test("node previews count the entire source without parsing long documents", () => {
    const source = component("canvas-node-action-bar");
    expect(source).toContain('aria-label="文稿字数"');
    expect(source).toContain('(node.metadata?.content?.length ?? 0).toLocaleString("zh-CN")');
    expect(source).toContain("ml-auto shrink-0 whitespace-nowrap");
});

test("preview count remains visible at narrow widths and refreshes after editor hydration", () => {
    const source = component("canvas-text-editor-modal");
    const counter = source.slice(source.indexOf('<span className="shrink-0 text-[var(--fs-label)]"'), source.indexOf("词</span>"));
    expect(counter).toContain('aria-label="文稿字数"');
    expect(counter.split(">")[0]).not.toContain("hidden");
    expect(source).toContain("setTextRevision((value) => value + 1)");
    expect(component("canvas-large-text-document")).toContain('content.length.toLocaleString("zh-CN")');
});

test("viewing or renaming a document does not serialize its Markdown again", () => {
    const source = component("canvas-text-editor-modal");
    expect(source).toContain('const source = contentEditedRef.current && markdownMode === "visual" ? canvasRichTextMarkdown(editor.getJSON()) : markdownContent');
    expect(source).toContain("if (contentEditedRef.current && editor) setMarkdownContent");
    const titleChange = source.slice(source.indexOf("value={title}"), source.indexOf('placeholder="文本节点标题"'));
    expect(titleChange).not.toContain("contentEditedRef.current = true");
});
