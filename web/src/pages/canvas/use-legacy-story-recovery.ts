import { useEffect, useRef } from "react";
import { App } from "antd";
import { getActiveUserScope } from "@/lib/user-scope";
import { saveStoryDevelopmentNode, storyDocumentSignature } from "@/lib/canvas/canvas-story-development";
import { createStorySessionStore, receiveStoryTask, recoverStorySession, storyJobActive, storyTaskMatches } from "@/services/story-development-session";
import { listGenerationTasks, queryGenerationTask } from "@/services/api/task-center";
import type { CanvasNodeData } from "@/types/canvas";

// Old editor sessions remain recoverable after their document pane has been removed.
export function useLegacyStoryRecovery(options: {
    canvasId: string; loaded: boolean; nodesRef: { current: CanvasNodeData[] };
    setNodes: (update: CanvasNodeData[]) => void;
    save: () => Promise<boolean>;
}) {
    const ref = useRef(options); ref.current = options;
    const { message } = App.useApp();
    const scope = getActiveUserScope();
    useEffect(() => {
        if (!options.loaded) return;
        const controller = new AbortController();
        const warned = new Set<string>();
        let timer: ReturnType<typeof setTimeout>;
        const valid = () => !controller.signal.aborted && getActiveUserScope() === scope && ref.current.canvasId === options.canvasId;
        const poll = async () => {
            const candidates = ref.current.nodesRef.current.filter((node) => node.metadata?.storyDevelopment && node.metadata.storyDevelopment.stage !== "topic" && !node.metadata.shortDrama);
            for (const original of candidates) {
                if (!valid()) return;
                try {
                    const store = createStorySessionStore(scope, options.canvasId, original.id);
                    const saved = await store.read();
                    if (!saved || (!saved.dirty && !saved.preview && !storyJobActive(saved.job))) continue;
                    let revision = saved.revision;
                    let value = recoverStorySession(saved, original, saved.model);
                    if (storyJobActive(value.job)) {
                        const job = value.job!;
                        if (job.status === "pending") continue;
                        const taskId = job.taskId || (await listGenerationTasks(100, { projectId: options.canvasId }, undefined, controller.signal)).find((task) => storyTaskMatches(task, job.operationId))?.id;
                        if (!taskId) continue;
                        value = receiveStoryTask(value, await queryGenerationTask(taskId, { signal: controller.signal }));
                    }
                    if (!valid()) return;
                    if (JSON.stringify(value) !== JSON.stringify(saved)) revision = await store.write(value, revision);
                    if (storyJobActive(value.job) || !value.dirty || value.preview) continue;
                    const node = ref.current.nodesRef.current.find((entry) => entry.id === original.id);
                    if (!node) continue;
                    const desired = { ...node, title: value.title, metadata: { ...node.metadata, content: value.content, storyDevelopment: value.data } };
                    const alreadySaved = storyDocumentSignature(node) === storyDocumentSignature(desired);
                    if (!alreadySaved && storyDocumentSignature(node) !== value.baseSignature) throw new Error("旧创作草稿与画布版本冲突，本机草稿已保留，请先保留两版内容再合并");
                    let result = node;
                    if (!alreadySaved) {
                        const next = saveStoryDevelopmentNode(ref.current.nodesRef.current, node, value.title, value.content, value.data);
                        result = next.find((entry) => entry.id === node.id)!;
                        ref.current.setNodes(next);
                        value = { ...value, data: result.metadata!.storyDevelopment! };
                        revision = await store.write(value, revision);
                    }
                    if (!await ref.current.save() || !valid()) continue;
                    await store.write({ ...value, baseSignature: storyDocumentSignature(result), data: result.metadata!.storyDevelopment!, dirty: false, ...(value.job ? { job: { ...value.job, appliedToCanvas: true } } : {}) }, revision);
                } catch (error) {
                    if (valid() && !warned.has(original.id)) { warned.add(original.id); message.warning(error instanceof Error ? error.message : "旧创作任务暂未恢复，本机记录已保留"); }
                }
            }
            if (valid()) timer = setTimeout(() => void poll(), 5000);
        };
        void poll();
        return () => { controller.abort(); clearTimeout(timer); };
    }, [options.canvasId, options.loaded, scope, message]);
}
