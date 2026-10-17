import { describe, expect, test } from "bun:test";
import { defaultShortDramaSettings, DramaSource, DramaDuration, DramaGenre, DramaLanguage, DramaRegion, DramaVisualForm, DramaVisualStyle, dramaSettingOptions, globalSettingsPrompt, storyBriefFromSettings, validateShortDramaSettings } from "../src/lib/short-drama-settings";
import { newDramaCanvasContent, workflowRequestWithCurrentSettings } from "../src/lib/canvas/canvas-global-settings";
import { buildStoryDevelopmentPrompt } from "../src/lib/canvas/canvas-story-development";
import { createWorkflowDocuments, nodeWorkflow, workflowParameters } from "../src/lib/canvas/canvas-short-drama-workflow";
import { createWorkflowImages, workflowImageSubjects } from "../src/lib/canvas/canvas-workflow-images";
import { workflowImageFixture } from "./fixtures/workflow-image-project";
import { canvasContentHash } from "../src/lib/canvas/canvas-content";
import { parseCanvasStorageDocument, serializeCanvasStorageDocument } from "../src/lib/canvas/canvas-storage-revision";
import type { CanvasProject } from "../src/stores/canvas/use-canvas-store";
import { changeDramaSetting, DramaMarket, DramaVoiceLanguage, DramaTargetMarket, dramaMarketProfiles, dramaOptionsForSettings, dramaTargetMarketOptions, resolvedDramaTargetMarket, dramaSettingSections, DramaEra, DramaTone } from "../src/lib/short-drama-settings";

