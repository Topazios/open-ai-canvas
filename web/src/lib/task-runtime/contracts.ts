// 任务运行时公共合同：只描述值对象，不依赖网络、store、React 或具体供应商。
// 各版本字段含义独立，禁止互相替代：
// - schemaVersion：TaskIntent 结构版本；
// - builderVersion：某个构造器的规范化规则版本；
// - specRevision：同一任务不可变快照的修订号（由后端分配）；
// - runtimeVersion：执行链路，0=旧 Worker，2=新 Runner；
// - executorVersion：具体执行器实现版本；
// - stateVersion：任务视图乐观并发版本。

export const TASK_SCHEMA_VERSION = 1 as const;

export const RUNTIME_VERSION = { legacy: 0, runner: 2 } as const;
export type RuntimeVersion = (typeof RUNTIME_VERSION)[keyof typeof RUNTIME_VERSION];

export type TaskKind = "image" | "video" | "audio" | "text";

export type TaskOperation = "generation" | "edit" | "image_to_video" | "first_last_frame" | "text_to_speech" | "chat" | "structured";

export type TaskSourceSurface = "canvas" | "create" | "project_chapter" | "agent" | "timeline" | "task_center" | "workflow";

export type TaskSource = {
    surface: TaskSourceSurface;
    projectId?: string;
    nodeId?: string;
    entry: string;
};

export type ResourceRole = "reference" | "first_frame" | "last_frame" | "mask" | "audio" | "video";

export type ResourceRef = {
    resourceId: string;
    contentIdentity: string;
    mediaType: string;
    role: ResourceRole;
    order: number;
};

export type ModelSelection = {
    logicalModelId: string;
    channelId?: string;
};

export type ImageTaskParams = {
    size?: string;
    quality?: string;
    count: number;
    transparentBackground: boolean;
};

export type VideoTaskParams = {
    size?: string;
    durationSeconds?: number;
    count: number;
};

export type AudioTaskParams = {
    voice?: string;
    format?: string;
};

export type TextTaskParams = {
    responseFormat?: "text" | "json";
    temperature?: number;
};

export type TaskParams = {
    image: ImageTaskParams;
    video: VideoTaskParams;
    audio: AudioTaskParams;
    text: TextTaskParams;
};

export type OutputBinding = {
    targetKind: "canvas_node" | "project_chapter" | "timeline_clip" | "agent_message";
    targetId: string;
    outputIndex?: number;
};

export type TaskSchedule = {
    notBefore?: string;
    deadline?: string;
    priority?: number;
};

export type TaskIntent<K extends TaskKind = TaskKind> = {
    schemaVersion: typeof TASK_SCHEMA_VERSION;
    kind: K;
    operation: TaskOperation;
    source: TaskSource;
    prompt?: string;
    modelSelection?: ModelSelection;
    references: ResourceRef[];
    params: TaskParams[K];
    outputBinding?: OutputBinding;
    schedule?: TaskSchedule;
};

// 公共提交请求：用户、计费豁免、审批、任务 ID 都只能由服务端认定，客户端不得携带。
export type SubmitTaskRequest<K extends TaskKind = TaskKind> = {
    idempotencyKey: string;
    intent: TaskIntent<K>;
};

export const FORBIDDEN_CLIENT_FIELDS = ["userId", "nonBillable", "approval", "taskId"] as const;

export type TaskReceipt = {
    taskId: string;
    commandId: string;
    specRevision: number;
    acceptedAt: string;
    replayed: boolean;
};

export type TaskBuilder<K extends TaskKind, I> = {
    readonly kind: K;
    readonly version: number;
    build(input: I): TaskIntent<K>;
};

// 服务端受理后生成的不可变快照。
export type TaskSpec<K extends TaskKind = TaskKind> = {
    taskId: string;
    specRevision: number;
    builderVersion: number;
    requestHash: string;
    intent: TaskIntent<K>;
    createdAt: string;
};

// 调度器为一次执行确定的路由与执行器信息。
export type ExecutionSpec = {
    taskId: string;
    specRevision: number;
    runtimeVersion: RuntimeVersion;
    executorVersion: string;
    queue: string;
    routeRunId?: string;
};

export type DispatchDecision =
    | { action: "dispatch"; queue: string; runtimeVersion: RuntimeVersion; reason?: string }
    | { action: "defer"; until: string; reason: string }
    | { action: "reject"; code: string; reason: string };

export type TaskStatus = "accepted" | "queued" | "running" | "succeeded" | "failed" | "canceled";

// legacy_snapshot：只有旧系统快照；admission_only：仅受理事件；full：完整调度/执行事件。
export type EventCoverage = "legacy_snapshot" | "admission_only" | "full";

export type TaskView = {
    taskId: string;
    kind: TaskKind;
    status: TaskStatus;
    stateVersion: number;
    runtimeVersion: RuntimeVersion;
    eventCoverage: EventCoverage;
    source: TaskSource;
    queue?: string;
    progress?: number;
    createdAt: string;
    updatedAt: string;
    errorCode?: string;
};
