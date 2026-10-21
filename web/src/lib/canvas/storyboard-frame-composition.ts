import { StoryboardFrameKind, type StoryboardFrame, type StoryboardRow } from "@/types/canvas";

export const storyboardCompositionRule = "【镜头空间与构图】以成片摄影机看到的画面为准，画面左右不等于人物自身左右；故事中人物持有的相机不是本画面的摄影机。按本镜头景别与裁切取景，明确主要主体和陪体的画面位置、可见身体范围、约占画幅高度及前中后景；占幅随景别和纵深确定，不把所有人统一画成全身或相同大小。人物身高与体型沿用资产，近大远小只由合理透视产生，不靠拉长身体、缩头或放大手臂填满画幅；遵循项目既定写实或风格化比例。人物间距、朝向、视线、持物与接触必须能在同一空间实现；接触仅在该时刻已发生时呈现。连续画面保持站位侧别、轴线与空间尺度，仅随明确的移动、运镜或切镜改变。";
const referenceRule = "参考资产只提供对应人物身份、当场服化和物件/环境外观，不复制设定板的多视图、全身展示、居中摆放或参考图占幅；单幅剧情构图以当前镜头为准。多套服装只选本场已指定的一套，不混穿、不增加人物。";
const states = ["起幅状态", "落幅状态", "动作过程", "构图基准", "起幅机位", "落幅机位", "机位运动"];

// New shots have explicit endpoints; older shots retain their sequence as context.
function endpoint(text: string, label: string) {
    const start = text.indexOf(`【${label}】`);
    if (start < 0) return "";
    const from = start + label.length + 2;
    const ends = states.map(state => text.indexOf(`【${state}】`, from)).filter(index => index >= 0);
    return text.slice(from, ends.length ? Math.min(...ends) : undefined).trim();
}

export function storyboardStaticSource(row: StoryboardRow, kind: StoryboardFrameKind) {
    const video = row.videoMotionPrompt?.trim();
    // Only unwrap our canonical serialization; arbitrary user-edited prompts stay authoritative.
    const serialized = video?.match(/^镜头 [^\n]+\n画面：([\s\S]*?)\n镜头：([\s\S]*?)\n对白：([\s\S]*?)\n声音：([\s\S]*?)\n衔接：([\s\S]*)$/);
    const visual = serialized ? serialized[1] : video || row.plotDescription;
    const camera = serialized ? serialized[2] : video ? "" : row.camera;
    const continuity = serialized ? serialized[5] : video ? "" : row.continuityOut;
    const state = endpoint(visual, kind === StoryboardFrameKind.Start ? "起幅状态" : "落幅状态");
    const cameraState = endpoint(camera, kind === StoryboardFrameKind.Start ? "起幅机位" : "落幅机位");
    const framing = cameraState ? [endpoint(camera, "构图基准"), cameraState].filter(Boolean).join("\n") : camera;
    return [state ? `该时刻画面：${state}` : `动作时序依据（只取${kind === StoryboardFrameKind.Start ? "起始" : "结束"}一个时刻，不把动作叠画）：\n${visual}`,
        framing ? `取景依据：${framing}` : "",
        kind === StoryboardFrameKind.End && continuity ? `落幅衔接：${continuity}` : ""].filter(Boolean).join("\n");
}

export function storyboardFrameBoundaryPrompt(row: StoryboardRow, kind: StoryboardFrameKind.Start | StoryboardFrameKind.End) {
    return [`镜头 ${row.shotCode || row.shotNumber} 的${kind === StoryboardFrameKind.Start ? "首帧" : "尾帧"}，单幅静态画面。`,
        kind === StoryboardFrameKind.Start ? "表现第0秒的起始姿态、视线和空间关系，不提前执行后续动作或套用落幅状态。" : "表现本镜头结束时的最终姿态、道具位置和情绪，不重复此前已经结束的动作。",
        "只呈现该时刻，不拼图、不画多个时间点或运动轨迹；对白与声音只帮助理解表情，不在画面写字幕。若镜头有运动，首帧用起幅机位，尾帧用落幅机位，不把整个运动过程压成一张图。",
        storyboardStaticSource(row, kind)].join("\n");
}

export function applyStoryboardFrameComposition(prompt: string, row: StoryboardRow, frame: StoryboardFrame) {
    // Upgrade the saved automatic boundary block on explicit generation/retry, preserving other edits.
    if (frame.kind !== StoryboardFrameKind.Key && frame.prompt && prompt.includes(frame.prompt)) {
        prompt = prompt.replace(frame.prompt, storyboardFrameBoundaryPrompt(row, frame.kind));
    }
    if (prompt.includes(storyboardCompositionRule)) return prompt;
    const camera = row.videoMotionPrompt.match(/\n镜头：([\s\S]*?)\n对白：/)?.[1] || (!row.videoMotionPrompt ? row.camera : "");
    const moment = frame.kind === StoryboardFrameKind.Key ? [`关键帧仅表现镜头内第${frame.timeSeconds}秒的单一状态，动作进度以该时间点为准；不得套用镜头结束状态。`, camera ? `本镜头取景基准：${camera}` : ""].filter(Boolean).join("\n") : "";
    return [prompt, storyboardCompositionRule, referenceRule, moment].filter(Boolean).join("\n\n");
}
