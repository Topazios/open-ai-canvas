import { nanoid } from "nanoid";

import { createCanvasNode } from "@/lib/canvas/canvas-project-domain";
import { scopedLocalStorage } from "@/lib/user-scope";
import { createStoryDevelopmentChain, storyDevelopmentStages, storySourceState } from "@/lib/canvas/canvas-story-development";
import { shortDramaStages, type ShortDramaStageId } from "@/lib/short-drama-stages";
import { shortDramaStep, type ShortDramaStepId } from "@/lib/short-drama-steps";
import { nodeWorkflow, workflowAncestors, workflowEpisodeProgress, episodeProgressLabel, productionBibleReady } from "./canvas-short-drama-workflow";
import { workflowImageSubjects, workflowImageShots } from "./canvas-workflow-images";
import { workflowAssetKind } from "./canvas-production-sources";
import type { PlannedAssetKind } from "../production-plan";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type Position } from "@/types/canvas";

const SHORT_DRAMA_GUIDE_STORAGE_KEY = "canvas-short-drama-guide-v2";

export type CanvasShortDramaStepId = ShortDramaStageId | "style" | "final";
export type CanvasShortDramaAction = "story" | "develop" | "style" | "assets" | "storyboard" | "audio" | "edit" | "preview";
export type CanvasShortDramaTask = {
    id: string;
    label: string;
    /** A visible guide task may represent several persisted workflow steps. */
    stepIds?: ShortDramaStepId[];
    entryStepId?: ShortDramaStepId;
    ready?: boolean;
    action?: CanvasShortDramaAction;
    actionLabel?: string;
    nodeId?: string;
    unavailableReason?: string;
    progressLabel?: string;
    statusDetail?: string;
    optional?: boolean;
};
export type CanvasShortDramaStepStatus = "pending" | "current" | "completed";
export type CanvasShortDramaStep = {
    id: CanvasShortDramaStepId;
    label: string;
    status: CanvasShortDramaStepStatus;
    nodeId?: string;
    tasks: CanvasShortDramaTask[];
};

export type CanvasShortDramaProgress = {
    active: boolean;
    completed: boolean;
    completedCount: number;
    steps: CanvasShortDramaStep[];
};

type ShortDramaGuideGroup = {
    id: string;
    label: string;
    stepIds: ShortDramaStepId[];
};

const shortDramaGuideGroups: Record<"assets" | "storyboard", ShortDramaGuideGroup[]> = {
    assets: [
        { id: "guide.assets.fixed", label: "正文资产校核与补充", stepIds: ["assets.reconcile"] },
        { id: "guide.assets.references", label: "参考资产生成", stepIds: ["assets.character_references", "assets.environment_references", "assets.prop_references", "assets.special_references"] },
    ],
    storyboard: [
        { id: "guide.direction.breakdown", label: "场次与镜头拆解", stepIds: ["direction.shots"] },
        { id: "guide.direction.prompting", label: "资产绑定与镜头提示词", stepIds: ["direction.production"] },
        { id: "guide.direction.frames", label: "分镜图与关键帧生成", stepIds: ["direction.boards", "direction.start_frame", "direction.end_frame", "direction.keyframes"] },
        { id: "guide.direction.previsualization", label: "动作预演与连续性检查", stepIds: ["direction.previsualization"] },
    ],
};

