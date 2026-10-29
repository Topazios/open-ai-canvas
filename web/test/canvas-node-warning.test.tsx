import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasNode } from "../src/components/canvas/canvas-node";
import { CanvasFrameNode } from "../src/components/canvas/canvas-frame-node";
import { applyProductionAgentTerminalState } from "../src/pages/canvas/use-production-agent-runs";
import { bindProductionAgentRun, productionTaskState } from "../src/lib/canvas/production-agent-state";
import type { AgentRun } from "../src/services/api/agent";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

const noop = () => {};
const node: CanvasNodeData = {
    id: "plan", type: CanvasNodeType.Text, title: "制作方案", position: { x: 0, y: 0 }, width: 360, height: 280,
    metadata: { status: "idle", content: "保留的原稿", generationWarning: { severity: "warning", errorSource: "content", message: "资产覆盖待补齐" },
        shortDrama: { stage: "story", step: "story.plan", role: "document", pipelineId: "pipeline", sourceNodeIds: [], sourceSignatures: {}, productionAgent: { runId: "run" }, submission: "rejected" } },
};
const run = { id: "run", status: "failed", production: { targetNodeId: node.id, paused: false }, events: [] } as unknown as AgentRun;
const renderNode = (data: CanvasNodeData, renderNodeContent?: () => React.ReactNode) => renderToStaticMarkup(<CanvasNode data={data} scale={1} isSelected={false} isRelated={false} isFocusRelated={false} isConnectionTarget={false} showImageInfo={false} onMouseDown={noop} onHoverStart={noop} onHoverEnd={noop} onConnectStart={noop} onResize={noop} onContentChange={noop} onContextMenu={noop} onOpenTaskDetails={noop} renderNodeContent={renderNodeContent} />);

test("real canvas node shows yellow pending state while preserving the authored content", () => {
    const html = renderNode(node);
    expect(html).toContain('data-state="warning"');
    expect(html).toContain('aria-label="内容待处理"');
    expect(html).toContain("var(--status-warning)");
    expect(html).toContain("资产覆盖待补齐");
    expect(html).toContain("保留的原稿");
    expect(html).not.toContain('aria-label="生成失败"');
    expect(html).not.toContain('aria-label="生成完成"');
    expect(productionTaskState(node, run)).toMatchObject({ active: false, failed: false, complete: false, warning: true });
});

test("custom authored body keeps its renderer and the warning badge", () => {
    const html = renderNode({ ...node, metadata: { ...node.metadata, shortDrama: { ...node.metadata!.shortDrama!, step: "story.body" } } }, () => <div>正文自定义预览</div>);
    expect(html).toContain("正文自定义预览");
    expect(html).toContain('aria-label="内容待处理"');
});

test("current running, success and real failure states suppress stale warning styling", () => {
    for (const status of ["loading", "success", "error"] as const) {
        const html = renderNode({ ...node, metadata: { ...node.metadata, status, errorDetails: status === "error" ? "HTTP 503" : undefined } });
        expect(html).not.toContain('data-state="warning"');
        expect(html).not.toContain('aria-label="内容待处理"');
        expect(html).toContain(`data-state="${status}"`);
    }
    expect(bindProductionAgentRun(node, { ...run, status: "running" }).metadata?.generationWarning).toBeUndefined();
    expect(applyProductionAgentTerminalState(node, { ...run, status: "completed" }).metadata?.generationWarning).toBeUndefined();
});

test("real collection frame marks a retained incomplete plan pending instead of failed or complete", () => {
    const frame: CanvasNodeData = { ...node, id: "frame", type: CanvasNodeType.Frame, metadata: { shortDrama: { ...node.metadata!.shortDrama!, role: "collection", assetGroup: { manifestId: node.id, kind: "plan" } } } };
    const html = renderToStaticMarkup(<CanvasFrameNode data={frame} childNodes={[{ ...node, parentId: frame.id }]} taskAnchor={node} productionRun={run} scale={1} isSelected={false} isDropTarget={false} onMouseDown={noop} onResize={noop} onToggleCollapsed={noop} onFolderStyleChange={noop} onTitleChange={noop} onContextMenu={noop} onOpenTaskDetails={noop} />);
    expect(html).toContain('aria-label="内容待处理"');
    expect(html).toContain("var(--status-warning)");
    expect(html).toContain("内容待处理 · 已生成");
    expect(html).not.toContain("制作完成 · 已生成");
    expect(html).not.toContain("制作未完成 · 已生成");
});
