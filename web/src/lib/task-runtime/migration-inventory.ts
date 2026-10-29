// 业务入口迁移清单（对应实施方案 §15）。stage 只在入口真正切换后更新。
// legacy：仍走原路径；shadow：新构造器只做对象比较，不影响请求；builder：已用新构造器提交；runner：由新运行时执行。
export type MigrationStage = "legacy" | "shadow" | "builder" | "runner";

export type MigrationEntry = {
    id: string;
    entry: string;
    firstWiring: readonly string[];
    retainedCapabilities: string;
    exitCondition: string;
    stage: MigrationStage;
};

export const TASK_RUNTIME_MIGRATION_INVENTORY: readonly MigrationEntry[] = [
    {
        id: "canvas-image-single",
        entry: "普通图片单任务",
        firstWiring: ["canvas-image-generation-executor"],
        retainedCapabilities: "节点创建、版本布局、原错误提示",
        exitCondition: "不再在页面拼后端 payload；仅保留业务适配。",
        stage: "shadow",
    },
    {
        id: "canvas-image-batch",
        entry: "图像批量/分镜图",
        firstWiring: ["use-canvas-generation-batches"],
        retainedCapabilities: "前置帧依赖、行/节点关联",
        exitCondition: "有 serverPlanId 的批次不再由浏览器推进。",
        stage: "legacy",
    },
    {
        id: "canvas-media",
        entry: "视频/音频",
        firstWiring: ["canvas-media-generation-executors"],
        retainedCapabilities: "版本节点、首尾帧、音色绑定",
        exitCondition: "使用类型构造器、公共提交和结果消费者。",
        stage: "legacy",
    },
    {
        id: "canvas-text",
        entry: "文本/分镜/短剧",
        firstWiring: ["canvas-text-generation-executor", "use-short-drama-workflow-generation", "use-canvas-storyboard"],
        retainedCapabilities: "SSE、结构化输出、阶段规则、分批归并",
        exitCondition: "任务身份与回放连续；专用规则移入业务 builder/adapter。",
        stage: "legacy",
    },
    {
        id: "create-and-chapter",
        entry: "创作页/项目章节",
        firstWiring: ["pages/create", "project-chapter-ai", "workflow-production-workbench"],
        retainedCapabilities: "会话/章节授权及结果归属",
        exitCondition: "不再直拼 CreateTaskInput。",
        stage: "legacy",
    },
    {
        id: "retry",
        entry: "重试入口",
        firstWiring: ["use-canvas-generation-retry", "workflow-generation-retry", "task-retry"],
        retainedCapabilities: "费用待核对确认、重试原身份",
        exitCondition: "共用 command 门面，未迁移类型显式走 legacy adapter。",
        stage: "legacy",
    },
    {
        id: "agent",
        entry: "Agent/智能创作",
        firstWiring: ["cloud_agent", "creation runtime", "creative-agent-controller"],
        retainedCapabilities: "根任务控制面、审批预算、CreationSubmission",
        exitCondition: "原审批/报价/幂等身份保持，真实模型子任务进入公共运行时。",
        stage: "legacy",
    },
    {
        id: "timeline",
        entry: "时间线",
        firstWiring: ["task_timeline", "timeline-tasks"],
        retainedCapabilities: "本地渲染/转写、非模型收费语义",
        exitCondition: "独立 executor 接入 registry，不走模型假分支。",
        stage: "legacy",
    },
    {
        id: "task-center",
        entry: "任务中心创建/详情",
        firstWiring: ["pages/tasks"],
        retainedCapabilities: "历史任务可见性",
        exitCondition: "创建走公共构造与受理；观察不再触发隐式业务写入。",
        stage: "legacy",
    },
];