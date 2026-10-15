export type WorkflowTextUnit = { label: string; text: string };
export type WorkflowTextBatch = { version: 1; units: WorkflowTextUnit[] } | {
    version: 2; units: WorkflowTextUnit[]; context: WorkflowTextUnit[]; scope: string;
    category: "bible" | "characters" | "environments" | "props" | "special";
};

export const WORKFLOW_CONTEXT_LIMIT = 48000;
export const WORKFLOW_UNIT_LIMIT = 20000;

// Prefer scene/paragraph boundaries, retaining every character including whitespace.
export function splitWorkflowText(text: string, limit = WORKFLOW_UNIT_LIMIT): string[] {
    if (!Number.isInteger(limit) || limit < 2) throw new Error("无效的分批长度");
    const parts: string[] = [];
    let offset = 0;
    while (offset < text.length) {
        let end = Math.min(offset + limit, text.length);
        if (end < text.length) {
            const paragraph = text.lastIndexOf("\n", end - 1);
            if (paragraph >= offset + limit / 2) end = paragraph + 1;
            const last = text.charCodeAt(end - 1);
            if (last >= 0xd800 && last <= 0xdbff) end--;
        }
        parts.push(text.slice(offset, end));
        offset = end;
    }
    return parts;
}

type WorkflowSource = { title?: string; episodeNumber?: number; [key: string]: unknown };

export function sharedWorkflowTextBatch(sources: WorkflowSource[], scope: string, category: string): WorkflowTextBatch | undefined {
    if (!["bible", "characters", "environments", "props", "special"].includes(category)) return;
    const bodies = sources.filter((source) => source.step === "story.body");
    if (!bodies.length) throw new Error("缺少可解析的正文，请选择包含完整正文的来源容器");
    return { version: 2, scope, category: category as Extract<WorkflowTextBatch, { version: 2 }>["category"],
        units: workflowSourceUnits(bodies), context: workflowSourceUnits(sources.filter((source) => source.step !== "story.body")) };
}

export function workflowTextBatch(sources: WorkflowSource[], instructionLength = 0): WorkflowTextBatch | undefined {
    if (JSON.stringify(sources).length + instructionLength <= WORKFLOW_CONTEXT_LIMIT) return undefined;
    return { version: 1, units: workflowSourceUnits(sources) };
}

function workflowSourceUnits(sources: WorkflowSource[]): WorkflowTextUnit[] {
    return sources.flatMap((source, index) => {
        const { content, ...identity } = source;
        const parts = splitWorkflowText(`${JSON.stringify(identity, null, 2)}\n正文：\n${typeof content === "string" ? content : JSON.stringify(content) || ""}`);
        const name = source.episodeNumber ? `第 ${source.episodeNumber} 集` : source.title || `来源 ${index + 1}`;
        return parts.map((text, part) => ({ label: `${name.slice(0, 180)} · 单元 ${part + 1}/${parts.length}`, text }));
    });
}
