import { expect, test } from "bun:test";
import { AssetStateSource, validateAssetVariant } from "../src/lib/production-continuity";
import { DramaVoiceLanguage, defaultShortDramaSettings } from "../src/lib/short-drama-settings";
import { ProductionSoundKind, projectVoiceCalibration, voiceCalibrationTexts } from "../src/lib/production-sound";
import { assetSheetDimensions } from "../src/lib/asset-sheet-dimensions";
import { createWorkflowSounds, workflowSoundSubjects } from "../src/lib/canvas/canvas-workflow-sounds";
import { createCanvasNode, createStoryboardRow } from "../src/lib/canvas/canvas-project-domain";
import { workflowSignature, type WorkflowGenerationRequest } from "../src/lib/canvas/canvas-short-drama-workflow";
import { storyboardPreviousFrameSource, resolveEpisodeShotAssets, storyboardFrameHash } from "../src/lib/canvas/workflow-episode-storyboard";
import { buildNodeGenerationContext } from "../src/components/canvas/canvas-node-generation";
import { CanvasNodeType, StoryboardStartFrameMode } from "../src/types/canvas";
import { ShortDramaStep } from "../src/lib/short-drama-steps";

test("explicit transitions require cause, scope and recovery without approval", () => {
    const valid = { code: "CHR-0001-V0001", name: "兽化形态", description: "变身为兽形", source: AssetStateSource.Design, basis: "故事中的变身事件", trigger: "触发变身", previousState: "人形", scope: "变身期间", recovery: "解除变身" };
    expect(() => validateAssetVariant(valid)).not.toThrow();
    expect(() => validateAssetVariant({ ...valid, trigger: "" })).toThrow("触发事件");
    expect(() => validateAssetVariant({ name: "旧状态", description: "旧文稿" })).toThrow("重大变化");
});

test("every production language has one shared text; language changes do not reuse an incompatible override", () => {
    const settings = defaultShortDramaSettings();
    for (const language of Object.values(DramaVoiceLanguage)) expect(voiceCalibrationTexts[language]?.length).toBeGreaterThan(20);
    const custom = { ...settings, voiceCalibrationText: "人物统一试听文本", voiceCalibrationLanguage: settings.voiceLanguage };
    expect(projectVoiceCalibration(custom)).toBe(custom.voiceCalibrationText);
    expect(projectVoiceCalibration({ ...custom, voiceLanguage: DramaVoiceLanguage.English })).toBe(voiceCalibrationTexts.en);
});

function sounds() {
    const globalSettings = defaultShortDramaSettings();
    const asset = (code: string, kind: ProductionSoundKind) => createCanvasNode(CanvasNodeType.Text, { x: 0, y: 0 }, {
        content: "声音档案：低沉音色，稳定口音", status: "success", shortDrama: { pipelineId: "p", step: "story.plan", stage: "story", role: "document", sourceNodeIds: [], sourceSignatures: {}, assetIdentity: { id: code, code, kind: "sound" },
            assetProfile: { soundKind: kind, aliases: [], occurrences: [], variants: [], sounds: [], conflicts: [], references: [], indexContent: "" } },
    });
    const a = asset("AUD-0001", ProductionSoundKind.Voice), b = asset("AUD-0002", ProductionSoundKind.Voice), prop = asset("AUD-0003", ProductionSoundKind.Prop);
    const group = createCanvasNode(CanvasNodeType.Frame, { x: 0, y: 0 }, { shortDrama: { pipelineId: "p", stage: "story", step: "story.plan", role: "collection", sourceNodeIds: [a.id, b.id, prop.id], sourceSignatures: {} } });
    for (const node of [a,b,prop]) node.parentId = group.id;
    const request: WorkflowGenerationRequest = { step: ShortDramaStep.VoiceSamples, pipelineId: "p", sourceNodeIds: [group.id], model: "fixture::audio", instruction: "克制表演", episodeCount: 1, minutesPerEpisode: "1-2", start: 1, count: 1, globalSettings, imageSubjectIds: [a.id,b.id],
        soundSettings: { kind: ProductionSoundKind.Voice, text: projectVoiceCalibration(globalSettings), voice: "alloy", format: "mp3", speed: "1" }, soundVoices: { [b.id]: "echo" } };
    return { a,b,prop,group,request,nodes:[group,a,b,prop] };
}

