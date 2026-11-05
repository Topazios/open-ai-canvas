import type { ReactNode } from "react";
import { ChevronRight, SlidersHorizontal } from "lucide-react";
import "@/components/canvas/canvas-workflow-generator.css";

export type CanvasRunParameter = { label: string; value: ReactNode };

/** Collapsed "运行参数" block shared by every task detail view. */
export function CanvasRunParameters({ items, prompt }: { items: CanvasRunParameter[]; prompt?: string }) {
    const fields = items.filter((item) => item.value !== undefined && item.value !== null && item.value !== "");
    if (!fields.length && !prompt?.trim()) return null;
    return (
        <details className="production-agent-parameters">
            <summary>
                <SlidersHorizontal size={14} />
                <span>运行参数</span>
                <ChevronRight size={14} className="production-agent-chevron" />
            </summary>
            <dl>
                {fields.map((item) => (
                    <div key={item.label}>
                        <dt>{item.label}</dt>
                        <dd>{item.value}</dd>
                    </div>
                ))}
                {prompt !== undefined ? (
                    <div className="production-agent-prompt">
                        <dt>提示词</dt>
                        <dd>{prompt.trim() || "未记录"}</dd>
                    </div>
                ) : null}
            </dl>
        </details>
    );
}
