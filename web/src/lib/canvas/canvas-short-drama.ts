import { nanoid } from "nanoid";

import { createCanvasNode } from "@/lib/canvas/canvas-project-domain";
import { scopedLocalStorage } from "@/lib/user-scope";
import { createStoryDevelopmentChain, storyDevelopmentStages, storySourceState } from "@/lib/canvas/canvas-story-development";
import type { ShortDramaStageId } from "@/lib/short-drama-stages";
import { shortDramaStep, type ShortDramaStepId } from "@/lib/short-drama-steps";
import { nodeWorkflow, workflowAncestors, workflowEpisodeProgress, episodeProgressLabel, productionBibleReady } from "./canvas-short-drama-workflow";
import { workflowImageSubjects, workflowImageShots } from "./canvas-workflow-images";
import { workflowSoundSubjects } from "./canvas-workflow-sounds";
import { workflowAssetKind } from "./canvas-production-sources";
import type { PlannedAssetKind } from "../production-plan";
import { latestBodyAudit, screenplayAuditState } from "./workflow-screenplay-audit";
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

type CanvasGuideStage = {
    key: CanvasShortDramaStepId;
    label: string;
    sourceStages: ShortDramaStageId[];
};

const visibleShortDramaStages: readonly CanvasGuideStage[] = [
    { key: "story", label: "剧情与章节", sourceStages: ["story"] },
    { key: "storyboard", label: "分镜与视频草样", sourceStages: ["storyboard", "video"] },
    { key: "edit", label: "剪辑与后期", sourceStages: ["edit"] },
    { key: "review", label: "成片质检", sourceStages: ["review"] },
    { key: "delivery", label: "导出交付", sourceStages: ["delivery"] },
];