test("sound assets create real audio tasks with isolated spoken text, character voice snapshots and current source signatures", () => {
    const f = sounds();
    expect(workflowSoundSubjects(f.request,f.nodes).map(node=>node.id)).toEqual([f.a.id,f.b.id]);
    const result = createWorkflowSounds(f.request, f.nodes, [], { x: 500, y: 0 });
    expect(result.created.map(node=>node.type)).toEqual([CanvasNodeType.Audio,CanvasNodeType.Audio]);
    expect(result.created.map(node=>node.metadata?.audioVoice)).toEqual(["alloy","echo"]);
    for (const node of result.created) {
        expect(node.metadata?.prompt).toBe(f.request.soundSettings!.text);
        expect(node.metadata?.prompt).not.toContain("声音档案");
        expect(node.metadata?.audioInstructions).toContain("低沉音色");
        expect(node.metadata?.audioInstructions).toContain("克制表演");
        const subject = f.nodes.find(source=>source.id===node.metadata?.shortDrama?.mediaSubjectId)!;
        expect(node.metadata?.shortDrama?.sourceSignatures[subject.id]).toBe(workflowSignature(subject));
    }
    const appended = createWorkflowSounds({ ...f.request, imageSubjectIds:[f.a.id] },result.nodes,result.connections,{x:500,y:0});
    expect(appended.created[0].parentId).toBe(result.created[0].parentId);
    expect(appended.created[0].metadata?.shortDrama?.version).toBe(2);
    expect(appended.nodes.find(node=>node.id===result.created[1].id)).toEqual(result.nodes.find(node=>node.id===result.created[1].id));
    expect(() => createWorkflowSounds({ ...f.request, imageSubjectIds:[f.prop.id] },f.nodes,[],{x:0,y:0})).toThrow();
    expect(() => createWorkflowSounds({ ...f.request, soundSettings:{...f.request.soundSettings!,text:"过期文本"} },f.nodes,[],{x:0,y:0})).toThrow("已变化");
});

test("camera cuts and state transitions preserve identity without reusing incompatible pixels", () => {
    const a = createStoryboardRow(1,{ id:"a",assetKeys:["CHR-0001","SCN-0001"],camera:"固定",shotSize:"中景" });
    const b = { ...a,id:"b" };
    expect(storyboardPreviousFrameSource(b,[a,b])?.id).toBe("a");
    for (const patch of [{camera:"俯拍"},{shotSize:"全景"},{assetKeys:["CHR-0001-V0001","SCN-0001"]},{assetKeys:["CHR-0001","SCN-0002"]}]) {
        const next = {...b,...patch}; expect(storyboardPreviousFrameSource(next,[a,next])).toBeUndefined();
    }
    const variant = {...a,assetKeys:["CHR-0001-V0001","SCN-0001"]};
    expect(storyboardPreviousFrameSource(b,[variant,b])).toBeUndefined();
    const independent = {...b,startFrameMode:StoryboardStartFrameMode.Independent};
    expect(storyboardPreviousFrameSource(independent,[a,independent])).toBeUndefined();
});

test("asset-sheet metadata extracts only dimensions already stated in the dossier", () => {
    expect(assetSheetDimensions("## 外观\n身高：168cm\n肩宽 42cm\n情绪：疲惫", "character")).toEqual(["身高：168cm", "肩宽 42cm"]);
    expect(assetSheetDimensions("## 空间布局\n长12m，宽8m，高3.2m", "environment")).toEqual(["长12m", "宽8m", "高3.2m"]);
    expect(assetSheetDimensions("## 尺寸\n尺寸：长12m × 宽8m × 高3.2m", "environment")).toEqual(["长12m", "宽8m", "高3.2m"]);
    expect(assetSheetDimensions("身高：168cm\n体重：52kg\n三围：84cm/62cm/88cm", "character")).toEqual(["身高：168cm", "体重：52kg", "三围：84cm/62cm/88cm"]);
    expect(assetSheetDimensions("长12m，宽8m，净高3.2m，面积96平方米", "environment")).toEqual(["长12m", "宽8m", "净高3.2m", "面积96平方米"]);
    expect(assetSheetDimensions("长度42cm，宽度20cm，高度18cm", "prop")).toEqual(["长度42cm", "宽度20cm", "高度18cm"]);
});

