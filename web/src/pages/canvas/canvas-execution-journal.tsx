import { Segmented } from "antd";
import { Check, ChevronRight, CircleAlert, Clock, Wrench } from "lucide-react";
import { AIMessageMarkdown } from "@/components/ai/ai-message-markdown";
import type { ReactNode } from "react";
import type { ExecutionJournalRow } from "@/lib/task-execution-journal";

export function CanvasExecutionJournal({ rows, order, onOrder, children, empty = "暂无关键进展记录" }: {
    rows: ExecutionJournalRow[]; order: "desc" | "asc"; onOrder: (order: "desc" | "asc") => void; children?: ReactNode; empty?: string;
}) {
    return <>
        <div className="production-agent-journal-heading"><strong>执行记录</strong><Segmented aria-label="执行记录排序" size="small" value={order} onChange={(value) => onOrder(value as "desc" | "asc")} options={[{ label: "最新在前", value: "desc" }, { label: "最早在前", value: "asc" }]} /></div>
        {children}
        <div className="production-agent-journal" aria-label="逐次执行记录">
            {rows.length === 0 ? <p className="production-agent-note">{empty}</p> : rows.map((row) => row.kind === "message" ? <div className="production-agent-commentary" key={row.id} data-event-seq={row.id}>
                {row.source ? <div className="production-agent-note">{row.source}</div> : null}
                <AIMessageMarkdown components={{ pre: ({ children }) => <pre>{children}</pre>, table: ({ children }) => <table>{children}</table>, img: ({ alt }) => <span>{alt}</span> }}>{row.detail}</AIMessageMarkdown>
            </div> : row.detail === row.title || !row.detail ? <div className={`production-agent-event${row.failed ? " production-agent-error" : ""}`} key={row.id} data-event-seq={row.id}>
                <div className="production-agent-event-line">{row.failed ? <CircleAlert size={14} /> : row.pending ? <Clock size={14} /> : <Check size={14} />}<span>{row.source ? `${row.source} · ` : ""}{row.title}</span><time dateTime={row.time}>{new Date(row.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div>
            </div> : <details className={`production-agent-event${row.failed ? " production-agent-error" : ""}`} key={row.id} data-event-seq={row.id}>
                <summary>{row.failed ? <CircleAlert size={14} /> : row.pending ? <Clock size={14} /> : row.kind === "tool" ? <Wrench size={14} /> : <Check size={14} />}<span>{row.source ? `${row.source} · ` : ""}{row.title}</span><time dateTime={row.time} title={new Date(row.time).toLocaleString()}>{new Date(row.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time><ChevronRight size={14} className="production-agent-chevron" /></summary>
                <div className="production-agent-event-detail">{row.detail}</div>
            </details>)}
        </div>
    </>;
}