const shortDramaGuideGroups: Record<"assets" | "storyboard", ShortDramaGuideGroup[]> = {
    assets: [
        { id: "guide.assets.references", label: "资产参考图生成", stepIds: ["assets.character_references", "assets.environment_references", "assets.prop_references"] },
    ],
    storyboard: [
        { id: "guide.direction.breakdown", label: "分镜脚本与镜头提示词", stepIds: ["direction.scenes", "direction.shots", "direction.production"] },
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

export function deriveShortDramaProgress(nodes: CanvasNodeData[], connections: CanvasConnection[], settings?: import("../short-drama-settings").ShortDramaGlobalSettings): CanvasShortDramaProgress {
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
    const rowsWithVideo = meaningfulRows.filter((row) => row.videoGeneration?.content || row.videoGeneration?.storageKey || row.videoNodeId && nodeById.get(row.videoNodeId)?.type === CanvasNodeType.Video);
    const videoDone = meaningfulRows.length > 0
        ? rowsWithVideo.length === meaningfulRows.length && rowsWithVideo.every((row) => {
              if (row.videoGeneration?.content || row.videoGeneration?.storageKey) return row.videoGeneration.taskStatus === "succeeded";
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
    const firstShotNode = shotNodes[0];
    const storyboardNodeId = scriptNode?.id || firstShotNode?.id;
    const mediaNode = completedShotVideos[0] || finalNode || nodes.find((node) =>
        (node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio) && Boolean(node.metadata?.content || node.metadata?.storageKey));
    const audioNode = nodes.find((node) => node.type === CanvasNodeType.Audio && Boolean(node.metadata?.content || node.metadata?.storageKey));
    const storyboardTask = (id: string, label: string, ready = false): CanvasShortDramaTask => ({ id, label, ready, action: "storyboard", actionLabel: "打开分镜", nodeId: storyboardNodeId, unavailableReason: storyboardNodeId ? undefined : "请先添加分镜脚本" });
    const timelineTask = (id: string, label: string): CanvasShortDramaTask => ({ id, label, action: "edit", actionLabel: "打开剪辑", nodeId: mediaNode?.id, unavailableReason: mediaNode ? undefined : "请先生成或导入音视频素材" });
    const tasks: Record<ShortDramaStageId, CanvasShortDramaTask[]> = {
        story: [
            ...storyTasks.flatMap(task => task.id === "story.plan" ? [task, ...shortDramaGuideGroups.assets.map(group => ({ ...group, stepIds: [...group.stepIds] }))] : [task]),
            { id: "story.audit", label: "正文质量审核" },
        ],
        assets: [],
        storyboard: shortDramaGuideGroups.storyboard.map((group) => ({ ...group, stepIds: [...group.stepIds], nodeId: storyboardNodeId })),
        voice: [],
        video: [
            storyboardTask("video.sample", "代表性镜头样片验证（可选）"),
            storyboardTask("video.generate", "逐镜头视频、对白与音效生成", videoDone),
        ],
        edit: [
            { id: "video.finish", label: "视频表现、候选确认与问题回退", stepIds: ["video.performance", "video.approve"], entryStepId: "video.performance" },
            timelineTask("edit.rough", "镜头排序、入出点与粗剪"),
            timelineTask("edit.picture", "画面调整、转场与包装"),
            timelineTask("edit.sound", "整集背景音乐与声音混音"),
            timelineTask("edit.subtitles", "字幕、转写与样式校对"),
        ],
        review: [
            { id: "review.audit", label: "成片画面、声音与字幕质检", stepIds: ["review.automatic", "review.screening"], entryStepId: "review.automatic", nodeId: finalNode?.id },
            timelineTask("review.revision", "问题修订、重新渲染与复查"),
        ],
        delivery: [
            { id: "delivery.output", label: "渲染、资料包与交付核验", stepIds: ["delivery.render", "delivery.package", "delivery.verify"], entryStepId: "delivery.render" },
            { id: "delivery.promotion", label: "封面、预告、切片与发布文案", unavailableReason: "宣传物料作为独立可选任务待接入" },
        ],
    } as Record<ShortDramaStageId, CanvasShortDramaTask[]>;
    const visibleTasks: Partial<Record<CanvasShortDramaStepId, CanvasShortDramaTask[]>> = {
        story: tasks.story,
        storyboard: [...tasks.storyboard, ...tasks.video],
        edit: tasks.edit,
        review: tasks.review,
        delivery: tasks.delivery,
    };
    const pipelineId = nodeWorkflow(nodes.find((node) => nodeWorkflow(node)?.step === "story.topic"))?.pipelineId || nodes.map(nodeWorkflow).find(Boolean)?.pipelineId;
    const steps = visibleShortDramaStages.map((stage): CanvasShortDramaStep => ({
        id: stage.key,
        label: stage.label,
        nodeId: stage.sourceStages.flatMap((sourceStage) => tasks[sourceStage] || []).find((task) => task.nodeId)?.nodeId,
        tasks: (visibleTasks[stage.key] || []).map((task) => {
            let memberIds = task.stepIds || (shortDramaStep(task.id) ? [task.id as ShortDramaStepId] : []);
            if (!memberIds.length || task.id === "story.topic") return task;
            const memberState = memberIds.map((memberId) => {
                const definition = shortDramaStep(memberId)!;
                const documents = nodes.filter((node) => nodeWorkflow(node)?.step === definition.id && nodeWorkflow(node)?.pipelineId === pipelineId && !nodeWorkflow(node)?.mediaGroup && !nodeWorkflow(node)?.planGroup);
                let statusDetail = "";
                const validDocument = (node: CanvasNodeData) => {
                    if (definition.id === "story.audit" && nodeWorkflow(node)?.role !== "collection") {
                        const state = screenplayAuditState(node, nodes, settings);
                        if (!state.report || state.stale) { statusDetail = state.report ? "正文已变化 · 待复检" : node.metadata?.errorDetails || node.metadata?.taskStage || "审核待完成"; return false; }
                        statusDetail = `质量：${state.report.quality} · 分镜可用性：${state.report.usability} · ${state.report.findings.length} 项问题`;
                        return true;
                    }
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
                if (definition.id === "story.audit") {
                    const bodies = nodes.filter(node => nodeWorkflow(node)?.pipelineId === pipelineId && nodeWorkflow(node)?.step === "story.body" && nodeWorkflow(node)?.role === "document" && node.metadata?.content?.trim());
                    const latestBodies = new Map<number, CanvasNodeData>();
                    for (const body of bodies) if ((nodeWorkflow(latestBodies.get(nodeWorkflow(body)!.episodeNumber!))?.version || 0) <= (nodeWorkflow(body)?.version || 1)) latestBodies.set(nodeWorkflow(body)!.episodeNumber!, body);
                    const checked = [...latestBodies.values()].filter(body => { const state = screenplayAuditState(latestBodyAudit(body, documents), nodes, settings); return !!state.report && !state.stale; }).length;
                    outputReady = latestBodies.size > 0 && checked === latestBodies.size;
                    statusDetail = `已审核 ${checked}/${latestBodies.size} 份正文 · 仅表示诊断完成，不代表作者确认`;
                }
                if (definition.mediaOutput && definition.stage === "assets" && latest) {
                    const sourceNodeIds = nodeWorkflow(latest)!.sourceNodeIds;
                    const subjects = definition.mediaOutput === "audio" ? workflowSoundSubjects({ pipelineId: pipelineId!, sourceNodeIds }, nodes) : workflowImageSubjects({ step: definition.id, sourceNodeIds }, nodes);
                    const completed = subjects.filter((subject) => {
                        const result = documents.filter((node) => nodeWorkflow(node)?.mediaSubjectId === subject.id).at(-1);
                        return Boolean(result && validDocument(result));
                    }).length;
                    outputReady = subjects.length > 0 && completed === subjects.length;
                    if (!outputReady) statusDetail = `已完成 ${completed}/${subjects.length} 项${definition.mediaOutput === "audio" ? "声音试听" : "参考图"}`;
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
                const ready = definition.stage === "story" && definition.id !== "story.audit" ? Boolean(task.ready) : definition.production && !definition.mediaOutput ? Boolean(task.ready) : outputReady;
                if (outputReady && definition.id !== "story.audit") statusDetail = ready ? "" : "文稿已产出 · 实际执行待验收";
                return { definition, outputReady, ready, nodeId: latest?.id, statusDetail };
            });
            const allOptional = memberState.every(member => member.definition.optional);
            const next = memberState.find((member) => !member.outputReady && !member.definition.optional) || memberState.find((member) => !member.outputReady && (allOptional || member.nodeId));
            const ready = memberState.every((member) => member.ready || (!allOptional && member.definition.optional));
            return {
                ...task,
                label: task.label || memberState[0]?.definition.label,
                stepIds: memberIds,
                entryStepId: next?.definition.id || memberState[0]?.definition.id,
                action: "develop",
                actionLabel: task.id === "story.audit" ? "审核" : "生成",
                unavailableReason: undefined,
                nodeId: next?.nodeId || memberState.findLast((member) => member.nodeId)?.nodeId || task.nodeId,
                progressLabel: task.progressLabel || (memberIds.length > 1 ? `${memberState.filter((member) => member.outputReady && !member.definition.optional).length}/${memberState.filter((member) => !member.definition.optional).length} 项已产出` : undefined),
                statusDetail: memberState.filter((member) => !member.definition.optional && member.statusDetail).map((member) => `${member.definition.label}：${member.statusDetail}`).join("；"),
                optional: memberState.every((member) => member.definition.optional),
                ready,
            };
        }),
        status: "pending",
    }));
    const stageDone = steps.map((step) => step.tasks.filter((task) => !task.optional).every((task) => task.ready));
    const current = stageDone.findIndex(value => !value);
    steps.forEach((step, index) => { step.status = stageDone[index] ? "completed" : index === current ? "current" : "pending"; });
    return {
        active,
        completed: stageDone.every(Boolean),
        completedCount: stageDone.filter(Boolean).length,
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
