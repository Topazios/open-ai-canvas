import type { CanvasNodeData } from "../../src/types/canvas";
import { assetContentSignature } from "../../src/lib/canvas/canvas-workflow-asset-profile";
import { ProductionPlanSection, productionPlanSections } from "../../src/lib/production-plan";
import { ProductionBibleSection } from "../../src/lib/production-bible";

// Simulate the server's durable plan artifacts, not a text-task JSON response.
export function completeWorkflowPlan(result: { nodes: CanvasNodeData[]; created: CanvasNodeData[] }) {
    const manifest = result.created[0];
    const data = manifest.metadata!.shortDrama!;
    const frame = result.nodes.find((node) => node.id === manifest.parentId)!;
    delete data.planVersion;
    delete frame.metadata!.shortDrama!.planVersion;
    const docs = [
        { key: "story", name: "故事总纲", content: "完整文稿：选定故事与冲突，明确结局与全部篇章。" },
        { key: "C001", name: "主角", content: "完整文稿：主角性格温和、声音低沉，固定灰色外套。", kind: "character" as const, episodes: [1] },
        { key: "E001", name: "照相馆", content: "完整文稿：旧照相馆，靠南入口、北侧窗户，街道环境声。", kind: "environment" as const, episodes: [2] },
    ].map((item, i): CanvasNodeData => ({
        ...manifest, id: `${manifest.id}:${item.key}`, title: item.name,
        position: { x: manifest.position.x + (i + 1) * 424, y: manifest.position.y },
        metadata: { content: item.content, status: "success", shortDrama: {
            stage: "story", step: "story.plan", pipelineId: data.pipelineId, role: "document", assetKey: item.key,
            sourceNodeIds: [...data.sourceNodeIds], sourceSteps: data.sourceSteps, sourceSignatures: { ...data.sourceSignatures }, parameters: data.parameters, version: data.version,
            ...(item.kind ? { planAsset: { key: item.key, kind: item.kind, name: item.name, episodes: item.episodes, indexContent: assetContentSignature(item.content) } } : {}),
        } },
    }));
    manifest.metadata = { ...manifest.metadata, status: "success", content: "完整文稿已分组保存", shortDrama: { ...data, assetOutput: false, materializedTaskId: "fixture-plan-run", submission: "submitted" } };
    frame.metadata!.shortDrama!.sourceNodeIds = [manifest.id, ...docs.map((node) => node.id)];
    result.nodes.push(...docs);
    return { frame, docs, manifest };
}

export function completeUnifiedWorkflowPlan(result: { nodes: CanvasNodeData[]; created: CanvasNodeData[] }) {
    const value = completeWorkflowPlan(result);
    const { frame, docs, manifest } = value;
    const sections = { story: ProductionBibleSection.Settings, visual: ProductionBibleSection.Style, direction: ProductionBibleSection.Cinematography, generation: ProductionBibleSection.Generation };
    for (const node of [frame, manifest, ...docs]) node.metadata!.shortDrama!.planVersion = 2;
    docs[0].metadata!.shortDrama!.planSection = ProductionPlanSection.Story;
    docs[0].metadata!.shortDrama!.bibleSection = ProductionBibleSection.Settings;
    for (const section of productionPlanSections.slice(1)) {
        const node: CanvasNodeData = { ...docs[0], id: `${manifest.id}:${section.key}`, title: section.label, metadata: { content: `${section.label}：固定自然写实风格、克制表演，保持空间与服装连续性。`, status: "success", shortDrama: { ...docs[0].metadata!.shortDrama!, assetKey: section.key, planSection: section.key, bibleSection: sections[section.key] } } };
        docs.push(node); result.nodes.push(node);
    }
    docs.slice(1, 3).forEach((node, index) => {
        const data = node.metadata!.shortDrama!;
        data.assetIdentity = { id: `fixture-asset-${index}`, code: index === 0 ? "CHR-0001" : "SCN-0001", kind: data.planAsset!.kind };
        data.assetProfile = { aliases: [], occurrences: [], variants: [], sounds: [], conflicts: [], references: [], indexContent: assetContentSignature(node.metadata!.content!) };
    });
    frame.metadata!.shortDrama!.planAbsent = { prop: "无独立剧情道具", special: "无特殊资产", sound: "声音设计已包含于人物和场景档案" };
    frame.metadata!.shortDrama!.sourceNodeIds = [manifest.id, ...docs.map((node) => node.id)];
    return value;
}
