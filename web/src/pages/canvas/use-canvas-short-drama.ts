import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { App } from "antd";

import { createShortDramaPipeline, deriveShortDramaProgress, persistShortDramaGuideDismissed, readShortDramaGuideDismissed, type CanvasShortDramaStepId, type CanvasShortDramaTask } from "@/lib/canvas/canvas-short-drama";
import type { CanvasConnection, CanvasNodeData, Position } from "@/types/canvas";
import { createStoryDevelopmentChain, ensureStoryDevelopmentChain } from "@/lib/canvas/canvas-story-development";
import { nodeWorkflow } from "@/lib/canvas/canvas-short-drama-workflow";
import { shortDramaStep, type ShortDramaStepId } from "@/lib/short-drama-steps";

type UseCanvasShortDramaOptions = {
    globalSettings?: import("@/lib/short-drama-settings").ShortDramaGlobalSettings;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    nodesRef: { current: CanvasNodeData[] };
    connectionsRef: { current: CanvasConnection[] };
    selectedNodeIdsRef: { current: Set<string> };
    getCanvasCenter: () => Position;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
    setSelectedNodeIds: Dispatch<SetStateAction<Set<string>>>;
    setSelectedConnectionId: Dispatch<SetStateAction<string | null>>;
    setStylePickerOpen: Dispatch<SetStateAction<boolean>>;
    fitCanvasSelection: () => boolean;
    focusCanvasNode: (nodeId: string) => void;
    openTextEditor: (node: CanvasNodeData) => void;
    openAssets: () => void;
    openAudio: (nodeId?: string) => void;
    openStoryboard: (nodeId: string) => void;
    openTimeline: (nodeId: string) => void;
    openPreview: (nodeId: string) => void;
    openGeneration?: (step: ShortDramaStepId, anchorId?: string, stepIds?: ShortDramaStepId[]) => void;
};

