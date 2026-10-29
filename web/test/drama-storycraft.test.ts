import { expect, test } from "bun:test";
import { dramaGenreContract, dramaGenrePromises, localizedTopicFields, requiresLocalizedTopic } from "../src/lib/drama-storycraft";
import { buildStoryDevelopmentPrompt, createStoryDevelopmentChain, parseStoryTopics, saveStoryDevelopmentNode, storyTopicText } from "../src/lib/canvas/canvas-story-development";
import { changeDramaSetting, defaultShortDramaSettings, DramaGenre, DramaLanguage, DramaMarket, DramaRegion, DramaTone, globalSettingsPrompt, storyBriefFromSettings } from "../src/lib/short-drama-settings";
import { newStorySession, receiveStoryTask, restoreStoryRevision, storyDraftKey } from "../src/services/story-development-session";
import type { GenerationTask } from "../src/services/api/task-center";

const basis = {
    locale: "美国纽约，一家虚构夜间急诊诊所",
    language: "英语",
    nativeTitle: "The Last Invitation",
    nativeLogline: "A vampire doctor must choose whom to invite inside before her pursuer arrives.",
    dramaticEngine: "追捕者即将进入，医生必须在揭露身份与保护病人之间主动选择，反制改变邀请关系。",
    culturalCausality: "诊所熟客之间的信任决定谁愿意开门；吸血鬼邀请机制属于虚构规则，不是当地法律。",
    nativeDialogue: "Doctor: You invited the wrong person.\nVisitor: Then tell me who is outside.",
    dialogueTranslation: "医生：你请错人了。\n来访者：那就告诉我，门外是谁。",
};
const candidate = { title: "最后的邀请", logline: "一家夜间诊所的医生面临不能等待的选择。", conflict: "邀请机制迫使医生揭露身份，对手利用她的承诺反制。", appeal: "限时对抗与身份揭露改变双方力量。", localization: basis };
const response = (value: unknown = candidate) => JSON.stringify({ topics: [value] });

test("every genre has an editorial contract without changing regional settings", () => {
    expect(Object.keys(dramaGenrePromises).sort()).toEqual(Object.values(DramaGenre).sort());
    for (const genre of Object.values(DramaGenre)) expect(dramaGenreContract(genre, DramaTone.Tense)).toContain("题材兑现约定");
    expect(dramaGenreContract(DramaGenre.Revenge, DramaTone.Cathartic)).toContain("主角主动反击与对手反制");
    expect(dramaGenreContract(DramaGenre.Vampire, DramaTone.Cathartic)).toContain("删除该机制后若故事仍完全成立");
    expect(dramaGenreContract(DramaGenre.Vampire, DramaTone.Cathartic)).toContain("当场可见的局面反转");
});

test("a Chinese overseas draw builds local-language concepts and genre stakes in one request", () => {
    const { nodes } = createStoryDevelopmentChain({ x: 0, y: 0 });
    const overseas = changeDramaSetting(defaultShortDramaSettings(), "market", DramaMarket.Overseas);
    const settings = { ...changeDramaSetting(overseas, "language", DramaLanguage.SimplifiedChinese), genre: DramaGenre.Revenge, tone: DramaTone.Cathartic };
    const data = { ...nodes[0].metadata!.storyDevelopment!, brief: { ...storyBriefFromSettings(settings), topicCount: 4 } };
    const prompt = buildStoryDevelopmentPrompt(data, nodes, "OLD_CANDIDATES", "", true);
    expect(prompt).not.toContain("OLD_CANDIDATES");
    expect(prompt).toContain("本土选题创作顺序（在同一次响应内完成");
    expect(prompt).toContain("按该语言先写原创片名");
    expect(prompt).toContain("主角主动反击与对手反制");
    for (const field of localizedTopicFields) expect(prompt).toContain(`"${field}"`);
    expect(prompt).not.toContain("候选需先有不同的本地生活处境");
    expect(globalSettingsPrompt(settings, "story")).toContain("不预设全部题材都讲日常生活");
    expect(globalSettingsPrompt(settings, "assets", "image")).not.toContain("nativeLogline");
});

