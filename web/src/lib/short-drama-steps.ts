import type { ShortDramaStageId } from "./short-drama-stages";
import { productionBibleInstruction, type ProductionBibleSection } from "./production-bible";

export enum ShortDramaStep {
    Reconcile = "assets.reconcile",
    Bible = "assets.bible", Special = "assets.special",
    Topic = "story.topic", Plan = "story.plan", Episodes = "story.episodes", Body = "story.body",
    Style = "assets.style", Settings = "assets.settings", Extract = "assets.extract", Catalog = "assets.catalog", Characters = "assets.characters", CharacterReferences = "assets.character_references", Environments = "assets.environments", EnvironmentReferences = "assets.environment_references", Props = "assets.props", PropReferences = "assets.prop_references", SpecialReferences = "assets.special_references", Voices = "assets.voices", AssetApproval = "assets.approve",
    Scenes = "direction.scenes", Shots = "direction.shots", Production = "direction.production", Boards = "direction.boards", StartFrame = "direction.start_frame", EndFrame = "direction.end_frame", Keyframes = "direction.keyframes", Previsualization = "direction.previsualization",
    Dialogue = "voice.dialogue", Casting = "voice.casting", Recording = "voice.recording", Timing = "voice.timing",
    Sample = "video.sample", Video = "video.generate", Performance = "video.performance", VideoApproval = "video.approve",
    Rough = "edit.rough", Picture = "edit.picture", Sound = "edit.sound", Subtitles = "edit.subtitles",
    AutomaticReview = "review.automatic", Screening = "review.screening", Revision = "review.revision",
    Render = "delivery.render", Package = "delivery.package", Verify = "delivery.verify", Promotion = "delivery.promotion",
}
export type ShortDramaStepId = `${ShortDramaStep}`;
export type ShortDramaStepDefinition = {
    id: ShortDramaStepId; stage: ShortDramaStageId; label: string;
    // First dependency owns the default next-step shortcut; all remain required inputs.
    requires: readonly ShortDramaStepId[];
    requirement: string;
    // Text can document production work, but cannot attest that media was rendered or approved.
    production?: boolean;
    scope?: "project";
    output?: "asset-group";
    mediaOutput?: "image" | "video";
    mediaActionLabel?: string;
    optional?: boolean;
    optionalRequires?: readonly ShortDramaStepId[];
};
const S = ShortDramaStep;
export const shortDramaSteps: readonly ShortDramaStepDefinition[] = [
    { id: S.Topic, stage: "story", label: "选题抽取", requires: [], requirement: "抽取选题。" },
    { id: S.Plan, stage: "story", label: "项目制作方案", requires: [S.Topic], scope: "project", output: "asset-group", requirement: "统一前置故事总纲、世界规则、视觉美术、导演视听、生成一致性规范，以及带系统编码的全部人物、场景、道具、特殊与声音资产设计。" },
    { id: S.Episodes, stage: "story", label: "分集集纲", requires: [S.Plan], scope: "project", requirement: "全部集纲汇总为一份文稿，按集数顺序分节，不拆成逐集节点。" },
    { id: S.Body, stage: "story", label: "分集正文", requires: [S.Episodes], requirement: "生成指定集的完整剧本。" },
    { id: S.Bible, stage: "assets", label: "统一制作规范", requires: [S.Body], scope: "project", output: "asset-group", requirement: `基于所提供全部正文，分别生成8份可独立编辑的制作规范：${productionBibleInstruction}。每项区分正文事实（附集数场次与依据）、推断和可执行的设计建议；未明确的制作细节自行形成统一建议，不要求用户先确认，不虚称已获审核。不重复分集全文，不以逐人物/逐场景资产代替制作规范。` },
    { id: S.Reconcile, stage: "assets", label: "正文资产校核与补充", requires: [S.Body, S.Bible], scope: "project", output: "asset-group", requirement: "按集一次性核对正文与前置制作方案，统一校核人物、场景、道具和声音。能力、变身、环境效果和界面归所属资产状态，不另设特殊资产分类。复用原资产编号、设定与规范，补充实际出场、状态变化、新增项和冲突。每个资产独立保存，不重建全局规范，不虚构未提供集数。" },
{ id: S.Special, stage: "assets", label: "特殊资产", requires: [S.Body, S.Bible], optional: true, scope: "project", output: "asset-group", requirement: "仅提取正文中需反复保持一致、且人物场景道具不能承载的特效、能力视觉、界面、标志符号等特殊资产。附出场集数场次、原文证据、触发规则、固定外观、状态变化、标志性声音、提示词和冲突。没有则输出空清单，不虚构补齐。遵循所选制作规范。" },
    { id: S.Extract, stage: "assets", label: "正文固定资产提取", requires: [S.Body], requirement: "从本集正文提取可复用的角色及别名、场景空间、道具、服装妆发、角色声线与口音、环境声及音乐音效母题、世界观与全局视觉风格线索。每项标注类别、出现集数、场次、原文依据、稳定特征与变化状态。区分原文事实和待设计建议；没有依据则标为待确认，不凭空补设定。本步只做候选提取，不各自制定一套全剧规范。" },
    { id: S.Catalog, stage: "assets", label: "跨集资产总表", requires: [S.Extract], scope: "project", requirement: "归并已提供的逐集固定资产提取表，按人物、场景、道具服化、声音、全局风格与其他可复用资产分类。建立稳定资产编号、别名表、出现集数与场次索引、正文依据、关系和状态版本。合并同一实体的别名，列出跨集冲突与待确认项。标明已覆盖集数和缺失集数，禁止宣称已覆盖未提供的正文；不重复逐集全文。" },
    { id: S.Characters, stage: "assets", label: "人物资产", requires: [S.Body, S.Bible], scope: "project", output: "asset-group", requirement: "依据正文和所选制作规范，跨集合并人物及别名，每个人物一个条目。包含身份关系、外形体态、服装妆发基准、年龄/服装/伤情等状态变体、固定声线（音色、语速、口音、表演边界）、出现集数场次和证据、完整人物提示词及负面约束、需要的参考图与声线试听。服装变化不另建人物。区分事实、设计建议和冲突；文稿不能证明图片或配音已完成。" },
    { id: S.CharacterReferences, stage: "assets", label: "人物参考图生成", requires: [S.Characters], scope: "project", mediaOutput: "image", mediaActionLabel: "根据人物资产生成参考图", requirement: "生成统一横向人物设定板：左侧资料栏，右上正面、左侧、右侧、背面四个全身视图，右下服装物件拆解与局部细节。同一基准年龄、服装和妆发，统一身高比例与基线；画风以本项目制作规范为准，不混合其他版本。" },
    { id: S.Environments, stage: "assets", label: "场景资产", requires: [S.Body, S.Bible], scope: "project", output: "asset-group", requirement: "依据正文和所选制作规范归并复用空间，每个独立空间一个条目。包含别名、布局、地标、出入口、轴线、相邻空间、时代材质、日夜天气光照变体、环境声层次、出场集数场次及证据、完整提示词和负面约束、所需空间参考。不得随集数重复建立同名场景。区分事实、待设计和冲突。" },
    { id: S.EnvironmentReferences, stage: "assets", label: "场景参考图生成", requires: [S.Environments], scope: "project", mediaOutput: "image", mediaActionLabel: "根据场景资产生成参考图", requirement: "生成统一横向场景设定板：左侧资料栏，右上主视角、正立面、侧剖面、俯视布局，右下动线、陈设与材质细节。一个独立空间和同一基准时间天气，各视图的门窗、地标和家具布局一致；采用本项目制作规范。" },
    { id: S.Props, stage: "assets", label: "道具资产", requires: [S.Body, S.Bible], scope: "project", output: "asset-group", requirement: "依据正文和所选制作规范提取关键、可复用道具，每件一个条目。包含外观材质尺寸、剧情功能、所属人物/场景、交接/损坏/修复的状态链、标志性声音、出场集数场次及证据、生成提示词和负面约束、所需参考。人物日常服装妆发归人物资产；只有独立承担剧情功能的服饰才作道具。普通背景杂物无需逐项建档。不虚构规格或关键物件，区分事实、设计建议和冲突。" },
    { id: S.PropReferences, stage: "assets", label: "道具参考图生成", requires: [S.Props], scope: "project", mediaOutput: "image", mediaActionLabel: "根据道具资产生成参考图", requirement: "生成统一横向道具设定板：左侧资料栏，右上正面、侧面、背面、三分之四视角，右下结构附件及材质细节。各视图保持同一道具的尺度、结构和基准状态，不虚构机关或功能；采用本项目制作规范。" },
    { id: S.SpecialReferences, stage: "assets", label: "特殊资产参考图生成", requires: [S.Special], scope: "project", optional: true, mediaOutput: "image", mediaActionLabel: "根据特殊资产生成参考图", requirement: "生成统一横向特殊资产设定板：左侧资料栏，右上按实体、界面符号或特效类型安排四个视图/状态，右下构成和细节。只使用已定义的形态与能力边界，沿用同一版式和本项目制作规范，不虚构未提取的新资产。" },
    { id: S.Voices, stage: "assets", label: "声音提示词分组", requires: [S.Body], scope: "project", output: "asset-group", requirement: "从正文提取、跨集归并角色声线、环境声、标志性音效及音乐母题，每个声音资产一个条目。注明类别、关联角色或场景、年龄感、语速口音、音色、情绪表演边界或环境声层次、使用范围、出现集数场次、原文依据、可执行的声音提示词及禁用变化。缺少依据时标为待选设计建议，不逐句配音，不假称音频已经生成。" },
    { id: S.Style, stage: "assets", label: "全局风格", requires: [S.Body], scope: "project", requirement: "基于已提供的正文总结全剧统一的视觉与声音风格：类型情绪、画风、色彩、光影、摄影、材质、节奏及声音美学、正负提示词基准和跨集不变规则。标注覆盖集数和具体正文依据，区分原文明确事实、推断、设计建议及冲突待确认项。不把未指定的画风当成既定事实，不代写世界观设定。" },
    { id: S.Settings, stage: "assets", label: "全局设定", requires: [S.Body], scope: "project", requirement: "基于已提供的正文总结全剧设定：时代地域、世界观及能力规则和限制、时间线、人物身份关系、组织称谓、空间关系、关键道具规则、不可变事实与连续性约束。每项附出现集数场次和正文依据，归并别名、列出矛盾和待确认项；不虚构未提供的剧情，不用视觉画风代替世界规则。" },
    { id: S.AssetApproval, stage: "assets", label: "资产一致性检查", requires: [S.Characters, S.Environments, S.Props, S.Voices], scope: "project", requirement: "对照资产总表与全局规范检查人物、场景、道具服化、声音的编号、别名、版本、覆盖范围和跨集一致性，输出差异、缺件及待人工确认项，不把检查文稿视为实际资产审核通过。", production: true },
    { id: S.Scenes, stage: "storyboard", label: "场次目标、走位与空间关系", requires: [S.Body, S.Characters, S.Environments, S.Bible], optionalRequires: [S.Special], requirement: "逐场次设计目标、冲突、调度、轴线、出入场及空间连续性。遵循所选制作规范和关联资产的状态版本。" },
    { id: S.Shots, stage: "storyboard", label: "场次与镜头拆解", requires: [S.Body], optionalRequires: [S.Scenes], requirement: "一次完成场次调度与逐镜头拆解。先按场次明确目标、冲突、人物走位、轴线、出入口和空间关系，再按镜头编号给出景别、机位、构图、运动、时长、动作、表情、对白、音效和剪辑点。一个镜头只承担一个主要动作或信息，复杂动作拆为可控镜头；逐项核对服装、道具状态、光线、视线和前后镜头连续性。已有场次设计时沿用并补全，不重复另写一套。遵循所选制作规范与资产版本，缺失信息标明待设计。" },
    { id: S.Production, stage: "storyboard", label: "资产绑定与镜头提示词", requires: [S.Shots, S.Bible], optionalRequires: [S.Reconcile, S.Characters, S.Environments, S.Props, S.Special], requirement: '逐镜头绑定角色场景道具及特殊资产的版本、出场状态和已选定参考，给出生成路线、正负提示词、首尾帧和连续性约束。统一核对镜头编号、资产状态、服装、视线、轴线、动作与声音衔接。仅描述或候选参考须标为待确认，不能假称媒体已完成。直接输出一个 JSON 对象，不重复另写文稿：{"shots":[{"id":"原镜头编号","title":"画面名称","assetKeys":["所用资产编号"],"assetStates":"版本和出场状态","route":"生成路线","prompt":"完整生图提示词","negativePrompt":"负面约束","startFramePrompt":"动作起点提示词","endFramePrompt":"动作终点提示词","keyframes":[{"id":"关键帧编号","time":"镜头内时间位置","prompt":"此时刻完整提示词"}],"continuity":"前后镜头衔接与声画约束"}],"checks":"差异、缺件与待验收项"}。每镜头一个条目，沿用原镜头编号；关键帧仅在必要时列出，没有则为空数组。每份提示词应可独立使用并遵循统一规范。' },
    { id: S.Boards, stage: "storyboard", label: "分镜图生成", requires: [S.Production], mediaOutput: "image", mediaActionLabel: "根据镜头提示词生成分镜图", requirement: "生成所选镜头的一幅分镜画面，遵循镜头构图、人物状态、景别、机位、光线、资产参考和前后镜头连续性。不要将整集剧情拼成多格图。", production: true },
    { id: S.StartFrame, stage: "storyboard", label: "镜头首帧生成", requires: [S.Production], optionalRequires: [S.Boards], optional: true, mediaOutput: "image", mediaActionLabel: "生成镜头首帧", requirement: "生成所选镜头动作起点的首帧画面。固定主体位置、视线、姿态、景别、光线与前一镜头连续性，遵循关联人物和场景参考。" , production: true },
    { id: S.EndFrame, stage: "storyboard", label: "镜头尾帧生成", requires: [S.Production], optionalRequires: [S.Boards, S.StartFrame], optional: true, mediaOutput: "image", mediaActionLabel: "生成镜头尾帧", requirement: "生成所选镜头动作终点的尾帧画面。呈现动作结果，固定主体位置、视线、光线和与下一镜头连续性；已有首帧时保持角色外形与场景布局。", production: true },
    { id: S.Keyframes, stage: "storyboard", label: "镜头关键帧生成", requires: [S.Production], optionalRequires: [S.StartFrame, S.EndFrame], optional: true, mediaOutput: "image", mediaActionLabel: "生成镜头关键帧", requirement: "生成所选镜头中指定关键时刻的画面，明确时间位置、动作阶段和连续性约束。仅针对动作、表演或空间发生重要变化的时刻制作，避免无意义中间帧。", production: true },
    { id: S.Previsualization, stage: "storyboard", label: "顺序、节奏与动作预演", requires: [S.Production], optionalRequires: [S.Boards, S.StartFrame, S.EndFrame, S.Keyframes], requirement: "基于镜头提示词、资产状态和连续性要求，整理镜头顺序、节奏、动作衔接与预演检查表。已提供画面时保留其资源引用供实际预演核对；仅有提示词或资源标识不等于已经观看画面，实际画面、运动、声音与时长必须标为待预演或待验收。", production: true },
    { id: S.Dialogue, stage: "voice", label: "台词、旁白、说话人与情绪", requires: [S.Shots, S.Body], requirement: "提取逐句台词旁白，标注角色、镜头、情绪、停顿与重音。" },
    { id: S.Casting, stage: "voice", label: "角色声线与试听", requires: [S.Dialogue, S.Characters, S.Bible], requirement: "复用人物资产的固定声线、语速、口音和已有试听参考，结合台词输出试听文本，列出待人工选定项。", production: true },
    { id: S.Recording, stage: "voice", label: "配音、音乐与音效素材", requires: [S.Casting, S.Environments, S.Props, S.Bible], optionalRequires: [S.Special], requirement: "依据人物声线、场景环境声、道具及特殊资产标志音和统一声音美学制作逐句配音、音乐与音效需求及命名清单，不假称音频已生成。", production: true },
    { id: S.Timing, stage: "voice", label: "实际时长、音画对齐与混音", requires: [S.Recording, S.Previsualization], requirement: "输出音画对齐和混音方案，实测缺失时明确待测，不编造实际时长。", production: true },
    { id: S.Sample, stage: "video", label: "代表性镜头样片验证", requires: [S.Previsualization, S.Production], requirement: "选择代表性镜头，输出样片提示词、参数建议和验证标准。", production: true },
    { id: S.Video, stage: "video", label: "镜头视频生成、导入与重试", requires: [S.Sample], optionalRequires: [S.StartFrame, S.EndFrame, S.Keyframes], requirement: "输出逐镜头视频生成、导入和重试清单，保持资产和镜头编号。优先引用已经确认的首帧、尾帧和关键帧；模型不支持某种帧输入时明确降级为可用参考图或纯文本，并保留镜头连续性要求。", production: true },
    { id: S.Performance, stage: "video", label: "口型与表演处理", requires: [S.Video, S.Timing], requirement: "逐镜头给出口型、表演、动作同步处理要求及检查项。", production: true },
    { id: S.VideoApproval, stage: "video", label: "候选对比、选用与问题回退", requires: [S.Performance], requirement: "列出视频候选评估、版本选用及问题回退清单；未观看的媒体不得判为通过。", production: true },
    { id: S.Rough, stage: "edit", label: "镜头排序、入出点与粗剪", requires: [S.VideoApproval], requirement: "输出剪辑顺序、入出点、时长与转场需求，未实测时间标为待测。", production: true },
    { id: S.Picture, stage: "edit", label: "画面调整、转场与包装", requires: [S.Rough], requirement: "输出画面匹配、调色、转场、片头片尾及包装执行清单。", production: true },
    { id: S.Sound, stage: "edit", label: "对白、音乐、音效与环境声", requires: [S.Rough, S.Timing], requirement: "输出声音分轨、对白优先级、音乐音效入出点与混音检查表。", production: true },
    { id: S.Subtitles, stage: "edit", label: "字幕、转写与样式校对", requires: [S.Picture, S.Sound, S.Dialogue], requirement: "整理字幕正文、说话人、断句、样式及同步校对清单。", production: true },
    { id: S.AutomaticReview, stage: "review", label: "资源、版本、时长与字幕边界检查", requires: [S.Subtitles], requirement: "根据材料列出资源、版本、时长和字幕边界检查项，缺少机器检测证据时标为待检测。", production: true },
    { id: S.Screening, stage: "review", label: "成片画面、声音与字幕审片", requires: [S.AutomaticReview], requirement: "生成审片记录表和逐项核对标准，不编造观看结果或审核结论。", production: true },
    { id: S.Revision, stage: "review", label: "问题修订、重新渲染与复查", requires: [S.Screening], requirement: "对已有问题给出责任镜头、修订措施、影响范围、重渲染及复查清单。", production: true },
    { id: S.Render, stage: "delivery", label: "成片 MP4 渲染与导出", requires: [S.Revision], requirement: "输出渲染导出规格、命名、版本与检查清单，不假称已产生 MP4。", production: true },
    { id: S.Package, stage: "delivery", label: "成片、字幕、分镜与资产资料包", requires: [S.Render], requirement: "整理交付目录、清单、版本和缺件，不伪造文件路径或下载地址。", production: true },
    { id: S.Verify, stage: "delivery", label: "交付文件与版本核验", requires: [S.Package], requirement: "生成交付核验表，列出版本、规格、完整性和待实测项目。", production: true },
    { id: S.Promotion, stage: "delivery", label: "封面、预告、切片与发布文案", requires: [S.Verify, S.Plan], requirement: "生成封面方案、预告与切片脚本、发布文案，不代替实际发布。" },
];
export function shortDramaStep(id: string) { return shortDramaSteps.find((step) => step.id === id); }
const legacyAssetSteps: readonly ShortDramaStepId[] = [S.Bible, S.Characters, S.Environments, S.Props, S.Special, S.SpecialReferences, S.Extract, S.Catalog, S.AssetApproval, S.Style, S.Settings, S.Voices, S.Scenes];
export const activeShortDramaSteps = shortDramaSteps.filter((step) => !legacyAssetSteps.includes(step.id));
// Reference dependencies are not workflow shortcuts. Keep only the primary
// input path, plus explicit continuations for optional frames and parallel edits.
const contextNextSteps: Partial<Record<ShortDramaStepId, readonly ShortDramaStepId[]>> = {
    [S.Scenes]: [S.Shots],
    [S.Boards]: [S.StartFrame, S.Previsualization],
    [S.StartFrame]: [S.EndFrame, S.Keyframes, S.Previsualization],
    [S.EndFrame]: [S.Keyframes, S.Previsualization],
    [S.Keyframes]: [S.Previsualization],
    [S.Sound]: [S.Subtitles],
};
export function nextShortDramaSteps(id: ShortDramaStepId) {
    const explicit = contextNextSteps[id];
    return activeShortDramaSteps.filter((step) => step.id !== id && (explicit ? explicit.includes(step.id) : step.requires[0] === id));
}