export function useCanvasShortDrama({ nodes, connections, nodesRef, connectionsRef, selectedNodeIdsRef, getCanvasCenter, setNodes, setConnections, setSelectedNodeIds, setSelectedConnectionId, setStylePickerOpen, fitCanvasSelection, focusCanvasNode, openTextEditor, openAssets, openAudio, openStoryboard, openTimeline, openPreview, openGeneration, globalSettings }: UseCanvasShortDramaOptions) {
    const { message } = App.useApp();
    const dismissedRef = useRef(readShortDramaGuideDismissed());
    const [guideCollapsed, setGuideCollapsed] = useState(dismissedRef.current);
    const progress = useMemo(() => deriveShortDramaProgress(nodes, connections, globalSettings), [connections, nodes, globalSettings]);

    const selectNodes = useCallback((ids: string[]) => {
        const selection = new Set(ids);
        selectedNodeIdsRef.current = selection;
        setSelectedNodeIds(selection);
        setSelectedConnectionId(null);
    }, [selectedNodeIdsRef, setSelectedConnectionId, setSelectedNodeIds]);

    const createPipeline = useCallback(() => {
        if (nodesRef.current.length) return message.info("当前画布已有内容，请在新画布创建短剧流水线");
        const pipeline = createShortDramaPipeline(getCanvasCenter(), true);
        nodesRef.current = pipeline.nodes;
        connectionsRef.current = pipeline.connections;
        setNodes(pipeline.nodes);
        setConnections(pipeline.connections);
        selectNodes(pipeline.nodes.map((node) => node.id));
        if (!dismissedRef.current) setGuideCollapsed(false);
        queueMicrotask(() => {
            fitCanvasSelection();
            const story = pipeline.nodes.find((node) => node.id === pipeline.storyNodeId);
            if (story) openTextEditor(story);
        });
        message.success("短剧流水线已创建");
    }, [connectionsRef, fitCanvasSelection, getCanvasCenter, message, nodesRef, openTextEditor, selectNodes, setConnections, setNodes]);

    const openStoryInput = useCallback((nodeId?: string) => {
        const storyNode = (nodeId ? nodesRef.current.find((node) => node.id === nodeId) : undefined)
            || nodesRef.current.find((node) => node.metadata?.workflowKind === "story_input")
            || nodesRef.current.find((node) => node.metadata?.workflowKind === "script");
        if (!storyNode) return;
        focusCanvasNode(storyNode.id);
        queueMicrotask(() => openTextEditor(storyNode));
    }, [focusCanvasNode, nodesRef, openTextEditor]);

    const activateStep = useCallback((stepId: CanvasShortDramaStepId) => {
        const step = progress.steps.find((item) => item.id === (stepId === "final" ? "edit" : stepId));
        if (stepId === "style") {
            const styleNode = nodesRef.current.find((node) => node.metadata?.workflowKind === "styleboard");
            if (styleNode) focusCanvasNode(styleNode.id);
            setStylePickerOpen(true);
            return;
        }
        if (stepId === "story") {
            openStoryInput(step?.nodeId);
            return;
        }
        if (step?.nodeId) focusCanvasNode(step.nodeId);
    }, [focusCanvasNode, nodesRef, openStoryInput, progress.steps, setStylePickerOpen]);

    const activateTask = useCallback((task: CanvasShortDramaTask) => {
        const targetStep = task.entryStepId || task.stepIds?.[0] || task.id;
        const definition = shortDramaStep(targetStep);
        if (definition && definition.id !== "story.topic" && openGeneration) return openGeneration(definition.id, task.nodeId, task.stepIds);
        if (!task.action || task.unavailableReason) return;
        if (task.action === "develop") {
            if (task.nodeId && nodesRef.current.some((node) => node.id === task.nodeId)) return openStoryInput(task.nodeId);
            if (task.id === "story.topic") {
                const pipelineId = nodesRef.current.map(nodeWorkflow).find(Boolean)?.pipelineId;
                const node = createStoryDevelopmentChain(getCanvasCenter(), pipelineId).nodes[0];
                node.metadata = { ...node.metadata, shortDrama: { stage: "story", step: "story.topic", pipelineId: node.metadata!.storyDevelopment!.pipelineId, sourceNodeIds: [], sourceSignatures: {}, role: "document" } };
                setNodes([...nodesRef.current, node]);
                focusCanvasNode(node.id); queueMicrotask(() => openTextEditor(node));
                return;
            }
            const chain = ensureStoryDevelopmentChain(nodesRef.current, connectionsRef.current, getCanvasCenter());
            setNodes(chain.nodes);
            setConnections(chain.connections);
            const node = chain.chain.find((item) => `story.${item.metadata?.storyDevelopment?.stage}` === task.id);
            if (node) {
                focusCanvasNode(node.id);
                queueMicrotask(() => openTextEditor(node));
            }
            return;
        }
        if (task.nodeId && !nodesRef.current.some((node) => node.id === task.nodeId)) {
            message.info("对应节点已被删除，请重新选择阶段");
            return;
        }
        if (task.action === "story") return openStoryInput(task.nodeId);
        if (task.action === "style") return activateStep("style");
        if (task.action === "assets") return openAssets();
        if (task.action === "audio") return openAudio(task.nodeId);
        if (!task.nodeId) return;
        if (task.action === "storyboard") return openStoryboard(task.nodeId);
        if (task.action === "edit") return openTimeline(task.nodeId);
        if (task.action === "preview") return openPreview(task.nodeId);
    }, [activateStep, message, nodesRef, connectionsRef, getCanvasCenter, setNodes, setConnections, focusCanvasNode, openTextEditor, openAssets, openAudio, openPreview, openStoryboard, openStoryInput, openTimeline, openGeneration]);

    const skipGuide = useCallback(() => {
        dismissedRef.current = true;
        persistShortDramaGuideDismissed();
        setGuideCollapsed(true);
    }, []);

    useEffect(() => {
        const dismissed = readShortDramaGuideDismissed();
        dismissedRef.current = dismissed;
        setGuideCollapsed(dismissed);
    }, []);

    useEffect(() => {
        if (!progress.completed) return;
        dismissedRef.current = true;
        persistShortDramaGuideDismissed();
        setGuideCollapsed(true);
    }, [progress.completed]);

    return {
        activateStep,
        activateTask,
        createPipeline,
        guideCollapsed,
        openStoryInput,
        progress,
        setGuideCollapsed,
        skipGuide,
    };
}