export function createShortDramaPipeline(center: Position, documentsOnDemand = false) {
    const styleNode = createCanvasNode(CanvasNodeType.Text, { x: center.x - 760, y: center.y - 170 }, {
        content: "",
        status: "idle",
        workflowKind: "styleboard",
        workflowTitle: "项目画风",
        workflowDescription: "待选择",
        fontSize: 14,
    });
    styleNode.title = "项目画风 · 待选择";
    styleNode.width = 360;
    styleNode.height = 220;

    const storyChain = createStoryDevelopmentChain({ x: center.x - 760, y: center.y + 170 });
    const storyNode = storyChain.nodes[0];
    storyNode.metadata = { ...storyNode.metadata, shortDrama: { stage: "story", step: "story.topic", pipelineId: storyNode.metadata!.storyDevelopment!.pipelineId, sourceNodeIds: [], sourceSignatures: {}, role: "document" } };
    if (documentsOnDemand) return { nodes: [storyNode], connections: [] as CanvasConnection[], styleNodeId: "", storyNodeId: storyNode.id, scriptNodeId: "" };
    const bodyNode = storyChain.nodes.at(-1)!;

    const scriptNode = createCanvasNode(CanvasNodeType.Script, { x: bodyNode.position.x + 500, y: bodyNode.position.y }, {
        status: "idle",
        workflowKind: "storyboard",
        workflowTitle: "分镜脚本",
        storyboard: {
            rows: [],
            visibleColumns: ["shotNumber", "durationSeconds", "videoMotionPrompt", "dialogue", "assets"],
            referenceNodeIds: [],
        },
    });
    scriptNode.title = "分镜脚本 · 待生成";

    const connections: CanvasConnection[] = [
        ...storyChain.connections,
        { id: nanoid(), fromNodeId: styleNode.id, toNodeId: scriptNode.id, toHandleId: "storyboard:context" },
        { id: nanoid(), fromNodeId: bodyNode.id, toNodeId: scriptNode.id, toHandleId: "storyboard:context" },
    ];
    return { nodes: [styleNode, ...storyChain.nodes, scriptNode], connections, styleNodeId: styleNode.id, storyNodeId: storyNode.id, scriptNodeId: scriptNode.id };
}