export type WorkflowAssetProfile = {
    aliases: string[];
    occurrences: { episode: number; scene: string; state: string; owner: string; location: string; evidence: string }[];
    variants: { code?: string; name: string; description: string }[];
    sounds: string[];
    conflicts: string[];
    indexContent: string;
    references: { nodeId: string; signature: string; variant: string; selected: boolean }[];
};

export type ShortDramaWorkflowData = {
    assetImageSourceIds?: string[];
    assetRevision?: { sourceNodeId: string; contextNodeIds: string[] };
    assetRevisionGroup?: { sourceNodeId: string; kind: `${import("./production-plan").PlannedAssetKind}` };
	planGroups?: Partial<Record<import("./production-plan").PlannedAssetKind, string>>;
	planGroup?: { rootFrameId: string; kind: import("./production-plan").PlannedAssetKind };
    planVersion?: 2 | 3;
    planAbsent?: Partial<Record<import("./production-plan").PlannedAssetKind, string>>;
    planSection?: import("./production-plan").ProductionPlanSection;
    assetIdentity?: import("./production-plan").ProductionAssetIdentity;
    planAsset?: import("./production-plan").PlannedAsset;
    productionAgent?: { runId?: string; request?: import("@/services/api/agent").CreateAgentRunInput; maxCredits?: number; maxSteps?: number };
    stage: ShortDramaStageId; step: ShortDramaStepId; pipelineId: string;
    sourceNodeIds: string[]; sourceSignatures: Record<string, string>;
    role: "document" | "collection";
    // Collections reference immutable document versions; parentId is only visual containment.
    collectionSourceIds?: string[];
    aggregate?: boolean;
    // Persist the dependency contract so existing documents and running tasks retain their provenance.
    sourceSteps?: ShortDramaStepId[];
    assetGroup?: { manifestId: string; kind?: "bible"; sections?: ProductionBibleSection[] };
    bibleConfirmation?: Record<string, string>;
    assetSchemaVersion?: 2;
    assetProfile?: WorkflowAssetProfile;
    referenceSignatures?: Record<string, string>;
    mediaKind?: "image" | "video";
    mediaSubjectId?: string;
    mediaShotId?: string;
    mediaGroup?: { sourceNodeId: string; layout?: "grid" };
    assetSheet?: import("./asset-reference-sheet").AssetSheetContract;
    assetOutput?: boolean;
    assetKey?: string;
    bibleSection?: ProductionBibleSection;
    materializedTaskId?: string;
    version?: number;
    episodeNumber?: number;
    parameters?: { episodeCount: number; minutesPerEpisode: string; instruction: string; globalSettings?: import("./short-drama-settings").ShortDramaGlobalSettings };
    operationId?: string;
    textBatch?: import("@/lib/canvas/workflow-text-batch").WorkflowTextBatch;
    bodyContextVersion?: 1;
    submission?: "planned" | "submitting" | "submitted" | "unknown" | "rejected";
};
