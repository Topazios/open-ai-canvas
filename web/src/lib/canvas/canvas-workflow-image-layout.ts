import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export const WORKFLOW_IMAGE_GRID = { size: 280, columns: 3, gapX: 24, gapY: 48, padding: 24, top: 88 } as const;

/** Only production image containers participate; ordinary canvas images keep their sizing. */
export function layoutWorkflowImageGroups(nodes: CanvasNodeData[], groupIds?: ReadonlySet<string>): CanvasNodeData[] {
    const patches = new Map<string, CanvasNodeData>();
    const byParent = new Map<string, CanvasNodeData[]>();
    for (const node of nodes) {
        if (node.parentId && node.type === CanvasNodeType.Image) {
            const members = byParent.get(node.parentId) || [];
            members.push(node); byParent.set(node.parentId, members);
        }
    }
    for (const frame of nodes) {
        const data = frame.metadata?.shortDrama;
        if (frame.type !== CanvasNodeType.Frame || !data?.mediaGroup || (groupIds && !groupIds.has(frame.id))) continue;
        const members = byParent.get(frame.id) || [];
        const order = new Map(data.sourceNodeIds.map((id, index) => [id, index]));
        members.sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
        const { size, columns, gapX, gapY, padding, top } = WORKFLOW_IMAGE_GRID;
        const cols = Math.min(columns, Math.max(1, members.length));
        const rows = Math.max(1, Math.ceil(members.length / columns));
        const width = padding * 2 + cols * size + (cols - 1) * gapX;
        const height = top + rows * size + (rows - 1) * gapY + padding;
        members.forEach((node, index) => {
            const position = { x: frame.position.x + padding + (index % columns) * (size + gapX), y: frame.position.y + top + Math.floor(index / columns) * (size + gapY) };
            if (node.width === size && node.height === size && node.position.x === position.x && node.position.y === position.y && node.metadata?.manualSize && !node.metadata.freeResize) return;
            patches.set(node.id, { ...node, width: size, height: size, position, metadata: { ...node.metadata, manualSize: true, freeResize: false } });
        });
        const settings = frame.metadata?.frame;
        const frameWidth = settings?.collapsed ? frame.width : width;
        const frameHeight = settings?.collapsed ? frame.height : height;
        if (frame.width === frameWidth && frame.height === frameHeight && settings?.expandedWidth === width && settings.expandedHeight === height && data.mediaGroup.layout === "grid") continue;
        patches.set(frame.id, { ...frame,
            width: frameWidth,
            height: frameHeight,
            metadata: { ...frame.metadata,
                frame: { ...settings, collapsed: settings?.collapsed || false, expandedWidth: width, expandedHeight: height },
                shortDrama: { ...data, mediaGroup: { ...data.mediaGroup, layout: "grid" } },
            },
        });
    }
    return patches.size ? nodes.map((node) => patches.get(node.id) || node) : nodes;
}
