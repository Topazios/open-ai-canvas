import { expect, test } from "bun:test";
import { createCanvasNode } from "@/lib/canvas/canvas-project-domain";
import { groupWorkflowImages } from "@/lib/canvas/canvas-workflow-image-group";
import { CanvasNodeType } from "@/types/canvas";

test("standalone storyboard frame workflow cannot create a canvas image container", () => {
    const source = createCanvasNode(CanvasNodeType.Script, { x: 0, y: 0 }, {
        shortDrama: { stage: "storyboard", step: "direction.shots", role: "document", pipelineId: "p", sourceNodeIds: [], sourceSignatures: {} },
    });
    const image = createCanvasNode(CanvasNodeType.Image, { x: 0, y: 0 }, {
        shortDrama: { stage: "storyboard", step: "direction.start_frame", role: "document", mediaKind: "image", mediaSubjectId: source.id, pipelineId: "p", sourceNodeIds: [source.id], sourceSignatures: {} },
    });
    expect(() => groupWorkflowImages([source], [], [image])).toThrow("不能创建额外的镜头帧容器");
});
