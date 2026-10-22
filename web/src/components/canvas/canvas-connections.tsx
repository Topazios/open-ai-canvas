import React, { useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import { STORYBOARD_HEADER_HEIGHT, STORYBOARD_ROW_HEIGHT, storyboardTableHeight } from "@/lib/canvas/canvas-storyboard-layout";
import { batchReferenceHandleY } from "@/lib/canvas/canvas-batch-table";
import { borderConnectionPath, closestBorderPoint, shortestBorderPair } from "@/lib/canvas/canvas-connection-routing";
import type { CanvasConnection, CanvasNodeData, ConnectionHandle, Position } from "@/types/canvas";

export const ConnectionPath = React.memo(function ConnectionPath({
    connection,
    from,
    to,
    fromScrollTop = 0,
    toScrollTop = 0,
    active,
    visualMode = "full",
    hideVisual = false,
    onSelect,
    onContextMenu,
}: {
    connection: CanvasConnection;
    from: CanvasNodeData;
    to: CanvasNodeData;
    fromScrollTop?: number;
    toScrollTop?: number;
    active: boolean;
    visualMode?: "full" | "hover-only";
    hideVisual?: boolean;
    onSelect: () => void;
    onContextMenu?: (event: ReactMouseEvent<SVGPathElement>) => void;
}) {
    const theme = canvasThemes[useActiveTheme()];
    const [hovered, setHovered] = useState(false);
    const { pathD, startX, startY, endX, endY } = canvasConnectionPath(connection, from, to, fromScrollTop, toScrollTop);
    const emphasized = active || hovered;
    const showVisual = !hideVisual && visualMode === "full";
    const showEmphasis = !hideVisual && emphasized;
    const gradientId = `canvas-flow-${connection.id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
    const markerId = `${gradientId}-target`;
    const animationDelay = connectionAnimationDelay(connection.id);
    const flowStyle = {
        pointerEvents: "none",
        "--canvas-connection-delay": `${animationDelay}ms`,
    } as React.CSSProperties;
    const cometStyle = {
        pointerEvents: "none",
        "--canvas-connection-delay": `${animationDelay - 180}ms`,
    } as React.CSSProperties;

    return (
        <g>
            {showVisual ? <defs>
                <linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1={startX} y1={startY} x2={endX} y2={endY}>
                    <stop offset="0%" stopColor={theme.node.muted} stopOpacity={0.18} />
                    <stop offset="48%" stopColor={theme.accent.primary} stopOpacity={0.58} />
                    <stop offset="100%" stopColor={theme.accent.primary} stopOpacity={0.34} />
                </linearGradient>
                <linearGradient id={`${gradientId}-comet`} gradientUnits="userSpaceOnUse" x1={startX} y1={startY} x2={endX} y2={endY}>
                    <stop offset="0%" stopColor={theme.accent.primary} stopOpacity={0} />
                    <stop offset="45%" stopColor={theme.accent.primary} stopOpacity={0.95} />
                    <stop offset="100%" stopColor={theme.accent.primary} stopOpacity={0} />
                </linearGradient>
                <marker id={markerId} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto">
                    <path d="M 0 0 L 8 4 L 0 8 Z" fill={theme.accent.primary} fillOpacity={0.95} />
                </marker>
            </defs> : null}
            {/* 选中或悬停时增加光晕，常态使用持续流动和终点箭头表达方向。 */}
            {showEmphasis ? <path
                d={pathD}
                stroke={theme.accent.primary}
                strokeWidth="8"
                vectorEffect="non-scaling-stroke"
                strokeOpacity={0.18}
                fill="none"
                strokeLinecap="round"
                style={{ pointerEvents: "none", filter: "blur(3px)" }}
            /> : null}
            <path
                data-connection-id={connection.id}
                d={pathD}
                stroke="transparent"
                strokeWidth="16"
                vectorEffect="non-scaling-stroke"
                fill="none"
                style={{ cursor: "pointer", pointerEvents: "stroke" }}
                onMouseEnter={() => setHovered(true)}
                onMouseLeave={() => setHovered(false)}
                onClick={(event) => {
                    event.stopPropagation();
                    onSelect();
                }}
                onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onContextMenu?.(event);
                }}
            />
            {showVisual ? <path
                d={pathD}
                stroke={theme.node.muted}
                strokeWidth={emphasized ? 5 : 3.5}
                vectorEffect="non-scaling-stroke"
                strokeOpacity={emphasized ? 0.18 : 0.16}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ pointerEvents: "none" }}
            /> : null}
            {showVisual ? <path
                d={pathD}
                stroke={emphasized ? theme.accent.primary : theme.node.muted}
                strokeWidth={emphasized ? 3.4 : 2.6}
                vectorEffect="non-scaling-stroke"
                strokeOpacity={emphasized ? 0.95 : 0.8}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
                markerEnd={showVisual ? `url(#${markerId})` : undefined}
                style={{ pointerEvents: "none" }}
            /> : null}
            {showVisual ? <>
                <circle cx={startX} cy={startY} r={emphasized ? 3.5 : 2.5} fill={theme.node.muted} fillOpacity={emphasized ? 0.78 : 0.58} vectorEffect="non-scaling-stroke" style={{ pointerEvents: "none" }} />
                <circle className="canvas-connection-target" cx={endX} cy={endY} r={emphasized ? 5 : 4} fill={theme.accent.primary} fillOpacity={0.96} vectorEffect="non-scaling-stroke" style={{ pointerEvents: "none" }} />
            </> : null}
            {showVisual ? <path
                className="canvas-connection-flow"
                d={pathD}
                stroke={`url(#${gradientId})`}
                strokeWidth={emphasized ? "3.2" : "2.8"}
                vectorEffect="non-scaling-stroke"
                strokeOpacity={emphasized ? "0.98" : "0.9"}
                strokeDasharray="10 26"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={flowStyle}
            /> : null}
            {showVisual ? <path
                className="canvas-connection-comet"
                d={pathD}
                stroke={`url(#${gradientId}-comet)`}
                strokeWidth={emphasized ? "5.2" : "4.4"}
                vectorEffect="non-scaling-stroke"
                strokeDasharray="20 124"
                strokeOpacity={emphasized ? "1" : "0.94"}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={cometStyle}
            /> : null}
        </g>
    );
}, (previous, next) => previous.connection === next.connection && previous.from === next.from && previous.to === next.to && previous.active === next.active && previous.visualMode === next.visualMode && previous.hideVisual === next.hideVisual && previous.fromScrollTop === next.fromScrollTop && previous.toScrollTop === next.toScrollTop);