describe("canvas global creation settings", () => {
    test("all regional presets are complete, selectable and retain the full editable catalog", () => {
        const original = defaultShortDramaSettings();
        for (const market of Object.values(DramaMarket)) {
            const base = changeDramaSetting(original, "market", market);
            for (const { value: targetMarket } of dramaTargetMarketOptions(market)) {
                const draft = changeDramaSetting(base, "targetMarket", targetMarket);
                expect(validateShortDramaSettings(draft).targetMarket).toBe(targetMarket);
                for (const key of ["genre", "tone", "visualStyle", "era"] as const) {
                    const groups = dramaOptionsForSettings(draft, key);
                    const flat = groups.flatMap((group) => "options" in group ? group.options : [group]);
                    expect(flat).toHaveLength(dramaSettingOptions[key].length);
                    expect(new Set(flat.map((item) => item.value)).size).toBe(flat.length);
                    expect(flat[0].value).toBe(dramaMarketProfiles[targetMarket][key][0]);
                    expect(flat.some(({ value }) => value === draft[key])).toBe(true);
                    for (const value of dramaMarketProfiles[targetMarket][key]) expect(dramaSettingOptions[key].some((option) => option.value === value)).toBe(true);
                }
            }
        }
        expect(() => changeDramaSetting(original, "targetMarket", DramaTargetMarket.Japan)).toThrow("不匹配");
        expect(() => validateShortDramaSettings({ ...original, targetMarket: DramaTargetMarket.Japan })).toThrow("不匹配");
        expect(Object.keys(dramaMarketProfiles).sort()).toEqual(Object.values(DramaTargetMarket).sort());
    });

    test("regional switching applies all four creative defaults and localized languages atomically", () => {
        const original = changeDramaSetting(defaultShortDramaSettings(), "market", DramaMarket.Overseas);
        const japan = changeDramaSetting(original, "targetMarket", DramaTargetMarket.Japan);
        expect(japan).toMatchObject({ language: DramaLanguage.Japanese, voiceLanguage: DramaVoiceLanguage.Japanese, subtitleLanguage: DramaLanguage.Japanese, region: DramaRegion.Japan, genre: DramaGenre.Underdog, tone: DramaTone.Cathartic, visualStyle: DramaVisualStyle.Natural, era: DramaEra.Contemporary });
        const manual = { ...japan, genre: DramaGenre.Scifi, era: DramaEra.Future, region: DramaRegion.Fictional, visualStyle: DramaVisualStyle.Neon };
        expect(changeDramaSetting(manual, "targetMarket", DramaTargetMarket.Japan)).toBe(manual);
        const brazil = changeDramaSetting(manual, "targetMarket", DramaTargetMarket.Brazil);
        expect(brazil).toMatchObject({ targetMarket: DramaTargetMarket.Brazil, language: DramaLanguage.Portuguese, voiceLanguage: DramaVoiceLanguage.Portuguese, subtitleLanguage: DramaLanguage.Portuguese, region: DramaRegion.Brazil, visualStyle: DramaVisualStyle.Natural, era: DramaEra.Contemporary });
        const both = changeDramaSetting(changeDramaSetting(original, "market", DramaMarket.Both), "targetMarket", DramaTargetMarket.Thailand);
        expect(both).toMatchObject({ language: DramaLanguage.SimplifiedChinese, voiceLanguage: DramaVoiceLanguage.Mandarin, subtitleLanguage: DramaLanguage.Thai, region: DramaRegion.China });
        expect(manual.genre).toBe(DramaGenre.Scifi);
    });

    test("old settings remain valid and read-only lookup does not apply new defaults", () => {
        const old = { ...defaultShortDramaSettings(), targetMarket: undefined, market: DramaMarket.Overseas, language: DramaLanguage.Japanese, genre: DramaGenre.Urban, tone: DramaTone.Dark, visualStyle: DramaVisualStyle.Ink, era: DramaEra.Ancient };
        const serialized = JSON.stringify(old);
        const restored = validateShortDramaSettings(JSON.parse(serialized));
        expect(resolvedDramaTargetMarket(restored)).toBe(DramaTargetMarket.Japan);
        expect(resolvedDramaTargetMarket({ ...restored, language: DramaLanguage.English, region: DramaRegion.Europe })).toBe(DramaTargetMarket.Europe);
        expect(dramaOptionsForSettings(restored, "genre").length).toBe(2);
        expect(changeDramaSetting(restored, "targetMarket", DramaTargetMarket.Japan)).toBe(restored);
        expect(globalSettingsPrompt(restored, "story")).not.toContain("目标市场：");
        expect(JSON.stringify(restored)).toBe(serialized);
        expect(restored).toMatchObject({ genre: DramaGenre.Urban, tone: DramaTone.Dark, visualStyle: DramaVisualStyle.Ink, era: DramaEra.Ancient });
    });

    test("form workflow order covers each primary field once", () => {
        expect(dramaSettingSections.map(({ id }) => id)).toEqual(["distribution", "story", "visual", "production"]);
        const fields = dramaSettingSections.flatMap(({ fields }) => fields);
        expect(new Set(fields).size).toBe(fields.length);
        expect([...fields, "ending", "contentRating"].sort()).toEqual([...Object.keys(dramaSettingOptions), "episodeCount"].sort());
    });

    test("new regional choices reach text and image task snapshots and serialization", () => {
        const settings = changeDramaSetting(changeDramaSetting(defaultShortDramaSettings(), "market", DramaMarket.Overseas), "targetMarket", DramaTargetMarket.Brazil);
        const saved = validateShortDramaSettings(JSON.parse(JSON.stringify(settings)));
        for (const stage of ["story", "assets", "storyboard"]) {
            for (const media of ["text", "image"] as const) {
                const prompt = globalSettingsPrompt(saved, stage, media);
                if (stage === "assets" && media === "image") {
                    expect(prompt).toContain("故事发生地：");
                    expect(prompt).not.toContain("目标市场：");
                } else expect(prompt).toContain("目标市场：巴西（葡语）");
            }
        }
        const created = newDramaCanvasContent(saved);
        const topic = created.nodes[0];
        expect(topic.metadata!.storyDevelopment!.brief.globalSettings?.targetMarket).toBe(DramaTargetMarket.Brazil);
        const prompt = buildStoryDevelopmentPrompt(topic.metadata!.storyDevelopment!, created.nodes, "", "", true);
        expect(prompt).toContain("正文语言：巴西葡萄牙语");
        expect(prompt).toContain("故事发生地：巴西");
    });

    test("market changes replace regional creative defaults and locale without changing production scope", () => {
        const initial = { ...defaultShortDramaSettings(), episodeCount: 24, duration: DramaDuration.Micro, genre: DramaGenre.Suspense, premise: "已有设定" };
        const overseas = changeDramaSetting(initial, "market", DramaMarket.Overseas);
        expect(overseas).toMatchObject({ market: DramaMarket.Overseas, targetMarket: DramaTargetMarket.NorthAmerica, language: DramaLanguage.English, voiceLanguage: DramaVoiceLanguage.English, subtitleLanguage: DramaLanguage.English, region: DramaRegion.NorthAmerica, genre: DramaGenre.Romance, tone: DramaTone.Romantic, visualStyle: DramaVisualStyle.Glossy, era: DramaEra.Contemporary, episodeCount: 24, duration: DramaDuration.Micro, premise: "已有设定" });
        const both = changeDramaSetting(overseas, "market", DramaMarket.Both);
        expect(both).toMatchObject({ market: DramaMarket.Both, targetMarket: DramaTargetMarket.Global, language: DramaLanguage.SimplifiedChinese, voiceLanguage: DramaVoiceLanguage.Mandarin, subtitleLanguage: DramaLanguage.English, region: DramaRegion.China });
        expect(changeDramaSetting(both, "market", DramaMarket.Domestic)).toMatchObject({ market: DramaMarket.Domestic, targetMarket: DramaTargetMarket.China, genre: DramaGenre.Family, episodeCount: 24, duration: DramaDuration.Micro });
        expect(initial.market).toBe(DramaMarket.Domestic);
        const customized = changeDramaSetting(changeDramaSetting(overseas, "language", DramaLanguage.Japanese), "region", DramaRegion.EastAsia);
        expect(customized).toMatchObject({ market: DramaMarket.Overseas, language: DramaLanguage.Japanese, voiceLanguage: DramaVoiceLanguage.Japanese, subtitleLanguage: DramaLanguage.Japanese, region: DramaRegion.EastAsia });
        expect(changeDramaSetting(customized, "market", DramaMarket.Overseas)).toBe(customized);
        expect(validateShortDramaSettings(JSON.parse(JSON.stringify(customized)))).toEqual(customized);
        expect(() => changeDramaSetting(initial, "market", "unknown")).toThrow();
    });

    test("language follows through to dubbing and matching subtitles while keeping translation subtitles", () => {
        const initial = defaultShortDramaSettings();
        const japanese = changeDramaSetting(initial, "language", DramaLanguage.Japanese);
        expect(japanese).toMatchObject({ voiceLanguage: DramaVoiceLanguage.Japanese, subtitleLanguage: DramaLanguage.Japanese });
        const translated = changeDramaSetting(japanese, "subtitleLanguage", DramaLanguage.English);
        const french = changeDramaSetting(translated, "language", DramaLanguage.French);
        expect(french).toMatchObject({ voiceLanguage: DramaVoiceLanguage.French, subtitleLanguage: DramaLanguage.English });
        const customized = changeDramaSetting(french, "voiceLanguage", DramaVoiceLanguage.Cantonese);
        expect(validateShortDramaSettings(customized).voiceLanguage).toBe(DramaVoiceLanguage.Cantonese);
    });

    test("distribution and locale reach generated prompts and saved task snapshots", () => {
        const settings = changeDramaSetting(defaultShortDramaSettings(), "market", DramaMarket.Overseas);
        const created = newDramaCanvasContent(settings);
        const topic = created.nodes[0];
        const prompt = buildStoryDevelopmentPrompt(topic.metadata!.storyDevelopment!, created.nodes, "", "", true);
        for (const text of ["发行方向：海外", "目标市场：北美（英语）", "正文语言：英语", "配音语言：英语", "字幕语言：英语", "故事发生地：北美"]) expect(prompt).toContain(text);
        for (const stage of ["story", "assets", "storyboard"]) expect(globalSettingsPrompt(settings, stage)).toContain("发行方向：海外");
        expect(globalSettingsPrompt(settings, "assets", "image")).toContain("故事发生地：北美");
        expect(globalSettingsPrompt(settings, "assets", "image")).not.toContain("发行方向：海外");
        const snapshot = JSON.stringify(topic.metadata!.storyDevelopment!.brief.globalSettings);
        const next = changeDramaSetting(settings, "market", DramaMarket.Domestic);
        expect(next.market).toBe(DramaMarket.Domestic);
        expect(JSON.stringify(topic.metadata!.storyDevelopment!.brief.globalSettings)).toBe(snapshot);
    });

    test("every selection round-trips a stable supported enum; unknown values are rejected", () => {
        const initial = defaultShortDramaSettings();
        expect(validateShortDramaSettings(JSON.parse(JSON.stringify(initial)))).toEqual(initial);
        for (const [key, options] of Object.entries(dramaSettingOptions)) {
            expect(new Set(options.map((option) => option.value)).size).toBe(options.length);
            for (const option of options) {
                const compatible = { ...initial, targetMarket: undefined };
                if (key === "targetMarket") compatible.market = option.value === DramaTargetMarket.China ? DramaMarket.Domestic : DramaMarket.Overseas;
                expect(() => validateShortDramaSettings({ ...compatible, [key]: option.value })).not.toThrow();
            }
            expect(() => validateShortDramaSettings({ ...initial, [key]: "invented-value" })).toThrow();
        }
        for (const episodeCount of [0, 201, 2.5, NaN]) expect(() => validateShortDramaSettings({ ...initial, episodeCount })).toThrow();
    });

    test("new canvas carries a ready topic brief without starting generation or requiring an invented premise", () => {
        const settings = { ...defaultShortDramaSettings(), language: DramaLanguage.English, region: DramaRegion.Europe, genre: DramaGenre.Suspense, duration: DramaDuration.Micro, episodeCount: 8 };
        const created = newDramaCanvasContent(settings);
        expect(created.nodes).toHaveLength(1);
        const topic = created.nodes[0];
        expect(topic.metadata?.taskId).toBeUndefined();
        expect(topic.metadata?.storyDevelopment?.brief).toMatchObject({ episodeCount: 8, minutesPerEpisode: "0.5-1", genre: "悬疑" });
        const prompt = buildStoryDevelopmentPrompt(topic.metadata!.storyDevelopment!, created.nodes, "", "", true);
        expect(prompt).toContain("正文语言：英语");
        expect(prompt).toContain("故事发生地：欧洲");
        expect(prompt).toContain("总集数：8");
        expect(created.globalSettings).not.toBe(settings);
    });

    test("adaptations require real source material and preserve it separately from the compact settings", () => {
        const settings = { ...defaultShortDramaSettings(), source: DramaSource.Adaptation };
        expect(() => newDramaCanvasContent(settings)).toThrow("请导入");
        const source = "原作：主角发现了另一条人生。";
        const created = newDramaCanvasContent(settings, source);
        expect(created.nodes[0].metadata?.content).toBe(source);
        expect(JSON.stringify(created.globalSettings)).not.toContain(source);
        expect(storyBriefFromSettings(settings).premise).toContain("依据提供的原文");
    });

    test("current settings override old global constraints for NEW tasks, while task snapshots and source nodes stay unchanged", () => {
        const original = defaultShortDramaSettings();
        const created = newDramaCanvasContent(original);
        created.nodes[0].metadata!.content = "已采用选题";
        const before = JSON.stringify(created.nodes);
        const current = { ...original, episodeCount: 6, revision: 2, language: DramaLanguage.Japanese };
        const request = { step: "story.plan" as const, pipelineId: nodeWorkflow(created.nodes[0])!.pipelineId, sourceNodeIds: [created.nodes[0].id],
            model: "test", instruction: "", episodeCount: 12, minutesPerEpisode: "3-5", start: 1, count: 1, globalSettings: current };
        const result = createWorkflowDocuments(request, created.nodes, [], { x: 0, y: 0 });
        const plan = result.created[0];
        expect(nodeWorkflow(plan)?.parameters?.episodeCount).toBe(6);
        expect(plan.metadata?.prompt).toContain("正文语言：日语");
        expect(JSON.stringify(created.nodes)).toBe(before);
        current.episodeCount = 10;
        expect(nodeWorkflow(plan)?.parameters?.globalSettings?.episodeCount).toBe(6);
        expect(workflowParameters(result.nodes).globalSettings?.revision).toBe(2);
    });

    test("creation resolves current canvas settings even when the generator holds an old snapshot", () => {
        const old = defaultShortDramaSettings();
        const created = newDramaCanvasContent(old);
        created.nodes[0].metadata!.content = "已采用选题";
        const request = { step: "story.plan" as const, pipelineId: nodeWorkflow(created.nodes[0])!.pipelineId, sourceNodeIds: [created.nodes[0].id], model: "test", instruction: "", episodeCount: 12, minutesPerEpisode: "3-5", start: 1, count: 1, globalSettings: old };
        const latest = { ...changeDramaSetting(old, "market", DramaMarket.Overseas), revision: 2, episodeCount: 6, duration: DramaDuration.Short };
        const resolved = workflowRequestWithCurrentSettings(request, latest);
        const plan = createWorkflowDocuments(resolved, created.nodes, [], { x: 0, y: 0 }).created[0];
        expect(nodeWorkflow(plan)?.parameters).toMatchObject({ episodeCount: 6, minutesPerEpisode: "1-2", globalSettings: latest });
        expect(plan.metadata?.prompt).toContain("发行方向：海外");
        expect(plan.metadata?.prompt).toContain("正文语言：英语");
        expect(request.globalSettings).toEqual(old);
        expect(created.nodes[0].metadata?.storyDevelopment?.brief.globalSettings).toEqual(old);
        latest.episodeCount = 10;
        expect(resolved.globalSettings?.episodeCount).toBe(6);
        expect(workflowRequestWithCurrentSettings(request)).toBe(request);
    });

    test("image generation resolves updated settings from the canvas instead of its source nodes", () => {
        const fixture = workflowImageFixture();
        const settings = { ...defaultShortDramaSettings(), revision: 2, visualForm: DramaVisualForm.Animation2D, visualStyle: DramaVisualStyle.Ink };
        const imageSubjectIds = workflowImageSubjects(fixture.request, fixture.nodes).map((node) => node.id);
        const request = workflowRequestWithCurrentSettings({ ...fixture.request, globalSettings: defaultShortDramaSettings(), imageSubjectIds }, settings);
        const before = JSON.stringify(fixture.nodes);
        const result = createWorkflowImages(request, fixture.nodes, fixture.connections, { x: 0, y: 0 });
        expect(result.created.length).toBeGreaterThan(0);
        for (const node of result.created) {
            expect(node.metadata?.prompt).toContain("视觉画风：水墨国风");
            expect(nodeWorkflow(node)?.parameters?.globalSettings?.revision).toBe(2);
        }
        expect(JSON.stringify(fixture.nodes)).toBe(before);
    });

    test("asset images inherit appearance without changing the landscape reference-sheet layout", () => {
        const fixture = workflowImageFixture();
        const globalSettings = { ...defaultShortDramaSettings(), visualForm: DramaVisualForm.Animation2D, visualStyle: DramaVisualStyle.Ink };
        const imageSubjectIds = workflowImageSubjects(fixture.request, fixture.nodes).map((node) => node.id);
        const result = createWorkflowImages({ ...fixture.request, globalSettings, imageSubjectIds }, fixture.nodes, fixture.connections, { x: 0, y: 0 });
        expect(result.created.length).toBeGreaterThan(0);
        for (const node of result.created) {
            expect(node.metadata?.size).toBe("1536x1024");
            expect(node.metadata?.prompt).toContain("视觉画风：水墨国风");
            expect(node.metadata?.prompt).not.toContain("成片画幅：9:16");
            expect(nodeWorkflow(node)?.parameters?.globalSettings).toEqual(globalSettings);
        }
        expect(globalSettingsPrompt(globalSettings, "storyboard", "image")).toContain("成片画幅：9:16");
    });

    test("settings survive serialization and participate in document hashes", async () => {
        const created = newDramaCanvasContent(defaultShortDramaSettings());
        const project: CanvasProject = { ...created, id: "settings-test", title: "测试", createdAt: "2026-10-15", updatedAt: "2026-10-15", chatSessions: [], activeChatId: null, backgroundMode: "dots", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 }, directorScenes: [] };
        const document = parseCanvasStorageDocument(null, [project]);
        const restored = parseCanvasStorageDocument(serializeCanvasStorageDocument(document)).state.projects[0];
        expect(restored.globalSettings).toEqual(created.globalSettings);
        expect(await canvasContentHash(restored)).toBe(await canvasContentHash(project));
        expect(await canvasContentHash({ ...restored, globalSettings: { ...restored.globalSettings!, episodeCount: 24 } })).not.toBe(await canvasContentHash(project));
    });
});
