import { CanvasNodeType } from "@/types/canvas";
import { nanoid } from "nanoid";
import { createCanvasNode } from "./canvas-project-domain";
import { storyBriefFromSettings, DramaSource, type ShortDramaGlobalSettings } from "../short-drama-settings";
import type { WorkflowGenerationRequest } from "./canvas-short-drama-workflow";

export function workflowRequestWithCurrentSettings(request: WorkflowGenerationRequest, settings?: ShortDramaGlobalSettings): WorkflowGenerationRequest {
    if (!settings) return request;
    const brief = storyBriefFromSettings(settings);
    return { ...request, globalSettings: { ...settings }, episodeCount: brief.episodeCount, minutesPerEpisode: brief.minutesPerEpisode };
}

export function newDramaCanvasContent(settings: ShortDramaGlobalSettings, sourceContent = "") {
    const brief = storyBriefFromSettings(settings);
    if (settings.source !== DramaSource.Original && !sourceContent.trim()) throw new Error("请导入或粘贴已有故事/剧本");
    const topic = createCanvasNode(CanvasNodeType.Text, { x: 160, y: 160 }, {
        workflowKind: "story_input", workflowTitle: "选题抽取", content: settings.source === DramaSource.Original ? "" : sourceContent.trim(), status: "idle",
        storyDevelopment: { stage: "topic", pipelineId: nanoid(), sourceNodeIds: [], brief },
    });
    topic.title = settings.source === DramaSource.Original ? "选题抽取" : "故事来源与选题";
    topic.width = 400; topic.height = 280;
    return { globalSettings: { ...settings }, starterMode: "guided" as const, nodes: [topic], connections: [] };
}
