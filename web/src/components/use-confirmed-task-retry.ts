import { App } from "antd";
import { useCallback, useRef } from "react";
import { retryTaskWithBillingConfirmation } from "@/services/task-retry";
import type { GenerationTask } from "@/services/api/task-center";

export function useConfirmedTaskRetry() {
    const { modal } = App.useApp();
    const pending = useRef(new Map<string, Promise<GenerationTask>>());
    return useCallback((id: string) => {
        const existing = pending.current.get(id);
        if (existing) return existing;
        const operation = retryTaskWithBillingConfirmation(id, (content) => new Promise<boolean>((resolve) => {
            modal.confirm({
                title: "重新生成这张图片？", content,
                okText: "确认重新生成", cancelText: "暂不生成", maskClosable: false,
                onOk: () => { resolve(true); }, onCancel: () => { resolve(false); },
                afterClose: () => { resolve(false); },
            });
        })).finally(() => { pending.current.delete(id); });
        pending.current.set(id, operation);
        return operation;
    }, [modal]);
}