test("local creative contract follows story region instead of distribution or output language", () => {
    for (const region of Object.values(DramaRegion)) expect(requiresLocalizedTopic(region)).toBe(![DramaRegion.China, DramaRegion.Fictional].includes(region));
    expect(requiresLocalizedTopic(undefined)).toBe(false);
    const { nodes } = createStoryDevelopmentChain({ x: 0, y: 0 });
    const settings = { ...defaultShortDramaSettings(), region: DramaRegion.Europe, language: DramaLanguage.Japanese };
    const data = { ...nodes[0].metadata!.storyDevelopment!, brief: storyBriefFromSettings(settings) };
    const prompt = buildStoryDevelopmentPrompt(data, nodes, "", "", true);
    expect(prompt).toContain("正文语言：日语");
    expect(prompt).toContain("故事发生地：欧洲");
    expect(prompt).toContain('"nativeTitle"');
    expect(buildStoryDevelopmentPrompt({ ...data, brief: storyBriefFromSettings(defaultShortDramaSettings()) }, nodes, "", "", true)).not.toContain('"nativeTitle"');
});

test("localized result basis survives parsing, adoption and production plan handoff", () => {
    const [parsed] = parseStoryTopics(response(), 1, true);
    expect(parsed.localization).toEqual(basis);
    const content = storyTopicText(parsed);
    expect(content).toContain("## 本土创作依据");
    expect(content).toContain(basis.nativeLogline);
    expect(content).toContain(basis.nativeDialogue);
    let { nodes } = createStoryDevelopmentChain({ x: 0, y: 0 });
    nodes = saveStoryDevelopmentNode(nodes, nodes[0], parsed.title, content, nodes[0].metadata!.storyDevelopment!);
    const prompt = buildStoryDevelopmentPrompt(nodes[1].metadata!.storyDevelopment!, nodes, "", "");
    expect(prompt).toContain(basis.nativeLogline);
    expect(prompt).toContain(basis.culturalCausality);
    expect(JSON.parse(JSON.stringify(parsed)).localization).toEqual(basis);
    const { localization, ...old } = candidate;
    expect(parseStoryTopics(response(old), 1)[0].localization).toBeUndefined();
    for (const field of localizedTopicFields) expect(() => parseStoryTopics(response({ ...candidate, localization: { ...localization, [field]: "" } }), 1, true)).toThrow("本土");
});

test("new localized job rejects missing basis without replacing existing candidates or retrying", () => {
    const { nodes } = createStoryDevelopmentChain({ x: 0, y: 0 });
    const original = newStorySession(nodes[0], "fixture");
    original.data.candidates = parseStoryTopics(response(), 1);
    original.content = "已采用的故事保持不变";
    original.job = { operationId: "local-test", status: "running", draw: true, topicCount: 1, requireLocalization: true, draft: storyDraftKey(original), signatures: {} };
    const { localization, ...old } = candidate;
    const task: GenerationTask = { id: "local-task", type: "canvas_text", status: "succeeded", attempts: 1, createdAt: "", updatedAt: "", prompt: "", resultJson: JSON.stringify({ text: response(old) }) };
    const invalid = receiveStoryTask(original, task);
    expect(invalid.job?.status).toBe("failed");
    expect(invalid.data.candidates).toEqual(original.data.candidates);
    expect(invalid.content).toBe(original.content);
    const valid = receiveStoryTask(original, { ...task, resultJson: JSON.stringify({ text: response(candidate) }) });
    expect(valid.job?.status).toBe("succeeded");
    expect(valid.data.candidates![0].localization).toEqual(localization);
    expect(valid.content).toBe(original.content);
    expect(restoreStoryRevision(valid).data.candidates).toEqual(original.data.candidates);
});
