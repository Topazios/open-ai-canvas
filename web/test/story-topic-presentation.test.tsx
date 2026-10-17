import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasTopicSettingsFields } from "../src/components/canvas/canvas-topic-settings-fields";
import { changeStoryTopicSettings, storyTopicSettingFields } from "../src/lib/story-topic-settings";
import { CanvasStoryInputNodeContent } from "../src/components/canvas/canvas-short-drama-entry";
import { CanvasNode } from "../src/components/canvas/canvas-node";
import { defaultShortDramaSettings, dramaSettingLabels, DramaGenre, DramaTone, DramaMarket, DramaTargetMarket, DramaLanguage, storyBriefFromSettings } from "../src/lib/short-drama-settings";
import { buildStoryDevelopmentPrompt } from "../src/lib/canvas/canvas-story-development";
import { newStorySession, recoverStorySession } from "../src/services/story-development-session";
import { createStoryDevelopmentChain } from "../src/lib/canvas/canvas-story-development";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

const noop = () => {};
const topic = () => createStoryDevelopmentChain({ x: 0, y: 0 }).nodes[0];
const renderNode = (node: CanvasNodeData) => renderToStaticMarkup(<CanvasNode data={node} scale={1} isSelected isRelated={false} isFocusRelated={false} isConnectionTarget={false} forceInputVisible showImageInfo={false} onMouseDown={noop} onHoverStart={noop} onHoverEnd={noop} onConnectStart={noop} onResize={noop} onContentChange={noop} onContextMenu={noop} renderNodeContent={(value) => value.metadata?.workflowKind === "story_input" ? <CanvasStoryInputNodeContent node={value} onEdit={noop} /> : null} />);

describe("topic presentation", () => {
    test("shows only editable topic conditions and omits production settings", () => {
        const settings = { ...defaultShortDramaSettings(), premise: "长篇设定".repeat(100) + "\n最后一行", episodeCount: 42 };
        const html = renderToStaticMarkup(<CanvasTopicSettingsFields settings={settings} disabled={false} onChange={noop} />);
        for (const field of storyTopicSettingFields) expect(html).toContain(`aria-label="${dramaSettingLabels[field]}"`);
        for (const label of ["配音语言", "字幕语言", "成片画幅", "总集数", "单集时长", "视觉画风", "制作复杂度", "修改设定"]) expect(html).not.toContain(label);
        expect(html).toContain(settings.premise);
        expect(html).toContain('aria-label="核心设定"');
        expect(html).not.toContain('readonly');
    });
    test("draft changes affect prompts, survive recovery and preserve unrelated settings", () => {
        const settings = defaultShortDramaSettings();
        let patch = changeStoryTopicSettings(settings, undefined, "genre", DramaGenre.Scifi);
        patch = changeStoryTopicSettings(settings, patch, "tone", DramaTone.Tense);
        patch = changeStoryTopicSettings(settings, patch, "premise", "每一天都会遗忘一段记忆");
        expect(patch).toEqual({ genre: DramaGenre.Scifi, tone: DramaTone.Tense, premise: "每一天都会遗忘一段记忆" });
        const latest = { ...settings, episodeCount: 40 };
        const brief = storyBriefFromSettings({ ...latest, ...patch });
        const node = topic();
        const prompt = buildStoryDevelopmentPrompt({ ...node.metadata!.storyDevelopment!, brief }, [node], "", "", true);
        expect(prompt).toContain("科幻");
        expect(prompt).toContain("紧张悬疑");
        expect(prompt).toContain("每一天都会遗忘一段记忆");
        expect(brief.episodeCount).toBe(40);
        const draft = { ...newStorySession(node, "model"), topicSettingsPatch: patch, dirty: true };
        expect(recoverStorySession(draft, node, "model").topicSettingsPatch).toEqual(patch);
    });
    test("market edits reuse regional presets and resetting a field removes its override", () => {
        const settings = defaultShortDramaSettings();
        let patch = changeStoryTopicSettings(settings, undefined, "market", DramaMarket.Overseas);
        patch = changeStoryTopicSettings(settings, patch, "targetMarket", DramaTargetMarket.Japan);
        expect({ ...settings, ...patch }).toMatchObject({ language: DramaLanguage.Japanese, targetMarket: DramaTargetMarket.Japan });
        expect(patch).not.toHaveProperty("episodeCount");
        expect(patch).not.toHaveProperty("duration");
        expect(patch).not.toHaveProperty("revision");
        expect(changeStoryTopicSettings(settings, { genre: DramaGenre.Scifi }, "genre", settings.genre)).toEqual({});
    });
    test("topic has one details action, no duplicate editor or manual connection rails", () => {
        const html = renderNode(topic());
        expect(html.match(/>详情<\/button>/g)?.length).toBe(1);
        expect(html).not.toContain("放大编辑文本");
        expect(html).not.toContain("编辑选题抽取");
        expect(html).not.toContain("输入连接点");
        expect(html).not.toContain("输出连接点");
    });
    test("workflow nodes hide rails while ordinary text nodes retain manual connections", () => {
        const node = topic();
        const ordinary = { ...node, type: CanvasNodeType.Text, metadata: { content: "自由画布文本" } };
        expect(renderNode(ordinary)).toContain("输入连接点");
        expect(renderNode(ordinary)).toContain("输出连接点");
        expect(renderNode(ordinary)).toContain("放大编辑文本");
    });
});