function connectionAnimationDelay(connectionId: string) {
    let hash = 0;
    for (let index = 0; index < connectionId.length; index += 1) {
        hash = (hash * 31 + connectionId.charCodeAt(index)) >>> 0;
    }
    return -(hash % 900);
}

export function canvasConnectionPath(connection: CanvasConnection, from: CanvasNodeData, to: CanvasNodeData, fromScrollTop = 0, toScrollTop = 0) {
    const fixedStart = connection.fromHandleId && from.id === connection.fromNodeId ? { x: from.position.x + from.width, y: connectionHandleY(from, connection.fromHandleId, fromScrollTop) } : undefined;
    const fixedEnd = connection.toHandleId && to.id === connection.toNodeId ? { x: to.position.x, y: connectionHandleY(to, connection.toHandleId, toScrollTop) } : undefined;
    const { start, end } = shortestBorderPair(from, to, fixedStart, fixedEnd);
    return borderConnectionPath(start, end, from, to);
}

export function activeConnectionPath(node: CanvasNodeData | undefined, handle: ConnectionHandle, mouseWorld: Position, target?: CanvasNodeData, nodeScrollTop = 0) {
    if (!node) return "";
    const source = handle.handleType === "source";
    const fixed = handle.handleId ? { x: node.position.x + (source ? node.width : 0), y: connectionHandleY(node, handle.handleId, nodeScrollTop) } : undefined;
    if (target) {
        const pair = source ? shortestBorderPair(node, target, fixed) : shortestBorderPair(target, node, undefined, fixed);
        return borderConnectionPath(pair.start, pair.end, source ? node : target, source ? target : node).pathD;
    }
    const anchor = fixed || closestBorderPoint(node, mouseWorld);
    return borderConnectionPath(source ? anchor : mouseWorld, source ? mouseWorld : anchor, source ? node : undefined, source ? undefined : node).pathD;
}

/**
 * 连线在节点上的接入 Y。
 *
 * 显式分镜行、上下文和批量引用端口使用固定 Y；普通节点使用四边中点。
 */
export function connectionHandleY(node: CanvasNodeData, handleId?: string, scrollTop = 0) {
    const batchY = batchReferenceHandleY(node, handleId);
    if (batchY !== undefined) return batchY;
    if (handleId === "storyboard:context") return node.position.y + node.height - (node.metadata?.storyboardComposerHeight || 104) / 2;
    if (!handleId?.startsWith("row:")) return node.position.y + node.height / 2;
    const rowId = handleId.slice(4);
    const index = (node.metadata?.storyboard?.rows || []).findIndex((row) => row.id === rowId);
    if (index < 0) return node.position.y + node.height / 2;
    const tableHeight = storyboardTableHeight(node.height, node.metadata?.storyboardComposerHeight);
    const localY = Math.min(Math.max(index * STORYBOARD_ROW_HEIGHT + STORYBOARD_ROW_HEIGHT / 2 - scrollTop, 4), tableHeight - 4);
    return node.position.y + STORYBOARD_HEADER_HEIGHT + localY;
}
