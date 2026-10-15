import { StrictMode, memo, useCallback, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { CanvasNodeGraphContext, CanvasNodeGraphScope, useUpstreamNodes } from "@/components/canvas/canvas-node-graph-context";
import { buildContextResourceNodeMap, getContextResourceNodes } from "@/lib/canvas/canvas-resource-references";
import { useCanvasDerivedArrayMap } from "@/pages/canvas/use-canvas-derived-references";
import { useCanvasScopedNodeRenderers, type CanvasCustomNodeScope } from "@/pages/canvas/use-canvas-scoped-node-renderers";
import { useCanvasRenderModel } from "@/pages/canvas/use-canvas-render-model";
import { baseOptions } from "./canvas-lifecycle-behavior";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

const node = (id: string, type = CanvasNodeType.Text, metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData => ({
    id, type, metadata, title: id, position: { x: 0, y: 0 }, width: 200, height: 100,
});
const emptyMap = new Map();
const wait = () => new Promise((resolve) => setTimeout(resolve, 40));

export async function runCanvasRenderChecks() {
    const results: string[] = [];
    const check = (value: unknown, label: string) => { if (!value) throw new Error(label); results.push(label); };
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    const source = node("source", CanvasNodeType.Text, { content: "First" });
    const unrelated = node("unrelated", CanvasNodeType.Text, { content: "Unrelated" });
    const table = node("table", CanvasNodeType.BatchTable, { batchTable: { operation: "creative", concurrency: 1, rows: [
        { id: "row", enabled: true, inputNodeIds: [], textNodeIds: [source.id], outputNodeId: "result", prompt: "synthetic" },
    ] } });
    const initialNodes = [source, unrelated, table, node("config", CanvasNodeType.Config)];
    const initialConnections = [{ id: "edge", fromNodeId: source.id, toNodeId: "connected" }];
    let api: {
        nodes: (nodes: CanvasNodeData[]) => void; connections: (connections: CanvasConnection[]) => void;
        revision: (value: number) => void; visible: (nodes: CanvasNodeData[]) => void;
        renderers: ReturnType<typeof useCanvasScopedNodeRenderers>;
    };
    const counts = new Map<string, number>();
    const UpstreamConsumer = memo(function UpstreamConsumer({ id }: { id: string }) {
        counts.set(id, (counts.get(id) || 0) + 1);
        const nodes = useUpstreamNodes(id);
        return <output data-upstream={id}>{nodes.map((node) => node.metadata?.content).join("|")}</output>;
    });
    function Harness() {
        const [nodes, setNodes] = useState(initialNodes);
        const [connections, setConnections] = useState(initialConnections);
        const [revision, setRevision] = useState(1);
        const [visibleNodes, setVisible] = useState(initialNodes);
        const upstream = useCanvasDerivedArrayMap(useMemo(() => buildContextResourceNodeMap(nodes, connections), [nodes, connections]));
        const render = useCallback((node: CanvasNodeData, scope: CanvasCustomNodeScope) => <output data-custom={node.id}>
            {revision}:{scope.nodes.map((item) => item.metadata?.content).join("|")}:{scope.connections.length}
        </output>, [revision]);
        const renderers = useCanvasScopedNodeRenderers({ nodes, visibleNodes, connections, runningNodeId: null,
            configInputsById: emptyMap, mentionReferencesByNodeId: emptyMap }, render);
        api = { nodes: setNodes, connections: setConnections, revision: setRevision, visible: setVisible, renderers };
        return <>
            {renderers.get(table.id)?.(table)}
            {["connected", "isolated"].map((id) => <CanvasNodeGraphScope key={id} nodeId={id} upstreamNodes={upstream.get(id)}><UpstreamConsumer id={id} /></CanvasNodeGraphScope>)}
            <CanvasNodeGraphContext.Provider value={{ getUpstreamNodes: (id) => getContextResourceNodes(id, nodes, connections) }}><UpstreamConsumer id="legacy" /></CanvasNodeGraphContext.Provider>
        </>;
    }
    const output = () => host.querySelector('[data-custom="table"]')?.textContent;
    try {
        flushSync(() => root.render(<StrictMode><Harness /></StrictMode>)); await wait();
        const initialTable = api.renderers.get(table.id), initialConfig = api.renderers.get("config");
        const before = counts.get("isolated");
        const changed = initialNodes.map((item) => item === unrelated ? { ...unrelated, title: "Renamed" } : item);
        flushSync(() => api.nodes(changed)); await wait();
        check(api.renderers.get(table.id) === initialTable && api.renderers.get("config") === initialConfig, "render scope: unrelated content preserves per-node renderer identity");
        const latest = changed.map((item) => item === source ? { ...source, metadata: { content: "Latest" } } : item);
        flushSync(() => api.nodes(latest)); await wait();
        check(output() === "1:Latest:0" && api.renderers.get(table.id) !== initialTable && api.renderers.get("config") === initialConfig, "render scope: row text updates its table without invalidating an independent config");
        check(host.querySelector('[data-upstream="connected"]')?.textContent === "Latest" && counts.get("isolated") === before, "graph scope: connected consumer gets latest content; isolated memo consumer does not render");
        flushSync(() => api.connections([])); await wait();
        check(host.querySelector('[data-upstream="connected"]')?.textContent === "", "graph scope: disconnect clears the upstream immediately");
        flushSync(() => api.connections([...initialConnections, { id: "legacy-edge", fromNodeId: "source", toNodeId: "legacy" }])); await wait();
        check(host.querySelector('[data-upstream="connected"]')?.textContent === "Latest" && host.querySelector('[data-upstream="legacy"]')?.textContent === "Latest", "graph scope: reconnect and version-preview-style provider retain existing semantics");
        const outputNode = node("result", CanvasNodeType.Image, { content: "Result" });
        flushSync(() => api.nodes([...latest, outputNode])); await wait();
        check(output() === "1:Latest|Result:0", "render scope: newly inserted batch result is discovered through its existing row binding");
        flushSync(() => api.nodes([table, unrelated, outputNode])); await wait();
        check(output() === "1:Result:0" && host.querySelector('[data-upstream="connected"]')?.textContent === "", "render scope: deleting an upstream source removes stale graph and table content");
        const priorRenderer = api.renderers.get(table.id);
        flushSync(() => api.revision(2)); await wait();
        check(output() === "2:Result:0" && api.renderers.get(table.id) !== priorRenderer, "render scope: replacing a callback is never hidden by cached data");
        flushSync(() => api.visible([])); await wait();
        check(api.renderers.size === 0 && !host.querySelector('[data-custom="table"]'), "render scope: leaving visibility releases cached render closures");
        flushSync(() => api.visible([table])); await wait();
        check(output() === "2:Result:0", "render scope: reentering visibility uses the latest callback and result");
    } finally { flushSync(() => root.unmount()); host.remove(); }
    results.push(...await runGeometryChecks());
    return results;
}

async function runGeometryChecks() {
    const results: string[] = [];
    const check = (value: unknown, label: string) => { if (!value) throw new Error(label); results.push(label); };
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    const source = node("source", CanvasNodeType.Text, { content: "First" });
    const target = { ...node("target"), position: { x: 400, y: 100 } };
    const edges = [{ id: "edge", fromNodeId: source.id, toNodeId: target.id }];
    let api: { nodes: (nodes: CanvasNodeData[]) => void; model: ReturnType<typeof useCanvasRenderModel> };
    function Harness() {
        const [nodes, setNodes] = useState([source, target]);
        const model = useCanvasRenderModel({ ...baseOptions, nodes, connections: edges, viewport: { x: 0, y: 0, k: 1 } });
        api = { nodes: setNodes, model };
        return null;
    }
    try {
        flushSync(() => root.render(<StrictMode><Harness /></StrictMode>)); await wait();
        const updated = { ...source, metadata: { content: "Latest result" } };
        flushSync(() => api.nodes([updated, target])); await wait();
        check(api.model.displayConnections[0]?.from === updated && api.model.displayConnections[0]?.to === target, "geometry cache: actual render model resolves latest endpoint content without rebuilding geometry");
        const moved = { ...updated, position: { x: 50, y: 70 } };
        flushSync(() => api.nodes([moved, target])); await wait();
        check(api.model.displayConnections[0]?.from.position.x === 50 && api.model.displayConnections[0]?.from.position.y === 70, "geometry cache: moved endpoints use their new coordinates");
        flushSync(() => api.nodes([moved])); await wait();
        check(api.model.displayConnections.length === 0, "geometry cache: deleted endpoint does not leave a stale connection");
    } finally { flushSync(() => root.unmount()); host.remove(); }
    return results;
}