export function deriveShortDramaProgress(nodes: CanvasNodeData[], connections: CanvasConnection[]): CanvasShortDramaProgress {
    const storyInputNode = nodes.find((node) => node.metadata?.workflowKind === "story_input");
    const storyboardScripts = nodes.filter((node) => node.type === CanvasNodeType.Script && (node.metadata?.workflowKind === "storyboard" || Boolean(storyInputNode)));
    const agentScriptNode = nodes.find((node) => node.type === CanvasNodeType.Text && node.metadata?.workflowKind === "script");
    const shotNodes = nodes.filter((node) => node.metadata?.workflowKind === "shot");
    const finalNodes = nodes.filter((node) => node.metadata?.workflowKind === "final");
    const hasManualPipeline = Boolean(storyInputNode || storyboardScripts.some((node) => node.metadata?.workflowKind === "storyboard"));
    const hasAgentPipeline = Boolean(agentScriptNode && shotNodes.length && finalNodes.length);
    const active = hasManualPipeline || hasAgentPipeline || nodes.some((node) => Boolean(nodeWorkflow(node)));
    const scriptIds = new Set(storyboardScripts.map((node) => node.id));
    const isConnectedToStoryboard = (nodeId: string) => connections.some((connection) => connection.fromNodeId === nodeId && scriptIds.has(connection.toNodeId));
    const styleNode = nodes.find((node) => node.metadata?.workflowKind === "styleboard");
    const scriptNode = storyboardScripts.find((node) => meaningfulStoryboardRows(node).length > 0) || storyboardScripts[0];
    const meaningfulRows = scriptNode ? meaningfulStoryboardRows(scriptNode) : [];
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const successfulVideoNodeIds = new Set(nodes.filter(isSuccessfulVideoNode).map((node) => node.id));
    const completedShotVideos = nodes.filter((node) => isSuccessfulVideoNode(node) && (node.metadata?.workflowKind === "shot" || connections.some((connection) => shotNodes.some((shot) => shot.id === connection.fromNodeId) && connection.toNodeId === node.id)));
    const finalNode = finalNodes.find((node) => node.metadata?.status === "success" && Boolean(node.metadata.content));

    // 手工流水线要求输入真实连到分镜脚本；Agent 协议的风格板和剧本没有这条连线，按领域节点本身判断。
    const styleDone = Boolean((styleNode?.metadata?.content || styleNode?.metadata?.prompt || "").trim() && (hasAgentPipeline || !scriptNode || isConnectedToStoryboard(styleNode!.id)));
    const storyboardDone = meaningfulRows.length > 0 || shotNodes.length > 0;
    const rowsWithVideo = meaningfulRows.filter((row) => row.videoNodeId && nodeById.get(row.videoNodeId)?.type === CanvasNodeType.Video);
    const videoDone = meaningfulRows.length > 0
        ? rowsWithVideo.length === meaningfulRows.length && rowsWithVideo.every((row) => {
              const videoNode = nodeById.get(row.videoNodeId!);
              return videoNode?.metadata?.status === "success" && Boolean(videoNode.metadata.content);
          })
        : shotNodes.length > 0 && shotNodes.every((shot) => connections.some((connection) => connection.fromNodeId === shot.id && successfulVideoNodeIds.has(connection.toNodeId)));
    // 自由画布没有阶段审核记录；存在素材或合片结果不能替代人工确认。
    const storyTasks: CanvasShortDramaTask[] = storyDevelopmentStages.map((stage) => {
        const pipelineId = nodes.find((item) => item.metadata?.storyDevelopment?.stage === "topic")?.metadata?.storyDevelopment?.pipelineId;
        const stageNodes = nodes.filter((item) => item.metadata?.storyDevelopment?.stage === stage.id && item.metadata.storyDevelopment.pipelineId === pipelineId);
        const nodeReady = (node: CanvasNodeData) => {
            if (!node.metadata?.content?.trim() || !node.metadata.storyDevelopment) return false;
            if (node.metadata.shortDrama) {
                try { workflowAncestors([node.id], nodes, node.metadata.shortDrama.pipelineId, connections); return true; }
                catch { return false; }
            }
            const state = storySourceState(node.metadata.storyDevelopment, nodes);
            return !state.stale && !state.missing && !state.upstreamStale;
        };
        const node = stageNodes.filter(nodeReady).at(-1) || stageNodes.at(-1);
        const data = node?.metadata?.storyDevelopment;
        const plan = nodes.filter((item) => nodeWorkflow(item)?.pipelineId === pipelineId && nodeWorkflow(item)?.step === "story.plan" && nodeReady(item)).at(-1);
        const outline = nodes.filter((item) => nodeWorkflow(item)?.pipelineId === pipelineId && nodeWorkflow(item)?.step === "story.episodes" && (!plan || nodeWorkflow(item)?.sourceNodeIds.includes(plan.id)) && nodeReady(item)).at(-1);
        const progress = stage.id === "body" && outline ? workflowEpisodeProgress(nodes, pipelineId!, outline.id, undefined, connections) : undefined;
        const ready = stage.id === "body" ? Boolean(progress && progress.complete === progress.total) : Boolean(node && data && nodeReady(node));
        return { id: `story.${stage.id}`, label: stage.label, ready, action: "develop", actionLabel: node ? "编辑" : "创建节点", nodeId: stage.id === "body" ? outline?.id : node?.id, progressLabel: progress ? episodeProgressLabel(progress) : undefined };
    });
    const done = [storyTasks.every((task) => task.ready), false, storyboardDone, false, videoDone, false, false, false];
    const firstIncomplete = done.findIndex((value) => !value);
    const firstShotNode = shotNodes[0];
    const storyboardNodeId = scriptNode?.id || firstShotNode?.id;
    const mediaNode = completedShotVideos[0] || finalNode || nodes.find((node) =>
        (node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio) && Boolean(node.metadata?.content || node.metadata?.storageKey));
    const audioNode = nodes.find((node) => node.type === CanvasNodeType.Audio && Boolean(node.metadata?.content || node.metadata?.storageKey));
    const storyboardTask = (id: string, label: string, ready = false): CanvasShortDramaTask => ({ id, label, ready, action: "storyboard", actionLabel: "打开分镜", nodeId: storyboardNodeId, unavailableReason: storyboardNodeId ? undefined : "请先添加分镜脚本" });
    const timelineTask = (id: string, label: string): CanvasShortDramaTask => ({ id, label, action: "edit", actionLabel: "打开剪辑", nodeId: mediaNode?.id, unavailableReason: mediaNode ? undefined : "请先生成或导入音视频素材" });
    const tasks: Record<ShortDramaStageId, CanvasShortDramaTask[]> = {
        story: storyTasks,
        assets: [
            ...shortDramaGuideGroups.assets.map((group) => ({ ...group, stepIds: [...group.stepIds] })),
        ],
        storyboard: shortDramaGuideGroups.storyboard.map((group) => ({ ...group, stepIds: [...group.stepIds], nodeId: storyboardNodeId })),
        voice: [
            storyboardTask("voice.dialogue", "台词、旁白、说话人与情绪", meaningfulRows.some((row) => Boolean(row.dialogue?.trim() || row.audioEffects?.trim()))),
            { id: "voice.casting", label: "角色声线与试听", unavailableReason: "自由画布待接入角色声线；现有入口位于项目资产库" },
            { id: "voice.recording", label: "配音、音乐与音效素材", ready: Boolean(audioNode), action: "audio", actionLabel: "打开声音素材", nodeId: audioNode?.id },
            timelineTask("voice.timing", "实际时长、音画对齐与混音"),
        ],
        video: [
            storyboardTask("video.sample", "代表性镜头样片验证"),
            storyboardTask("video.generate", "镜头视频生成、导入与重试", videoDone),
            storyboardTask("video.performance", "口型与表演处理"),
            storyboardTask("video.approve", "候选对比、选用与问题回退"),
        ],
        edit: [
            timelineTask("edit.rough", "镜头排序、入出点与粗剪"),
            timelineTask("edit.picture", "画面调整、转场与包装"),
            timelineTask("edit.sound", "对白、音乐、音效与环境声"),
            timelineTask("edit.subtitles", "字幕、转写与样式校对"),
        ],
        review: [
            { id: "review.automatic", label: "资源、版本、时长与字幕边界检查", unavailableReason: "自由画布待接入自动质检；现有入口位于短剧项目成片质检" },
            { id: "review.screening", label: "成片画面、声音与字幕审片", action: "preview", actionLabel: "播放成片", nodeId: finalNode?.id, unavailableReason: finalNode ? undefined : "请先完成成片合成" },
            timelineTask("review.revision", "问题修订、重新渲染与复查"),
        ],
        delivery: [
            { ...timelineTask("delivery.render", "成片 MP4 渲染与导出"), actionLabel: "打开导出" },
            { id: "delivery.package", label: "成片、字幕、分镜与资产资料包", unavailableReason: "资料包归档待接入" },
            { id: "delivery.verify", label: "交付文件与版本核验", unavailableReason: "待审片确认与交付记录接入" },
            { id: "delivery.promotion", label: "封面、预告、切片与发布文案", unavailableReason: "宣传物料作为独立可选任务待接入" },
        ],
    };
    const pipelineId = nodeWorkflow(nodes.find((node) => nodeWorkflow(node)?.step === "story.topic"))?.pipelineId || nodes.map(nodeWorkflow).find(Boolean)?.pipelineId;
    const steps = shortDramaStages.map((step, index): CanvasShortDramaStep => ({
        id: step.key,
        label: step.label,
        nodeId: tasks[step.key].find((task) => task.nodeId)?.nodeId,
        tasks: tasks[step.key].map((task) => {
            let memberIds = task.stepIds || (shortDramaStep(task.id) ? [task.id as ShortDramaStepId] : []);
            if (pipelineId && task.id === "guide.assets.fixed" && !nodes.some((node) => nodeWorkflow(node)?.pipelineId === pipelineId && nodeWorkflow(node)?.step === "assets.reconcile")) {
                const legacy: ShortDramaStepId[] = ["assets.characters", "assets.environments", "assets.props", "assets.special"];
                if (nodes.some((node) => nodeWorkflow(node)?.pipelineId === pipelineId && legacy.includes(nodeWorkflow(node)!.step))) memberIds = legacy;
            }
            if (!memberIds.length || task.id === "story.topic") return task;
            const memberState = memberIds.map((memberId) => {
                const definition = shortDramaStep(memberId)!;
                const documents = nodes.filter((node) => nodeWorkflow(node)?.step === definition.id && nodeWorkflow(node)?.pipelineId === pipelineId && !nodeWorkflow(node)?.mediaGroup && !nodeWorkflow(node)?.planGroup);
                let statusDetail = "";
                const validDocument = (node: CanvasNodeData) => {
                    if (node.metadata?.status === "loading" || node.metadata?.status === "error") {
                        statusDetail = node.metadata.taskStage || (node.metadata.status === "loading" ? "生成中" : "生成失败");
                        return false;
                    }
                    const legacyPlan = definition.id === "story.plan" && !nodeWorkflow(node)?.assetKey && !nodeWorkflow(node)?.assetGroup && nodeWorkflow(node)?.role !== "collection";
                    if (definition.output === "asset-group" && nodeWorkflow(node)?.role !== "collection" && !legacyPlan) return false;
                    if (definition.id === "assets.bible" && !productionBibleReady(node, nodes)) return false;
                    if (definition.output === "asset-group" && definition.id !== "assets.bible" && !legacyPlan) {
                        const manifest = nodes.find((entry) => entry.id === nodeWorkflow(node)?.assetGroup?.manifestId);
                        if (manifest?.metadata?.status !== "success" || nodeWorkflow(manifest)?.assetOutput || !nodeWorkflow(manifest)?.materializedTaskId) {
                            const count = nodes.filter((entry) => entry.parentId === node.id && entry.id !== manifest?.id && entry.metadata?.content?.trim()).length;
                            const action = definition.id === "story.plan" ? "方案制作" : "提取";
                            statusDetail = `${manifest?.metadata?.status === "error" ? `任务失败，${action}未完成` : manifest?.metadata?.status === "loading" ? `${action}中` : `${action}待完成`} · 已保留 ${count} 项`;
                            return false;
                        }
                    }
                    if (definition.mediaOutput && (nodeWorkflow(node)?.mediaKind !== definition.mediaOutput || node.metadata?.status !== "success" || !(node.metadata?.storageKey || node.metadata?.content))) return false;
                    try { workflowAncestors([node.id], nodes, nodeWorkflow(node)!.pipelineId, connections); return true; }
                    catch (error) { statusDetail = error instanceof Error ? error.message : "来源需核对"; return false; }
                };
                const latest = documents.filter((node) => definition.output !== "asset-group" || nodeWorkflow(node)?.role === "collection" || (definition.id === "story.plan" && !nodeWorkflow(node)?.assetKey)).at(-1);
                let outputReady = Boolean(latest && validDocument(latest));
                if (definition.mediaOutput && definition.stage === "assets" && latest) {
                    const sourceNodeIds = nodeWorkflow(latest)!.sourceNodeIds;
                    const subjects = workflowImageSubjects({ step: definition.id, sourceNodeIds }, nodes);
                    const completed = subjects.filter((subject) => {
                        const result = documents.filter((node) => nodeWorkflow(node)?.mediaSubjectId === subject.id).at(-1);
                        return Boolean(result && validDocument(result));
                    }).length;
                    outputReady = subjects.length > 0 && completed === subjects.length;
                    if (!outputReady) statusDetail = `已完成 ${completed}/${subjects.length} 项参考图`;
                }
                if (definition.mediaOutput && definition.stage === "assets" && !outputReady) {
                    const kind = workflowAssetKind[definition.requires[0]] as PlannedAssetKind | undefined;
                    const plans = nodes.filter((node) => nodeWorkflow(node)?.pipelineId === pipelineId && nodeWorkflow(node)?.step === "story.plan" && nodeWorkflow(node)?.role === "collection" && !nodeWorkflow(node)?.planGroup);
                    const plan = plans.length === 1 ? plans[0] : undefined;
                    const hasAssets = kind && nodes.some((node) => nodeWorkflow(node)?.pipelineId === pipelineId && nodeWorkflow(node)?.assetIdentity?.kind === kind);
                    if (plan && kind && !hasAssets && nodeWorkflow(plan)?.planAbsent?.[kind]) {
                        try { workflowAncestors([plan.id], nodes, pipelineId!, connections); outputReady = true; } catch { /* Stale absence declarations cannot skip production. */ }
                    }
                    const input = nodes.filter((node) => nodeWorkflow(node)?.pipelineId === pipelineId && nodeWorkflow(node)?.step === definition.requires[0] && nodeWorkflow(node)?.assetGroup).at(-1);
                    const inputData = nodeWorkflow(input);
                    const manifest = nodes.find((node) => node.id === inputData?.assetGroup?.manifestId);
                    if (input && inputData?.sourceNodeIds.length === 1 && inputData.sourceNodeIds[0] === manifest?.id && manifest?.metadata?.status === "success" && nodeWorkflow(manifest)?.materializedTaskId && !nodeWorkflow(manifest)?.assetOutput) {
                        try { workflowAncestors([input.id], nodes, pipelineId!, connections); outputReady = true; } catch { /* An incomplete or stale empty group cannot skip production. */ }
                    }
                }
                if (definition.mediaOutput && definition.stage === "storyboard" && latest) {
                    const subjects = workflowImageSubjects({ step: definition.id, sourceNodeIds: nodeWorkflow(latest)!.sourceNodeIds }, nodes);
                    outputReady = subjects.length > 0 && subjects.every((subject) => {
                        const shots = workflowImageShots(subject, definition.id);
                        return shots.length > 0 && shots.every((shot) => {
                            const result = documents.filter((node) => nodeWorkflow(node)?.mediaSubjectId === subject.id && nodeWorkflow(node)?.mediaShotId === shot.id).at(-1);
                            return Boolean(result && validDocument(result));
                        });
                    });
                }
                const ready = definition.stage === "story" ? Boolean(task.ready) : definition.production && !definition.mediaOutput ? Boolean(task.ready) : outputReady;
                if (outputReady) statusDetail = ready ? "" : "文稿已产出 · 实际执行待验收";
                return { definition, outputReady, ready, nodeId: latest?.id, statusDetail };
            });
            const next = memberState.find((member) => !member.outputReady && !member.definition.optional) || memberState.find((member) => !member.outputReady && member.nodeId);
            const ready = memberState.every((member) => member.ready || member.definition.optional);
            return {
                ...task,
                label: task.label || memberState[0]?.definition.label,
                stepIds: memberIds,
                entryStepId: next?.definition.id || memberState[0]?.definition.id,
                action: "develop",
                actionLabel: "生成",
                unavailableReason: undefined,
                nodeId: next?.nodeId || memberState.findLast((member) => member.nodeId)?.nodeId || task.nodeId,
                progressLabel: task.progressLabel || (memberIds.length > 1 ? `${memberState.filter((member) => member.outputReady && !member.definition.optional).length}/${memberState.filter((member) => !member.definition.optional).length} 项已产出` : undefined),
                statusDetail: memberState.filter((member) => !member.definition.optional && member.statusDetail).map((member) => `${member.definition.label}：${member.statusDetail}`).join("；"),
                ready,
            };
        }),
        status: done[index] ? "completed" : index === firstIncomplete ? "current" : "pending",
    }));
    done[1] = steps.find((step) => step.id === "assets")!.tasks.every((task) => task.ready);
    const current = done.findIndex((value) => !value);
    steps.forEach((step, index) => { step.status = done[index] ? "completed" : index === current ? "current" : "pending"; });
    return {
        active,
        completed: done.every(Boolean),
        completedCount: done.filter(Boolean).length,
        steps,
    };
}

export function readShortDramaGuideDismissed() {
    try {
        return scopedLocalStorage.getItem(SHORT_DRAMA_GUIDE_STORAGE_KEY) === "dismissed";
    } catch (error) {
        console.warn("读取短剧导引状态失败", error);
        return false;
    }
}

export function persistShortDramaGuideDismissed() {
    try {
        scopedLocalStorage.setItem(SHORT_DRAMA_GUIDE_STORAGE_KEY, "dismissed");
    } catch (error) {
        console.warn("保存短剧导引状态失败", error);
    }
}

function meaningfulStoryboardRows(node: CanvasNodeData) {
    return (node.metadata?.storyboard?.rows || []).filter((row) => Boolean((row.plotDescription || row.imageGenerationPrompt || row.videoMotionPrompt).trim()));
}

function isSuccessfulVideoNode(node: CanvasNodeData) {
    return node.type === CanvasNodeType.Video && node.metadata?.status === "success" && Boolean(node.metadata.content);
}