test("AUD references resolve to audio for video while frame prompts retain all physical anchors without audio", () => {
    const f = sounds(), result = createWorkflowSounds({...f.request,imageSubjectIds:[f.a.id]},f.nodes,[],{x:0,y:0});
    const audio = result.created[0]; audio.metadata = {...audio.metadata,status:"success",storageKey:"resource:sound",content:"/api/resources/sound/file"};
    const prop = createCanvasNode(CanvasNodeType.Text,{x:0,y:0},{content:`## 外观与材质\n${"尺寸锚点；".repeat(200)}长度0.42米，手掌宽度的4倍。\n声音：不应进入静帧的金属撞击声\n材质：青铜。\n### 尺度补充\n距桌沿20厘米。\n### 声音设计\n不应进入静帧的混响`,status:"success",shortDrama:{...f.a.metadata!.shortDrama!,assetIdentity:{id:"prop",code:"PRP-0001",kind:"prop"},assetProfile:undefined}});
    const row = createStoryboardRow(1,{id:"row",videoMotionPrompt:"PRP-0001移到桌面",assetKeys:["PRP-0001","AUD-0001"]});
    const script = createCanvasNode(CanvasNodeType.Script,{x:0,y:0},{shortDrama:{pipelineId:"p",stage:"storyboard",step:"direction.shots",role:"document",sourceNodeIds:[f.a.id,prop.id],sourceSignatures:{}},storyboard:{rows:[row],visibleColumns:[],referenceNodeIds:[]}});
    const image = createCanvasNode(CanvasNodeType.Image,{x:0,y:0},{status:"success",storageKey:"resource:prop",shortDrama:{...prop.metadata!.shortDrama!,mediaKind:"image",mediaSubjectId:prop.id,sourceNodeIds:[prop.id],sourceSignatures:{[prop.id]:workflowSignature(prop)}}});
    const nodes = [...result.nodes,prop,script,image];
    const resolved = resolveEpisodeShotAssets(script,row,nodes);
    expect(resolved.media.map(node=>node.type).sort()).toEqual([CanvasNodeType.Audio,CanvasNodeType.Image].sort());
    const videoContext = buildNodeGenerationContext(script.id,nodes,[],row.videoMotionPrompt,[],false,row.id);
    expect(videoContext.referenceAudios).toHaveLength(1);
    const frame = createCanvasNode(CanvasNodeType.Image,{x:0,y:0},{storyboardFrame:{scriptId:script.id,rowId:row.id,frameId:"start",kind:"start",sourcePromptHash:""}});
    // Use the same persisted hash contract as the real list's frame tasks.
    frame.metadata!.storyboardFrame!.sourcePromptHash=storyboardFrameHash(row);
    row.frames = [{ id:"start",kind:"start",sourcePromptHash:storyboardFrameHash(row),prompt:"道具静态画面",timeSeconds:0,imageNodeId:frame.id }];
    const before = JSON.stringify(nodes);
    for (const hasReference of [false, true]) {
        const context = buildNodeGenerationContext(frame.id,[...nodes.filter(node => hasReference || node.id !== image.id),frame],[],"道具静态画面",[]);
        expect(context.prompt).toContain("长度0.42米"); expect(context.prompt).toContain("距桌沿20厘米");
        expect(context.prompt).not.toContain("低沉音色"); expect(context.prompt).not.toContain("不应进入静帧的");
        expect(context.referenceAudios).toHaveLength(0); expect(context.referenceImages).toHaveLength(hasReference ? 1 : 0);
    }
    expect(JSON.stringify(nodes)).toBe(before);
});
