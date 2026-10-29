import React, { useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import { STORYBOARD_HEADER_HEIGHT, STORYBOARD_ROW_HEIGHT, storyboardTableHeight } from "@/lib/canvas/canvas-storyboard-layout";
import { batchReferenceHandleY } from "@/lib/canvas/canvas-batch-table";
import { borderConnectionPath, closestBorderPoint, shortestBorderPair } from "@/lib/canvas/canvas-connection-routing";
import type { RuntimeLimits } from "@/stores/use-user-store";
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
    connectionPolicy,
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
    connectionPolicy?: RuntimeLimits["canvas"];
    onSelect: () => void;
    onContextMenu?: (event: ReactMouseEvent<SVGPathElement>) => void;
}) {
    const theme = canvasThemes[useActiveTheme()];
    const [hovered, setHovered] = useState(false);
    const { pathD, startX, startY, endX, endY } = canvasConnectionPath(connection, from, to, fromScrollTop, toScrollTop);
    const emphasized = (active || hovered) && (connectionPolicy?.connectionEffect || "highlight") === "highlight";
    const showVisual = !hideVisual && visualMode === "full";
    const showEmphasis = !hideVisual && emphasized;
    const lineStyle = connectionPolicy?.connectionLineStyle || "solid";
    const arrowStyle = connectionPolicy?.connectionArrowStyle || "arrow";
    const markerId = `canvas-connection-${connection.id.replace(/[^a-zA-Z0-9_-]/g, "")}-target`;

    return (
        <g>
            {showVisual && arrowStyle === "arrow" ? <defs>
                <marker id={markerId} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" markerUnits="userSpaceOnUse" orient="auto">
                    <path d="M 0 0 L 8 4 L 0 8 Z" fill={theme.accent.primary} fillOpacity={0.86} />
                </marker>
            </defs> : null}
            {showEmphasis ? <path
                d={pathD}
                stroke={theme.accent.primary}
                strokeWidth="4"
                vectorEffect="non-scaling-stroke"
                strokeOpacity={0.12}
                fill="none"
                strokeLinecap="round"
                style={{ pointerEvents: "none", filter: "blur(2px)" }}
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
                stroke={emphasized ? theme.accent.primary : theme.node.muted}
                strokeWidth={emphasized ? 1.8 : 1.4}
                vectorEffect="non-scaling-stroke"
                strokeOpacity={emphasized ? 0.92 : 0.64}
                strokeDasharray={lineStyle === "dashed" ? "5 4" : undefined}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
                markerEnd={arrowStyle === "arrow" ? `url(#${markerId})` : undefined}
                style={{ pointerEvents: "none" }}
            /> : null}
            {showVisual && arrowStyle === "dot" ? <circle
                cx={endX}
                cy={endY}
                r={2.2}
                fill={theme.accent.primary}
                fillOpacity={0.82}
                vectorEffect="non-scaling-stroke"
                style={{ pointerEvents: "none" }}
            /> : null}
        </g>
    );
}, (previous, next) => previous.connection === next.connection && previous.from === next.from && previous.to === next.to && previous.active === next.active && previous.visualMode === next.visualMode && previous.hideVisual === next.hideVisual && previous.connectionPolicy === next.connectionPolicy && previous.fromScrollTop === next.fromScrollTop && previous.toScrollTop === next.toScrollTop);

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
