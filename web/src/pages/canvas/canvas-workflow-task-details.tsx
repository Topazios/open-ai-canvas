import { App, Button } from "antd";
import { Copy, Info, Play } from "lucide-react";
import { nodeWorkflow } from "@/lib/canvas/canvas-short-drama-workflow";
import type { CanvasNodeData } from "@/types/canvas";

export function CanvasWorkflowTaskDetails({ node, nodes, submitting, onResume, onOpenTask }: {
    node: CanvasNodeData; nodes: CanvasNodeData[]; submitting: boolean;
    onResume: (id: string) => void; onOpenTask: (node: CanvasNodeData) => void;
}) {
    const { message } = App.useApp();
    const data = nodeWorkflow(node)!;
    const members = data.role === "collection" ? data.sourceNodeIds.flatMap((id) => {
        const member = nodes.find((entry) => entry.id === id);
        return member ? [member] : [];
    }) : [node];
    const pending = members.filter((member) => nodeWorkflow(member)?.submission === "planned");
    return <div aria-label="制作执行进度">
        {data.assetIdentity ? <section className="canvas-node-inspector-section"><div className="canvas-node-inspector-section-heading"><span>资产编码</span><code>{data.assetIdentity.code}</code><Button size="small" aria-label="复制资产引用" title="复制资产引用" icon={<Copy size={14} />} onClick={async () => { try { await navigator.clipboard.writeText(`@${data.assetIdentity!.code}`); void message.success("资产引用已复制"); } catch { void message.error("复制失败，请选择编码手动复制"); } }} /></div></section> : null}
        <section className="canvas-node-inspector-section">
            <div className="canvas-node-inspector-section-heading" style={{ flexWrap: "wrap" }}>
                <span style={{ overflowWrap: "anywhere" }}>{node.title}</span>
                {pending.length > 0 ? <Button icon={<Play size={14} />} loading={submitting} disabled={submitting} onClick={() => onResume(node.id)}>继续提交{data.role === "collection" ? `（${pending.length}）` : ""}</Button> : null}
            </div>
        </section>
        {members.map((member) => {
            const metadata = member.metadata;
            const workflow = nodeWorkflow(member);
            const planned = workflow?.submission === "planned";
            const uncertain = workflow?.submission === "unknown" || workflow?.submission === "submitting";
            const state = planned ? metadata?.errorDetails ? "尚未提交生成" : "等待保存并提交" : uncertain && !metadata?.taskId && !workflow?.productionAgent?.runId ? "提交回执待确认" : metadata?.status === "success" ? "已完成" : metadata?.status === "error" ? "执行失败" : metadata?.taskStage || "等待执行";
            return <section key={member.id} className="canvas-node-inspector-section" aria-label={member.title}>
                <div className="canvas-node-inspector-section-heading" style={{ flexWrap: "wrap" }}><span style={{ overflowWrap: "anywhere" }}>{member.title}</span><em>{state}</em></div>
                {metadata?.taskStage && metadata.taskStage !== state ? <p>{metadata.taskStage}</p> : null}
                {metadata?.errorDetails ? <p role="alert" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{metadata.errorDetails}</p> : null}
                {metadata?.taskId || workflow?.productionAgent?.runId ? <Button size="small" icon={<Info size={14} />} onClick={() => onOpenTask(member)}>执行记录</Button> : planned ? <p className="canvas-node-inspector-help">节点已保留。保存到云端后继续提交，当前尚未调用模型。</p> : null}
            </section>;
        })}
    </div>;
}
