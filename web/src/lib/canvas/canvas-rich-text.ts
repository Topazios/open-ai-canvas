import type { JSONContent } from "@tiptap/core";
import { generateHTML } from "@tiptap/core";
import CharacterCount from "@tiptap/extension-character-count";
import Color from "@tiptap/extension-color";
import Highlight from "@tiptap/extension-highlight";
import Placeholder from "@tiptap/extension-placeholder";
import TextAlign from "@tiptap/extension-text-align";
import { TextStyle } from "@tiptap/extension-text-style";
import { TableKit } from "@tiptap/extension-table";
import StarterKit from "@tiptap/starter-kit";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { toHast } from "mdast-util-to-hast";
import { toHtml } from "hast-util-to-html";
import { gfm } from "micromark-extension-gfm";

export function createCanvasRichTextExtensions(placeholder?: string) {
    return [
        StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false, autolink: true } }),
        TextAlign.configure({ types: ["heading", "paragraph"] }),
        TextStyle,
        Color.configure({ types: ["textStyle"] }),
        Highlight.configure({ multicolor: true }),
        TableKit.configure({ table: { resizable: true, renderWrapper: true, cellMinWidth: 96 } }),
        CharacterCount,
        ...(placeholder ? [Placeholder.configure({ placeholder })] : []),
    ];
}

export function canvasRichTextHTML(document?: Record<string, unknown>) {
    if (!document) return "";
    try {
        // 仅接受 Tiptap 结构化 JSON，不启用原始 HTML；输出链接再按协议收口。
        const template = window.document.createElement("template");
        template.innerHTML = generateHTML(document as JSONContent, createCanvasRichTextExtensions());
        template.content.querySelectorAll("a[href]").forEach((link) => {
            if (!isSafeCanvasRichTextLink(link.getAttribute("href") || "")) link.removeAttribute("href");
        });
        return template.innerHTML;
    } catch {
        return "";
    }
}

/** Convert Markdown source to the HTML accepted by the visual editor. */
export function markdownToCanvasRichTextHTML(source: string) {
    if (!source.trim()) return "<p></p>";
    try {
        const tree = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
        return toHtml(toHast(tree, { allowDangerousHtml: false }));
    } catch {
        return `<p>${escapeHTML(source)}</p>`;
    }
}

/** Serialize the visual editor document back to Markdown for canvas storage. */
export function canvasRichTextMarkdown(document?: JSONContent) {
    if (!document) return "";
    return serializeBlocks(document.content || []).trim();
}

function serializeBlocks(nodes: JSONContent[], prefix = "") {
    return nodes
        .map((node) => serializeBlock(node, prefix))
        .filter(Boolean)
        .join("\n\n");
}

function serializeBlock(node: JSONContent, prefix = ""): string {
    const children = node.content || [];
    switch (node.type) {
        case "doc":
            return serializeBlocks(children, prefix);
        case "paragraph":
            return prefix + serializeInline(children);
        case "heading":
            return prefix + `${"#".repeat(Math.min(6, Math.max(1, Number(node.attrs?.level) || 1)))} ${serializeInline(children)}`;
        case "blockquote":
            return serializeBlocks(children)
                .split("\n")
                .map((line) => `> ${line}`)
                .join("\n");
        case "bulletList":
            return serializeList(children, false, prefix);
        case "orderedList":
            return serializeList(children, true, prefix);
        case "codeBlock": {
            const language = typeof node.attrs?.language === "string" && node.attrs.language ? node.attrs.language : "";
            const value = children.map((child) => child.text || "").join("");
            return `${prefix}\`\`\`${language}\n${value.replace(/\n+$/, "")}\n\`\`\``;
        }
        case "horizontalRule":
            return `${prefix}---`;
        case "table":
            return serializeTable(children, prefix);
        case "image":
            return `${prefix}![${String(node.attrs?.alt || "")}](${String(node.attrs?.src || "")}${node.attrs?.title ? ` \"${String(node.attrs.title)}\"` : ""})`;
        case "hardBreak":
            return "\n";
        default:
            return prefix + serializeInline(children);
    }
}

function serializeList(items: JSONContent[], ordered: boolean, prefix: string) {
    return items
        .map((item, index) => {
            const body = (item.content || []).map((child) => (child.type === "paragraph" ? serializeInline(child.content || []) : serializeBlock(child))).join("\n");
            const marker = ordered ? `${index + 1}. ` : "- ";
            return `${prefix}${marker}${body.replace(/\n/g, `\n${prefix}${" ".repeat(marker.length)}`)}`;
        })
        .join("\n");
}

function serializeTable(rows: JSONContent[], prefix: string) {
    const values = rows.map((row) =>
        (row.content || []).map((cell) =>
            serializeInline(cell.content || [])
                .replace(/\|/g, "\\|")
                .replace(/\n/g, " ")
                .trim(),
        ),
    );
    if (!values.length) return "";
    const width = Math.max(...values.map((row) => row.length), 1);
    const normalized = values.map((row) => [...row, ...Array.from({ length: width - row.length }, () => "")]);
    const line = (row: string[]) => `${prefix}| ${row.join(" | ")} |`;
    return [line(normalized[0]), line(normalized[0].map(() => "---")), ...normalized.slice(1).map(line)].join("\n");
}

function serializeInline(nodes: JSONContent[]): string {
    return nodes
        .map((node) => {
            if (node.type === "text") {
                let value = node.text || "";
                for (const mark of node.marks || []) {
                    if (mark.type === "bold") value = `**${value}**`;
                    else if (mark.type === "italic") value = `*${value}*`;
                    else if (mark.type === "strike") value = `~~${value}~~`;
                    else if (mark.type === "code") value = `\`${value}\``;
                    else if (mark.type === "link") value = `[${value}](${String(mark.attrs?.href || "")})`;
                }
                return value;
            }
            if (node.type === "hardBreak") return "\n";
            if (node.type === "image") return `![${String(node.attrs?.alt || "")}](${String(node.attrs?.src || "")})`;
            return serializeInline(node.content || []);
        })
        .join("");
}

function escapeHTML(value: string) {
    return value.replace(/[&<>\"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] || character);
}

export function isSafeCanvasRichTextLink(href: string) {
    const value = href.trim();
    if (!value) return false;
    try {
        const url = new URL(value, window.location.origin);
        return ["http:", "https:", "mailto:", "tel:"].includes(url.protocol);
    } catch {
        return false;
    }
}
