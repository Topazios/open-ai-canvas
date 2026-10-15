// 编辑器宿主上下文：store 实例 + 宿主能力（项目信息、资产等）。
// 插槽渲染函数经 registerEditorSlot 注册，宿主在 editor 视图创建 store 后经
// EditorStoreProvider 注入；面板组件用 useEditorStoreContext 消费。
// Host 上下文独立于 store，供需要宿主数据的面板（资产库、导出）使用。

import { createContext, useContext } from "react";
import type { StoreApi, UseBoundStore } from "zustand";

import type { EditorStore } from "@/stores/editor/editor-store";
import type { ProjectAsset } from "@/services/api/projects";
import type { TimelineRenderResult } from "@/services/api/timeline-tasks";
import type { TimelineProject } from "@/types/timeline";

type EditorStoreHook = UseBoundStore<StoreApi<EditorStore>>;

export type EditorHostContextValue = {
    projectId: string;
    unitId?: string;
    /** 当前用户、当前项目的资产快照；由编辑器宿主获取，素材导入插件只消费和触发刷新。 */
    assets: ProjectAsset[];
    /** 重新拉取项目资产（导入媒体后刷新列表）。 */
    refreshAssets: () => Promise<ProjectAsset[] | null>;
    /** 服务端成片完成后，由宿主记录当前集的交付快照。 */
    onDeliveryRender?: (input: { result: TimelineRenderResult; timeline: TimelineProject }) => Promise<void>;
};

const EditorStoreContext = createContext<EditorStoreHook | null>(null);
const EditorHostContext = createContext<EditorHostContextValue | null>(null);

export function EditorStoreProvider({
    store,
    host,
    children,
}: {
    store: EditorStoreHook;
    host: EditorHostContextValue;
    children: React.ReactNode;
}) {
    return (
        <EditorStoreContext.Provider value={store}>
            <EditorHostContext.Provider value={host}>{children}</EditorHostContext.Provider>
        </EditorStoreContext.Provider>
    );
}

export function useEditorStoreContext(): EditorStore {
    const store = useContext(EditorStoreContext);
    if (!store) throw new Error("useEditorStoreContext must be used within <EditorStoreProvider>");
    return store();
}

export function useEditorHostContext(): EditorHostContextValue {
    const host = useContext(EditorHostContext);
    if (!host) throw new Error("useEditorHostContext must be used within <EditorStoreProvider>");
    return host;
}
