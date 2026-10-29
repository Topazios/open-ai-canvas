import { describe, expect, test } from "bun:test";
import { AssetSheetKind, assetSheetKind, assetSheetImageSettings, assetSheetPrompt, assetSheetRatio, assetReferenceStep } from "@/lib/asset-reference-sheet";
import { defaultImageCapabilityConfig } from "@/lib/model-capabilities";
import { createWorkflowImages, workflowImageSubjects } from "@/lib/canvas/canvas-workflow-images";
import { workflowAssetSheetContext } from "@/lib/canvas/canvas-asset-sheet-context";
import { defaultWorkflowSources, nodeWorkflow, workflowGenerationSources } from "@/lib/canvas/canvas-short-drama-workflow";
import { ShortDramaStep } from "@/lib/short-drama-steps";
import { workflowImageFixture } from "./fixtures/workflow-image-project";
import { retryWorkflowGeneration } from "@/services/workflow-generation-retry";
import { defaultConfig } from "@/stores/use-config-store";

const center = { x: 0, y: 0 };
const profile = (values: string[], parameter: "size" | "aspect_ratio" = "size") => ({
    ...defaultImageCapabilityConfig(), size: { values, parameter, default: values[0], allowCustom: false },
});

describe("asset reference sheet contract", () => {
    test("all prop sheets separate exterior display from operation without a weapon keyword list", () => {
        for (const [title, content] of [
            ["旧炮群", "铁灰外壳，木架，整体长2米，轮径0.5米"],
            ["长刀与藤牌", "钝口仿铁件，麻布缠柄，盾牌直径0.6米"],
            ["虚构装置", "铜色外壳与陶瓷表面，整体高0.8米"],
            ["普通相机", "黑色机身，皮革背带，宽0.14米"],
        ]) {
            for (const visualOnly of [false, true]) {
                const prompt = assetSheetPrompt({ kind: AssetSheetKind.Prop, size: "16:9", title, content, style: "水彩平涂", visualOnly });
                expect(prompt).toContain(title);
                expect(prompt).toContain(content);
                expect(prompt).toContain("下方为外观附件与表面细节区域");
                expect(prompt).not.toContain("下方为拆解");
                expect(prompt).toContain("整体外形长宽高、外径和摆放比例校对");
                expect(prompt).toContain("涉及武器或危险物件时");
                expect(prompt).toContain("不生成内部剖视、加工公差、制造改装过程或操作教程");
                expect(prompt).toContain("名称：" + title);
                expect(prompt).toContain("正面、侧面、背面、三分之四视角");
            }
        }
    });

    test("prop display boundaries follow supplied material and do not replace character or scene layouts", () => {
        const prompt = assetSheetPrompt({ kind: AssetSheetKind.Prop, size: "16:9", title: "陈列物", content: "整体长2米", style: "铜色", instruction: "旧版式要求：下方为拆解与细节" });
        expect(prompt.indexOf("【道具展示边界】")).toBeGreaterThan(prompt.indexOf("旧版式要求"));
        for (const kind of [AssetSheetKind.Character, AssetSheetKind.Environment, AssetSheetKind.Special]) {
            const other = assetSheetPrompt({ kind, size: "16:9", title: "测试", content: "灰蓝色外观", style: "水彩" });
            expect(other).not.toContain("【道具展示边界】");
            expect(other).toContain("【本次画面范围】");
        }
    });

    test("hazardous historical props retain truthful identity and show only static exterior design", () => {
        const prompt = assetSheetPrompt({ kind: AssetSheetKind.Prop, size: "16:9", title: "P05猎人枪械", content: "磨损外壳，装饰灯", style: "水彩平涂" });
        expect(prompt).toContain("准确保留历史或虚构题材中的名称、身份与时代");
        expect(prompt).toContain("不把真实物件虚称为无功能模型");
        expect(prompt).toContain("外表面与材质细节");
        expect(prompt).not.toContain("可拆附件");
        expect(prompt).not.toContain("结构拆解");
        expect(prompt).toContain("水彩平涂");
    });

    test("moderated workflow image requires revised input and creates a linked new attempt", async () => {
        const f = workflowImageFixture();
        const subject = workflowImageSubjects(f.request, f.nodes)[0];
        const result = createWorkflowImages({ ...f.request, imageSubjectIds: [subject.id] }, f.nodes, f.connections, center);
        const image = result.created[0];
        const source = { id: "moderated", type: "canvas_image", operation: "image", status: "failed", prompt: image.metadata!.prompt, error: "请求内容未通过模型服务安全审核，请调整后重试", attempts: 1, createdAt: "", updatedAt: "" } as const;
        let prepared: any; let creates = 0;
        const api = { prepare: async (input: any) => { prepared = input; return input; }, create: async () => { creates++; return { id: "revised" } as any; }, query: async () => { throw new Error("unexpected query"); }, retry: async () => { throw new Error("must not retry rejected input"); } };
        await expect(retryWorkflowGeneration(image, source, "fixture", defaultConfig, api, result.nodes)).rejects.toThrow("不能原样重试");
        expect(creates).toBe(0);
        image.metadata!.prompt += "\n只展示无功能影视模型的外观和表面材质。";
        await retryWorkflowGeneration(image, source, "fixture", defaultConfig, api, result.nodes);
        expect(creates).toBe(1);
        expect(prepared.prompt).toBe(image.metadata!.prompt);
        expect(prepared.retryOf).toBe(source.id);
        expect(prepared.metadata.nodeId).toBe(image.id);
        expect(prepared.metadata.pipelineId).toBe(image.metadata!.shortDrama!.pipelineId);
        expect(image.parentId).toBe(result.created[0].parentId);
    });
    test("each category has the shared layout and its own applicable views", () => {
        const cases = [
            [ShortDramaStep.CharacterReferences, AssetSheetKind.Character, "正面全身、左侧全身、右侧全身、背面全身"],
            [ShortDramaStep.EnvironmentReferences, AssetSheetKind.Environment, "主视角（略宽）、正立面、侧剖面、俯视平面"],
            [ShortDramaStep.PropReferences, AssetSheetKind.Prop, "正面、侧面、背面、三分之四视角"],
            [ShortDramaStep.SpecialReferences, AssetSheetKind.Special, "四个视图或已定义状态"],
        ] as const;
        for (const [step, kind, views] of cases) {
            expect(assetSheetKind(step)).toBe(kind);
            const prompt = assetSheetPrompt({ kind, size: "16:9", title: "fixture", content: "单幅主图，三视图，禁止文字", style: "水彩平涂，低饱和青绿" });
            expect(prompt).toContain(views);
            expect(prompt).toContain("档案明确的物理尺寸作为唯一标尺");
            expect(prompt).toContain("水彩平涂，低饱和青绿");
            expect(prompt).toContain("完整设定板版式优先于资产材料中的");
            expect(prompt).toContain("共用身高、体重和三围");
            expect(prompt).toContain("生成一张完整的横向资产设定板");
            expect(prompt).toContain("不要把图像切块、拼贴、重排");
            expect(prompt).not.toContain("系统会合成最终设定板");
        }
        expect(assetSheetKind(ShortDramaStep.StartFrame)).toBeUndefined();
        expect(assetReferenceStep(ShortDramaStep.Characters)).toBe(ShortDramaStep.CharacterReferences);
        expect(assetReferenceStep(ShortDramaStep.Body)).toBeUndefined();
    });

    test("reference-board layouts include side information and scene measurement panels", () => {
        const character = assetSheetPrompt({ kind: AssetSheetKind.Character, size: "16:9", title: "陈朔", content: "身高：178cm；体重：68kg", style: "电影写实" });
        const scene = assetSheetPrompt({ kind: AssetSheetKind.Environment, size: "16:9", title: "出租屋", content: "长：8m；宽：5m；面积：40平方米", style: "电影写实" });
        expect(character).toContain("左侧资料栏约占整幅宽度 18%");
        expect(character).toContain("正面全身、左侧全身、右侧全身、背面全身");
        expect(character).toContain("脚底基线延伸到头顶最高点");
        expect(character).toContain("左侧半身肖像是唯一高分辨率脸部身份基准");
        expect(scene).toContain("左侧资料栏约占整幅宽度 17%");
        expect(scene).toContain("带尺寸线的空间拆解轴测图");
        expect(scene).toContain("动线平面图");
        expect(scene).toContain("同一个世界坐标场景的投影");
        expect(scene).toContain("待测量");
    });

    test("uses declared landscape sizes and keeps quality without transparent or square global defaults", () => {
        const settings = assetSheetImageSettings(profile(["1024x1024", "1536x1024", "1024x1536"]), { size: "1024x1536", quality: "high", transparentBackground: "true" });
        expect(settings).toMatchObject({ size: "1536x1024", quality: "high", transparentBackground: "false", count: "1" });
        expect(assetSheetImageSettings(profile(["1:1", "3:2", "16:9"], "aspect_ratio"), {}).size).toBe("16:9");
        expect(assetSheetImageSettings(profile(["1024x1024", "1536x1024", "2048x1152"]), {}).size).toBe("2048x1152");
        expect(() => assetSheetImageSettings(profile(["1024x1024"]), {})).toThrow("横向");
        expect(() => assetSheetImageSettings(profile(["1536x1024"]), {}, "16:9")).toThrow("已有设定板画幅");
        expect(assetSheetImageSettings(profile(["1:1", "16:9"], "aspect_ratio"), {}, "2048x1152").size).toBe("16:9");
        expect(assetSheetRatio("auto")).toBe(0);
        expect(assetSheetRatio("0x0")).toBe(0);
        const custom = profile(["auto"]);
        custom.size.allowCustom = true;
        expect(assetSheetImageSettings(custom, {}, "16:9").size).toBe("2048x1152");
        custom.size.parameter = "aspect_ratio";
        expect(assetSheetImageSettings(custom, {}, "1536x1024").size).toBe("3:2");
        expect(() => assetSheetImageSettings(custom, {}, "auto")).toThrow("画幅无效");
    });

    test("character, scene and prop image nodes share style/version/ratio and isolate their subject", () => {
        const f = workflowImageFixture();
        let nodes = f.nodes; let connections = f.connections;
        let styleSignatures: Record<string, string> | undefined;
        for (const step of [ShortDramaStep.CharacterReferences, ShortDramaStep.EnvironmentReferences, ShortDramaStep.PropReferences]) {
            const request = { ...f.request, step, sourceNodeIds: defaultWorkflowSources(step, f.request.pipelineId, nodes).filter(Boolean) };
            const subjects = workflowImageSubjects(request, nodes);
            const result = createWorkflowImages({ ...request, imageSubjectIds: subjects.map((node) => node.id) }, nodes, connections, center, profile(["1024x1024", "1536x1024"]));
            for (const [index, node] of result.created.entries()) {
                const sheet = nodeWorkflow(node)!.assetSheet!;
                expect(sheet).toMatchObject({ version: 4, kind: assetSheetKind(step), size: "1536x1024" });
                expect(Object.keys(sheet.styleSignatures)).toHaveLength(3);
                if (styleSignatures) expect(sheet.styleSignatures).toEqual(styleSignatures);
                styleSignatures = sheet.styleSignatures;
                expect(node.metadata!.prompt).toContain(subjects[index].metadata!.content!);
                expect(node.metadata!.prompt).not.toContain(subjects[1 - index].metadata!.content!);
                expect(node.metadata!.prompt).toContain("【本项目统一制作规范】");
                expect(node.metadata!.composerContent).toBe(node.metadata!.prompt);
                expect(JSON.parse(JSON.stringify(node)).metadata.shortDrama.assetSheet).toEqual(sheet);
            }
            nodes = result.nodes; connections = result.connections;
        }
    });

    test("new category and appends inherit the first sheet ratio, and unsupported switches fail", () => {
        const f = workflowImageFixture();
        const subjects = workflowImageSubjects(f.request, f.nodes);
        const first = createWorkflowImages({ ...f.request, imageSubjectIds: [subjects[0].id] }, f.nodes, f.connections, center, profile(["1536x1024"]));
        const request = { ...f.request, imageSubjectIds: [subjects[1].id] };
        const next = createWorkflowImages(request, first.nodes, first.connections, center, profile(["1024x1024", "2048x1152", "1536x1024"]));
        expect(next.created[0].metadata!.size).toBe("1536x1024");
        expect(next.created[0].parentId).toBe(first.created[0].parentId);
        expect(() => createWorkflowImages(request, first.nodes, first.connections, center, profile(["2048x1152"]))).toThrow("已有设定板画幅");
        expect(() => createWorkflowImages({ ...request, imageSettings: { ...f.request.imageSettings, size: "1024x1024" } }, f.nodes, f.connections, center)).toThrow("横向画幅");
    });

    test("style context never borrows from another pipeline or another revision", () => {
        const f = workflowImageFixture();
        const ancestors = workflowGenerationSources(f.request, f.nodes, f.connections);
        const subjects = workflowImageSubjects(f.request, f.nodes);
        const first = createWorkflowImages({ ...f.request, imageSubjectIds: [subjects[0].id] }, f.nodes, f.connections, center);
        const current = workflowAssetSheetContext(ancestors, first.nodes, f.request.pipelineId);
        expect(current.size).toBe("1536x1024");
        const otherPipeline = structuredClone(first.created[0]);
        nodeWorkflow(otherPipeline)!.pipelineId = "other-project";
        expect(workflowAssetSheetContext(ancestors, [...f.nodes, otherPipeline], f.request.pipelineId).size).toBeUndefined();
        const revision = structuredClone(ancestors);
        revision.find((node) => nodeWorkflow(node)?.bibleSection === "style")!.metadata!.content = "水墨黑白，纸面肌理";
        const changed = workflowAssetSheetContext(revision, first.nodes, f.request.pipelineId);
        expect(changed.size).toBeUndefined(); expect(changed.style).toContain("水墨黑白，纸面肌理");
        expect(changed.styleSignatures).not.toEqual(current.styleSignatures);
        expect(() => workflowAssetSheetContext(ancestors.filter((node) => nodeWorkflow(node)?.bibleSection !== "style"), first.nodes, f.request.pipelineId)).toThrow("缺少全局视觉风格");
    });

    test("single-shot storyboard and frames keep their requested square/transparent settings", () => {
        const f = workflowImageFixture();
        const request = { ...f.request, step: ShortDramaStep.Boards, sourceNodeIds: defaultWorkflowSources(ShortDramaStep.Boards, f.request.pipelineId, f.nodes).filter(Boolean), imageSettings: { size: "1024x1024", quality: "auto", transparentBackground: "true" } };
        const subject = workflowImageSubjects(request, f.nodes)[0];
        const result = createWorkflowImages({ ...request, imageSubjectIds: [subject.id], imagePrompt: "Single frame fixture" }, f.nodes, f.connections, center, profile(["1536x1024"]));
        expect(result.created[0].metadata).toMatchObject(request.imageSettings);
        expect(nodeWorkflow(result.created[0])!.assetSheet).toBeUndefined();
        expect(result.created[0].metadata!.prompt).not.toContain("统一设定板模板");
        for (const step of [ShortDramaStep.StartFrame, ShortDramaStep.EndFrame, ShortDramaStep.Keyframes]) {
            const frameRequest = { ...f.request, step, sourceNodeIds: defaultWorkflowSources(step, f.request.pipelineId, f.nodes).filter(Boolean), imageSettings: request.imageSettings };
            const frameSubject = workflowImageSubjects(frameRequest, f.nodes)[0];
            expect(() => createWorkflowImages({ ...frameRequest, imageSubjectIds: [frameSubject.id], imagePrompt: "Single frame fixture" }, f.nodes, f.connections, center, profile(["1536x1024"]))).toThrow("分镜列表中生成");
        }
    });

    test("unsubmitted retry preserves the exact prompt, model, size and opaque background", async () => {
        const f = workflowImageFixture();
        const subject = workflowImageSubjects(f.request, f.nodes)[0];
        const result = createWorkflowImages({ ...f.request, imageSubjectIds: [subject.id] }, f.nodes, f.connections, center);
        let prepared: any;
        const api = { prepare: async (input: any) => { prepared = input; return input; }, create: async () => ({ id: "fixture" } as any), query: async () => { throw new Error("unexpected"); }, retry: async () => { throw new Error("unexpected"); } };
        await retryWorkflowGeneration(result.created[0], undefined, "fixture", { ...defaultConfig, size: "1024x1536", transparentBackground: "true" }, api, result.nodes);
        expect(prepared.prompt).toBe(result.created[0].metadata!.prompt);
        expect(prepared.config).toMatchObject({ size: "1536x1024", transparentBackground: "false", model: f.request.model, count: "1" });
        expect(prepared.mode).toBe("image");
    });
});
