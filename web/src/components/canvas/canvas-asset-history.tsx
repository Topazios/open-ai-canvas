import { useMemo, useState } from "react";
import { Select } from "antd";
import { AppModal } from "@/components/ui/product/app-modal";
import { CanvasVirtualDocument } from "./canvas-virtual-document";
import { assetDocumentIdentity, currentAssetDocumentIds } from "@/lib/canvas/canvas-asset-versions";
import type { CanvasNodeData } from "@/types/canvas";

export function CanvasAssetHistory({ nodes, onClose }: { nodes: CanvasNodeData[]; onClose: () => void }) {
    const documents = useMemo(() => nodes.filter(node => Boolean(assetDocumentIdentity(node))), [nodes]);
    const current = useMemo(() => currentAssetDocumentIds(documents), [documents]);
    const [selectedId, setSelectedId] = useState(() => documents.find(node => !current.has(node.id))?.id || documents[0]?.id);
    const selected = documents.find(node => node.id === selectedId);
    return <AppModal open title="资产版本" onCancel={onClose} footer={null} width="min(1100px, calc(100vw - 24px))" destroyOnHidden>
        <div className="flex h-[min(76dvh,800px)] min-h-0 flex-col gap-3" data-canvas-no-zoom data-canvas-wheel-scroll>
            <Select aria-label="选择资产版本" showSearch optionFilterProp="label" value={selected?.id} onChange={setSelectedId} className="w-full shrink-0"
                options={documents.map(node => ({ value: node.id, label: `${node.metadata?.shortDrama?.assetIdentity?.code} · ${node.title} · ${current.has(node.id) ? "当前采用" : "历史版本"}` }))} />
            <CanvasVirtualDocument key={selected?.id} source={selected?.metadata?.content || "暂无文稿"} />
        </div>
    </AppModal>;
}
