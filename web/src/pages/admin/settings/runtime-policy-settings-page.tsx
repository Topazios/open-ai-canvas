import { App, Button, Form, InputNumber, Select, Skeleton } from "antd";
import { AlertTriangle, Bot, Database, Gauge, Infinity as InfinityIcon, Network, RefreshCw, RotateCcw, Save, ShieldCheck, TimerReset } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useBlocker } from "react-router";

import { cn } from "@/lib/utils";
import { readRuntimeLimits } from "@/services/runtime-limits";
import { getAdminRuntimePolicySetting, getAdminSelfUseRuntimePolicy, resetAdminRuntimePolicySetting, updateAdminRuntimePolicySetting, type RuntimePolicySetting } from "@/services/api/auth";
import { useAdminContext } from "../admin-context";
import { AdminPageFrame } from "../components/admin-shell";
import { AdminStatTile, AdminStatusBadge, SettingsSectionCard } from "../components/admin-ui";

type PolicyGroup = "resource" | "storage" | "task" | "request";
type RuntimePolicyDraft = Pick<RuntimePolicySetting, "resource" | "storage" | "task" | "request" | "canvas">;
type PolicyField = { group: PolicyGroup; name: string; label: string; extra: string; unit: string; min?: number; max: number };
type PolicySectionDefinition = {
    id: string;
    icon: ReactNode;
    title: string;
    shortTitle: string;
    description: string;
    fields: PolicyField[];
    status?: ReactNode;
};

const resourceFields: PolicyField[] = [
    { group: "resource", name: "resourceUploadMB", label: "普通资源单文件", extra: "素材上传和远程导入的单文件业务上限。", unit: "MB", max: 999 },
    { group: "resource", name: "generatedFileMB", label: "单个生成资源", extra: "上游生成响应和落库资源的单文件上限。", unit: "MB", max: 999 },
    { group: "resource", name: "dailyUploadMB", label: "每日上传总量", extra: "按 UTC 自然日累计资源与附件上传。", unit: "MB", max: 999_999 },
    { group: "resource", name: "storedFileGB", label: "账号文件总量", extra: "资源文件与 Agent 会话附件合计。", unit: "GB", max: 999 },
    { group: "resource", name: "structuredDataMB", label: "结构化数据总量", extra: "画布、素材和 Agent 会话结构化数据合计。", unit: "MB", max: 999_999 },
    { group: "resource", name: "taskDataGB", label: "任务数据总量", extra: "任务历史、结果和上游请求日志合计。", unit: "GB", max: 999 },
    { group: "resource", name: "assetCount", label: "素材数量", extra: "单账号可保存的素材记录数。", unit: "条", max: 999_999_999 },
    { group: "resource", name: "canvasCount", label: "画布数量", extra: "单账号可保存的画布数量。", unit: "个", max: 999_999_999 },
    { group: "resource", name: "taskCount", label: "任务历史数量", extra: "单账号保留的任务历史记录数。", unit: "条", max: 999_999_999 },
    { group: "resource", name: "apiCallLogCount", label: "请求日志数量", extra: "单账号保留的上游请求日志数。", unit: "条", max: 999_999_999 },
    { group: "resource", name: "recycleBinRetentionDays", label: "回收站自动清理时间", extra: "素材移入回收站后自动彻底删除的天数，0 表示不自动清理。", unit: "天", min: 0, max: 365 },
];

const storageFields: PolicyField[] = [
    { group: "storage", name: "transferTimeoutSeconds", label: "对象存储传输超时", extra: "对象存储上传、下载、删除与连接测试的最长等待时间。", unit: "秒", min: 10, max: 3_600 },
    { group: "storage", name: "accessURLTTLSeconds", label: "访问地址有效期", extra: "浏览器访问对象资源时使用的签名地址有效期。", unit: "秒", min: 60, max: 86_400 },
    { group: "storage", name: "providerAccessURLTTLSeconds", label: "厂商访问地址有效期", extra: "模型或其他外部厂商读取对象资源时使用的地址有效期。", unit: "秒", min: 300, max: 86_400 },
    { group: "storage", name: "nonSeekableBufferMB", label: "非可寻址上传缓冲", extra: "S3 兼容存储接收不可重复读取请求体时的最大内存缓冲。", unit: "MB", max: 999 },
    { group: "storage", name: "errorBodyKB", label: "错误响应保留", extra: "对象存储错误响应中最多保留的诊断内容。", unit: "KB", max: 1_024 },
];
const concurrencyFields: PolicyField[] = [
    { group: "resource", name: "imagePreparationConcurrency", label: "图片准备并发", extra: "浏览器图片加载与解码共享的全局策略，系统默认 4。", unit: "个", max: 999 },
    { group: "resource", name: "resourceDownloadConcurrency", label: "资源下载并发", extra: "浏览器网络资源下载共享的全局策略，系统默认 16。", unit: "个", max: 999 },
    { group: "resource", name: "uploadConcurrency", label: "资源上传并发", extra: "素材、画布导入和资源上传共享的全局策略，系统默认 4。", unit: "个", max: 999 },
    { group: "resource", name: "mediaRecoveryConcurrency", label: "媒体恢复并发", extra: "媒体恢复与资源修复共享的全局策略，系统默认 2。", unit: "个", max: 999 },
    { group: "task", name: "imageConcurrency", label: "生图并发", extra: "图片任务独立执行，不占用文本或 Agent 槽位。", unit: "个", max: 999 },
    { group: "task", name: "textConcurrency", label: "文本并发", extra: "普通文本及分批正文任务的独立并发。", unit: "个", max: 999 },
    { group: "task", name: "agentConcurrency", label: "Agent 并发", extra: "Agent 模型调用及上下文压缩的独立并发；生成媒体按对应媒体类别计数。", unit: "个", max: 999 },
    { group: "task", name: "videoConcurrency", label: "视频并发", extra: "视频生成及时间线导出的独立并发。", unit: "个", max: 999 },
    { group: "task", name: "audioConcurrency", label: "音频并发", extra: "音频生成及字幕转写的独立并发。", unit: "个", max: 999 },
    { group: "task", name: "workerConcurrency", label: "其他任务并发", extra: "未归入上述类型的后台任务并发。", unit: "个", max: 999 },
    { group: "task", name: "channelConcurrency", label: "全局渠道分类并发", extra: "所有渠道统一按任务类型独立计数，取此值与该类型并发的较小值。", unit: "个", max: 999 },
    { group: "task", name: "activeTaskLimit", label: "账号每类活动任务", extra: "单账号跨项目、同一类型排队及运行任务的上限，各类型分别计数。0 表示不限制排队数量。", unit: "个", min: 0, max: 999 },
];

const timeoutFields: PolicyField[] = [
    { group: "task", name: "imageTimeoutMinutes", label: "图片任务超时", extra: "图片任务进入失败状态前的最长执行时间。", unit: "分钟", max: 9_999 },
    { group: "task", name: "providerRequestTimeoutSeconds", label: "单次上游请求超时", extra: "文本、音频、视频按单次请求总时长限制；图片按等待响应及接收数据的连续空闲时长限制，有数据返回则继续接收。所有任务仍受对应类型任务总超时约束。", unit: "秒", min: 10, max: 3_600 },
    { group: "task", name: "textTimeoutMinutes", label: "文本任务超时", extra: "文本任务的最长执行时间。", unit: "分钟", max: 9_999 },
    { group: "task", name: "audioTimeoutMinutes", label: "音频任务超时", extra: "音频任务的最长执行时间。", unit: "分钟", max: 9_999 },
    { group: "task", name: "videoTimeoutMinutes", label: "视频任务超时", extra: "视频任务的最长执行时间。", unit: "分钟", max: 9_999 },
    { group: "task", name: "storyboardTimeoutMinutes", label: "分镜任务超时", extra: "Agent 分镜任务的最长执行时间。", unit: "分钟", max: 9_999 },
    { group: "task", name: "defaultTimeoutMinutes", label: "默认任务超时", extra: "未匹配专用类型时使用的最长执行时间。", unit: "分钟", max: 9_999 },
];

const agentFields: PolicyField[] = [
    {
        group: "task",
        name: "agentStepMaxOutputTokens",
        label: "单步输出上限",
        extra: "画布 Agent 每次模型调用的输出上限，含思考、正文与工具调用参数。0 表示不限制，此时只有单步超时兜底；抬高可以避免长思考模型被截断后返回空内容。",
        unit: "token",
        min: 0,
        max: 131_072,
    },
    {
        group: "task",
        name: "agentStepTimeoutSeconds",
        label: "单步超时",
        extra: "画布 Agent 单步模型调用的最长等待时间，到点会中止这一步并自动关思考重试一次。0 表示沿用“文本任务超时”，不再单独计时。",
        unit: "秒",
        min: 0,
        max: 3_600,
    },
    {
        group: "task",
        name: "agentMaxSessions",
        label: "同时对话上限",
        extra: "同时进行中的画布 Agent 轮次，新安装默认 30。审批等待不占名额，降低上限不会中断已开始的对话。",
        unit: "个",
        max: 64,
    },
];

const connectionLineStyles = [
    { value: "solid", label: "实线" },
    { value: "dashed", label: "虚线" },
];
const connectionArrowStyles = [
    { value: "arrow", label: "小箭头" },
    { value: "dot", label: "圆点" },
    { value: "none", label: "无" },
];
const connectionEffects = [
    { value: "highlight", label: "选中时强调" },
    { value: "none", label: "保持一致" },
];
const defaultCanvasPolicy: RuntimePolicySetting["canvas"] = {
    connectionLineStyle: "solid",
    connectionArrowStyle: "arrow",
    connectionEffect: "highlight",
    taskEventHeartbeatSeconds: 15,
    taskEventMaxConnectionsPerUser: 8,
    taskEventMaxReplayEvents: 200,
    taskEventRetentionHours: 168,
    taskFallbackPollMinSeconds: 3,
    taskFallbackPollMaxSeconds: 60,
};

const rateFields: PolicyField[] = [
    { group: "request", name: "taskCreatePerMinute", label: "任务创建", extra: "每账号每分钟允许创建的任务数。", unit: "次/分钟", max: 999_999 },
    { group: "request", name: "resourceUploadPerMinute", label: "资源上传", extra: "每账号每分钟上传资源的次数。", unit: "次/分钟", max: 999_999 },
    { group: "request", name: "resourceImportPerMinute", label: "资源导入", extra: "每账号每分钟导入远程资源的次数。", unit: "次/分钟", max: 999_999 },
    { group: "request", name: "assetWritePerMinute", label: "素材写入", extra: "每账号每分钟写入素材的次数。", unit: "次/分钟", max: 999_999 },
    { group: "request", name: "canvasWritePerMinute", label: "画布写入", extra: "每账号每分钟写入画布的次数。", unit: "次/分钟", max: 999_999 },
    { group: "request", name: "registerPerHour", label: "账号注册", extra: "每 IP 每小时允许的注册请求次数，包含失败尝试；多人共用网络时建议至少 30 次。", unit: "次/小时", max: 999_999 },
    { group: "request", name: "emailCodePerHour", label: "邮箱验证码", extra: "每 IP 每小时的验证码请求次数，建议至少 60 次；单邮箱另限每小时 10 次，发送后需间隔 60 秒。", unit: "次/小时", max: 999_999 },
    { group: "request", name: "loginIPPerTenMinutes", label: "登录 IP", extra: "每 IP 每 10 分钟允许登录的次数。", unit: "次/10分钟", max: 999_999 },
    { group: "request", name: "loginAccountPerTenMinutes", label: "登录账号组合", extra: "同一 IP 与账号组合每 10 分钟的登录次数。", unit: "次/10分钟", max: 999_999 },
    { group: "request", name: "systemRelayPerMinute", label: "系统渠道中转", extra: "每账号每分钟使用系统渠道的请求数。", unit: "次/分钟", max: 999_999 },
    { group: "request", name: "customRelayPerMinute", label: "自定义渠道中转", extra: "每账号每分钟使用自定义渠道的请求数。", unit: "次/分钟", max: 999_999 },
];

const relayFields: PolicyField[] = [
    { group: "request", name: "customRelayConcurrency", label: "自定义渠道并发", extra: "单账号同时进行的自定义渠道请求数。", unit: "个", max: 999 },
    { group: "request", name: "customRelayRequestMB", label: "自定义渠道请求体", extra: "中转到自定义上游的请求体上限。", unit: "MB", max: 999 },
    { group: "request", name: "customRelayResponseMB", label: "自定义渠道响应体", extra: "自定义上游 JSON 与流式响应的读取上限。", unit: "MB", max: 999 },
    { group: "request", name: "customRelayTimeoutMinutes", label: "自定义渠道超时", extra: "自定义渠道连接与响应的最长等待时间。", unit: "分钟", max: 9_999 },
    { group: "request", name: "systemRelayRequestMB", label: "系统渠道请求体", extra: "中转到系统渠道的请求体上限。", unit: "MB", max: 999 },
    { group: "request", name: "systemRelayResponseMB", label: "系统渠道响应体", extra: "系统渠道上游响应的读取上限。", unit: "MB", max: 999 },
    { group: "request", name: "channelCircuitFailureCount", label: "熔断失败次数", extra: "一分钟内连续失败达到该值后打开熔断。", unit: "次", max: 999 },
    { group: "request", name: "channelCircuitOpenSeconds", label: "熔断持续时间", extra: "渠道熔断打开后拒绝请求的时间。", unit: "秒", max: 86_400 },
];

const policySections: PolicySectionDefinition[] = [
    { id: "policy-resource", icon: <Database className="size-4" aria-hidden="true" />, title: "资源与账号配额", shortTitle: "资源配额", description: "上传、文件容量、结构化数据和历史记录上限。", fields: resourceFields },
    {
        id: "policy-storage",
        icon: <Database className="size-4" aria-hidden="true" />,
        title: "对象存储运行时",
        shortTitle: "对象存储",
        description: "对象存储传输、签名地址和上传缓冲策略。",
        fields: storageFields,
        status: <AdminStatusBadge label="保存后热更新" tone="info" />,
    },
    {
        id: "policy-concurrency",
        icon: <Gauge className="size-4" aria-hidden="true" />,
        title: "任务与并发",
        shortTitle: "任务并发",
        description: "后台任务消费、渠道调度和单账号活动任务上限。",
        fields: concurrencyFields,
        status: <AdminStatusBadge label="保存后热更新" tone="info" />,
    },
    { id: "policy-timeout", icon: <TimerReset className="size-4" aria-hidden="true" />, title: "任务超时", shortTitle: "任务超时", description: "不同生成类型的最长执行时间。", fields: timeoutFields },
    {
        id: "policy-agent",
        icon: <Bot className="size-4" aria-hidden="true" />,
        title: "画布 Agent 单步",
        shortTitle: "Agent 单步",
        description: "画布 Agent 每一步模型调用的输出上限与等待时限；两者一起决定单步最坏耗时。",
        fields: agentFields,
        status: <AdminStatusBadge label="保存后热更新" tone="info" />,
    },
    {
        id: "policy-canvas",
        icon: <Network className="size-4" aria-hidden="true" />,
        title: "画布连接线",
        shortTitle: "画布连线",
        description: "统一控制所有用户画布中的连接线外观。",
        fields: [],
        status: <AdminStatusBadge label="保存后即时生效" tone="info" />,
    },
    { id: "policy-rate", icon: <ShieldCheck className="size-4" aria-hidden="true" />, title: "业务频控", shortTitle: "业务频控", description: "账号与 IP 维度的固定窗口请求限制。", fields: rateFields },
    { id: "policy-relay", icon: <Network className="size-4" aria-hidden="true" />, title: "渠道中转与熔断", shortTitle: "中转与熔断", description: "请求体、响应体、并发、超时和上游故障保护。", fields: relayFields },
];
const allPolicyFields = policySections.flatMap((section) => section.fields);

export default function RuntimePolicySettingsPage() {
    const { message, modal } = App.useApp();
    const { references } = useAdminContext();
    const [savedSetting, setSavedSetting] = useState<RuntimePolicySetting | null>(null);
    const [draft, setDraft] = useState<RuntimePolicyDraft | null>(null);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [saving, setSaving] = useState(false);
    const [resetting, setResetting] = useState(false);
    const [presetLoading, setPresetLoading] = useState(false);
    const [loadError, setLoadError] = useState("");
    const [saveError, setSaveError] = useState("");
    const [form] = Form.useForm<RuntimePolicyDraft>();
    const requestVersionRef = useRef(0);
    const formReadyRef = useRef(false);
    const navigationConfirmOpenRef = useRef(false);
    const navigationTriggerRef = useRef<HTMLElement | null>(null);
    const userNameById = useMemo(() => new Map(references.users.map((user) => [user.id, user.displayName || user.username])), [references.users]);

    const load = useCallback(
        async (initial = false, announce = false) => {
            const requestVersion = ++requestVersionRef.current;
            if (initial) setLoading(true);
            else setRefreshing(true);
            setLoadError("");
            try {
                const result = await getAdminRuntimePolicySetting();
                const value = parseRuntimePolicySetting(result.setting);
                if (requestVersion !== requestVersionRef.current) return;
                const nextDraft = toPolicyDraft(value);
                setSavedSetting(value);
                setDraft(nextDraft);
                if (formReadyRef.current) form.setFieldsValue(nextDraft);
                setSaveError("");
                if (announce) message.success("已重新读取当前资源与策略配置");
            } catch (error) {
                if (requestVersion !== requestVersionRef.current) return;
                const errorMessage = error instanceof Error ? error.message : "读取资源与策略失败";
                setLoadError(errorMessage);
                if (!initial) message.error(errorMessage);
            } finally {
                if (requestVersion === requestVersionRef.current) {
                    setLoading(false);
                    setRefreshing(false);
                }
            }
        },
        [form, message],
    );

    useEffect(() => {
        void load(true);
        return () => {
            requestVersionRef.current += 1;
        };
    }, [load]);

    useEffect(() => {
        if (draft) formReadyRef.current = true;
    }, [draft]);

    const dirtyFields = useMemo(() => {
        if (!savedSetting || !draft) return [];
        return allPolicyFields.filter((field) => readPolicyValue(savedSetting, field) !== readPolicyValue(draft, field));
    }, [draft, savedSetting]);
    const connectionSettingsDirty = !sameCanvasPolicy(savedSetting?.canvas, draft?.canvas);
    const dirty = dirtyFields.length > 0 || connectionSettingsDirty;
    const busy = loading || refreshing || saving || resetting || presetLoading;
    const blocker = useBlocker(dirty && !saving && !resetting);

    useEffect(() => {
        const beforeUnload = (event: BeforeUnloadEvent) => {
            if (!dirty || saving || resetting) return;
            event.preventDefault();
        };
        window.addEventListener("beforeunload", beforeUnload);
        return () => window.removeEventListener("beforeunload", beforeUnload);
    }, [dirty, resetting, saving]);

    useEffect(() => {
        if (blocker.state !== "blocked" || navigationConfirmOpenRef.current) return;
        navigationConfirmOpenRef.current = true;
        navigationTriggerRef.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
        modal.confirm({
            title: "放弃资源与策略调整？",
            content: `当前有 ${dirtyFields.length} 项调整尚未保存，离开后暂存内容会丢失。`,
            okText: "放弃并离开",
            cancelText: "继续编辑",
            okButtonProps: { danger: true },
            onOk: () => {
                navigationConfirmOpenRef.current = false;
                navigationTriggerRef.current = null;
                blocker.proceed();
            },
            onCancel: () => {
                navigationConfirmOpenRef.current = false;
                blocker.reset();
                window.requestAnimationFrame(() => {
                    const fallback = document.querySelector<HTMLButtonElement>(".admin-runtime-policy-command-actions button");
                    const target = navigationTriggerRef.current?.isConnected ? navigationTriggerRef.current : fallback;
                    target?.focus();
                    navigationTriggerRef.current = null;
                });
            },
        });
    }, [blocker, dirtyFields.length, modal]);

    const resetDraft = () => {
        if (!savedSetting || busy) return;
        const nextDraft = toPolicyDraft(savedSetting);
        form.setFieldsValue(nextDraft);
        setDraft(nextDraft);
        setSaveError("");
        message.info("已撤销本页尚未保存的调整");
    };

    const requestRefresh = () => {
        if (!dirty) {
            void load(false, true);
            return;
        }
        modal.confirm({
            title: "放弃调整并重新读取？",
            content: `当前有 ${dirtyFields.length} 项调整尚未保存。重新读取会丢弃暂存内容，并以服务端当前配置为准。`,
            okText: "放弃并刷新",
            cancelText: "继续编辑",
            okButtonProps: { danger: true },
            onOk: () => load(false, true),
        });
    };

    const requestSelfMode = () => {
        modal.confirm({
            rootClassName: "admin-runtime-policy-confirm-modal",
            width: 580,
            icon: <AlertTriangle className="size-5" aria-hidden="true" />,
            title: "填入自用模式上限？",
            content: (
                <div className="admin-runtime-policy-confirm-copy">
                    <p>这会把配额、各类型并发、频控和超时填到允许范围的高值，并把熔断等待缩短到 1 秒。</p>
                    <p>{dirty ? `当前 ${dirtyFields.length + Number(connectionSettingsDirty)} 项暂存调整会被覆盖。` : "只会改动本页草稿，点击保存修改后生效。"}</p>
                </div>
            ),
            okText: "填入草稿",
            cancelText: "取消",
            onOk: async () => {
                setPresetLoading(true);
                try {
                    const result = await getAdminSelfUseRuntimePolicy();
                    const value = parseRuntimePolicySetting(result.setting);
                    const nextDraft = toPolicyDraft(value);
                    form.setFieldsValue(nextDraft);
                    setDraft(nextDraft);
                    setSaveError("");
                    message.info("已填入自用模式上限，点击保存修改后生效");
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : "读取自用模式失败";
                    message.error(errorMessage);
                    throw error;
                } finally {
                    setPresetLoading(false);
                }
            },
        });
    };

    const requestReset = () => {
        if (!savedSetting?.configured || resetting) return;
        modal.confirm({
            rootClassName: "admin-runtime-policy-confirm-modal",
            width: 580,
            icon: <AlertTriangle className="size-5" aria-hidden="true" />,
            title: "恢复全部系统默认策略？",
            content: (
                <div className="admin-runtime-policy-confirm-copy">
                    <p>确认后会删除管理员保存的自定义策略，全部策略立即恢复系统默认值。</p>
                    {dirty ? <p>当前 {dirtyFields.length} 项未保存调整也会一并丢弃。</p> : null}
                </div>
            ),
            okText: "恢复系统默认",
            cancelText: "取消",
            okButtonProps: { danger: true },
            onOk: async () => {
                setResetting(true);
                setSaveError("");
                try {
                    const result = await resetAdminRuntimePolicySetting();
                    const value = parseRuntimePolicySetting(result.setting);
                    if (value.configured) throw new Error("服务端未确认已恢复系统默认策略，请刷新后核对");
                    const nextDraft = toPolicyDraft(value);
                    setSavedSetting(value);
                    setDraft(nextDraft);
                    form.setFieldsValue(nextDraft);
                    message.success("已恢复系统默认策略");
                    void readRuntimeLimits(true).catch((error) => message.error(error.message));
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : "恢复系统默认策略失败";
                    setSaveError(`${errorMessage}。未自动重试，请重新读取当前配置后核对。`);
                    message.error(errorMessage);
                    throw error;
                } finally {
                    setResetting(false);
                }
            },
        });
    };

    const save = async () => {
        if (!draft || !dirty || saving) return;
        const values = await form.validateFields();
        const expected = toPolicyDraft(values);
        const relationshipError = validatePolicyRelationships(expected);
        if (relationshipError) {
            setSaveError(relationshipError);
            form.scrollToField(["resource", "storedFileGB"], { behavior: "smooth", block: "center" });
            throw new Error(relationshipError);
        }
        setSaving(true);
        setSaveError("");
        try {
            const result = await updateAdminRuntimePolicySetting(expected);
            const value = parseRuntimePolicySetting(result.setting);
            if (!samePolicy(value, expected)) throw new Error("服务端返回的策略与本次保存内容不一致，请刷新后核对");
            const nextDraft = toPolicyDraft(value);
            setSavedSetting(value);
            setDraft(nextDraft);
            form.setFieldsValue(nextDraft);
            message.success("资源与策略已保存并即时生效");
            void readRuntimeLimits(true).catch((error) => message.error(error.message));
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "保存资源与策略失败";
            setSaveError(`${errorMessage}。未自动重试，请重新读取当前配置后再决定是否保存。`);
            message.error(errorMessage);
            throw error;
        } finally {
            setSaving(false);
        }
    };

    const submitSave = async () => {
        if (!savedSetting || !draft || !dirty || busy) return;
        try {
            await save();
        } catch {
            // 表单与业务错误已在 save 中就地提示。
        }
    };

    if (loading && !draft) {
        return (
            <AdminPageFrame title="资源与策略" description="账号配额、任务调度与请求安全策略" scroll>
                <div className="admin-settings-stack admin-runtime-policy" aria-label="正在读取资源与策略配置" role="status">
                    <div className="admin-runtime-policy-command-bar">
                        <Skeleton active title={{ width: 190 }} paragraph={false} />
                    </div>
                    <div className="admin-runtime-policy-overview">
                        {Array.from({ length: 4 }).map((_, index) => (
                            <div key={index} className="admin-stat-tile">
                                <Skeleton active title={{ width: 96 }} paragraph={{ rows: 1 }} />
                            </div>
                        ))}
                    </div>
                    <div className="admin-runtime-policy-loading-card">
                        <Skeleton active paragraph={{ rows: 8 }} />
                    </div>
                </div>
            </AdminPageFrame>
        );
    }

    if (!draft || !savedSetting) {
        return (
            <AdminPageFrame title="资源与策略" description="账号配额、任务调度与请求安全策略" scroll>
                <div className="admin-settings-stack admin-runtime-policy">
                    <div className="admin-runtime-policy-load-error" role="alert">
                        <span className="admin-runtime-policy-load-error-icon">
                            <AlertTriangle className="size-5" aria-hidden="true" />
                        </span>
                        <div>
                            <h2>无法读取资源与策略配置</h2>
                            <p>{loadError || "当前没有可显示的配置，请稍后重试。"}</p>
                        </div>
                        <Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void load(true)}>
                            重新读取
                        </Button>
                    </div>
                </div>
            </AdminPageFrame>
        );
    }

    const updateActor = savedSetting.updatedBy ? userNameById.get(savedSetting.updatedBy) || savedSetting.updatedBy : "";
    const updateDetail = savedSetting.configured ? `${formatTime(savedSetting.updatedAt)}${updateActor ? ` · ${updateActor}` : ""}` : "尚未由管理员保存，使用系统默认值";
    const workerConcurrency = readDraftNumber(draft, "task", "imageConcurrency");
    const activeTaskLimit = readDraftNumber(draft, "task", "activeTaskLimit");

    return (
        <AdminPageFrame title="资源与策略" description="账号配额、任务调度与请求安全策略" scroll>
            <Form
                form={form}
                initialValues={draft}
                layout="vertical"
                requiredMark={false}
                disabled={busy}
                onValuesChange={(_, values) => {
                    setDraft(toPolicyDraft(values));
                    setSaveError("");
                }}
            >
                <div className="admin-settings-stack admin-runtime-policy">
                    <div className={cn("admin-runtime-policy-command-bar", dirty && "is-dirty")}>
                        <div className="admin-runtime-policy-command-copy" aria-live="polite">
                            <span className="admin-runtime-policy-command-icon">
                                <ShieldCheck className="size-4" aria-hidden="true" />
                            </span>
                            <div>
                                <div className="flex flex-wrap items-center gap-2">
                                    <strong>{dirty ? `${dirtyFields.length} 项调整待保存` : "资源与策略状态已同步"}</strong>
                                    <AdminStatusBadge label={dirty ? "尚未生效" : savedSetting.configured ? "管理员配置" : "系统默认"} tone={dirty ? "warning" : savedSetting.configured ? "success" : "neutral"} />
                                </div>
                                <p>{dirty ? "当前调整只在本页暂存；点击保存修改后才会影响运行中的业务。" : updateDetail}</p>
                            </div>
                        </div>
                        <div className="admin-runtime-policy-command-actions">
                            {dirty ? (
                                <Button icon={<RotateCcw className="size-4" />} disabled={busy} onClick={resetDraft}>
                                    撤销改动
                                </Button>
                            ) : null}
                            <Button icon={<RefreshCw className="size-4" />} loading={refreshing} disabled={saving || resetting || presetLoading} onClick={requestRefresh}>
                                刷新状态
                            </Button>
                            <Button icon={<InfinityIcon className="size-4" />} loading={presetLoading} disabled={saving || resetting || refreshing} onClick={requestSelfMode}>
                                自用模式草稿
                            </Button>
                            {savedSetting.configured && !dirty ? (
                                <Button danger icon={<RotateCcw className="size-4" />} loading={resetting} disabled={saving || refreshing || presetLoading} onClick={requestReset}>
                                    恢复系统默认
                                </Button>
                            ) : null}
                            {dirty ? (
                                <Button type="primary" icon={<Save className="size-4" />} loading={saving} disabled={busy} onClick={() => void submitSave()}>
                                    保存修改
                                </Button>
                            ) : null}
                        </div>
                    </div>

                    {loadError || saveError ? (
                        <div className="admin-runtime-policy-inline-alert" role="alert">
                            <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
                            <span>{saveError || `${loadError}。页面仍显示上一次成功读取的配置。`}</span>
                        </div>
                    ) : null}

                    <div className="admin-runtime-policy-overview" aria-label="资源与策略配置概览">
                        <AdminStatTile label="配置来源" value={savedSetting.configured ? "管理员配置" : "系统默认"} detail={updateDetail} />
                        <AdminStatTile label="待保存调整" value={dirtyFields.length + Number(connectionSettingsDirty)} detail={dirty ? "仅本页暂存，尚未生效" : "当前草稿与服务端一致"} />
                        <AdminStatTile label="生图并发" value={formatNumber(workerConcurrency)} detail={dirtyFields.some((field) => field.name === "imageConcurrency") ? "暂存状态预览" : "图片独立执行槽位"} />
                        <AdminStatTile label="账号每类活动任务" value={formatNumber(activeTaskLimit)} detail={dirtyFields.some((field) => field.name === "activeTaskLimit") ? "暂存状态预览" : "各类型分别统计排队与运行数"} />
                    </div>

                    {policySections.map((section) => (
                        <div key={section.id} id={section.id} className="admin-settings-anchor admin-runtime-policy-anchor">
                            {section.id === "policy-canvas" ? (
                                <SettingsSectionCard icon={section.icon} title={section.title} description={section.description} status={section.status}>
                                    <div className="admin-runtime-policy-field-grid">
                                        <Form.Item label="线条样式" extra="选择更适合当前流程图的连线形式。" name={["canvas", "connectionLineStyle"]}>
                                            <Select options={connectionLineStyles} aria-label="线条样式" />
                                        </Form.Item>
                                        <Form.Item label="终点标记" extra="控制连接方向的标识方式。" name={["canvas", "connectionArrowStyle"]}>
                                            <Select options={connectionArrowStyles} aria-label="终点标记" />
                                        </Form.Item>
                                        <Form.Item label="选中效果" extra="只使用静态颜色强调，不启用动态动画。" name={["canvas", "connectionEffect"]}>
                                            <Select options={connectionEffects} aria-label="选中效果" />
                                        </Form.Item>
                                        <Form.Item label="事件心跳" extra="SSE 保活间隔；只发送注释心跳，不触发任务刷新。" name={["canvas", "taskEventHeartbeatSeconds"]} rules={[{ required: true, type: "number", min: 5, max: 120, message: "事件心跳必须是 5-120 秒" }]}>
                                            <InputNumber min={5} max={120} precision={0} aria-label="事件心跳" addonAfter="秒" />
                                        </Form.Item>
                                        <Form.Item label="事件连接上限" extra="单个账号在同一画布的 SSE 连接上限，防止重复页面造成资源泄漏。" name={["canvas", "taskEventMaxConnectionsPerUser"]} rules={[{ required: true, type: "number", min: 1, max: 32, message: "事件连接上限必须是 1-32" }]}>
                                            <InputNumber min={1} max={32} precision={0} aria-label="事件连接上限" addonAfter="条" />
                                        </Form.Item>
                                        <Form.Item label="事件回放上限" extra="断线重连时最多补发的事件数量，超出部分由批量任务读取修复。" name={["canvas", "taskEventMaxReplayEvents"]} rules={[{ required: true, type: "number", min: 1, max: 1000, message: "事件回放上限必须是 1-1000" }]}>
                                            <InputNumber min={1} max={1000} precision={0} aria-label="事件回放上限" addonAfter="条" />
                                        </Form.Item>
                                        <Form.Item label="事件保留时间" extra="用于断线回放和后端重启恢复；过期事件由后台清理。" name={["canvas", "taskEventRetentionHours"]} rules={[{ required: true, type: "number", min: 1, max: 720, message: "事件保留时间必须是 1-720 小时" }]}>
                                            <InputNumber min={1} max={720} precision={0} aria-label="事件保留时间" addonAfter="小时" />
                                        </Form.Item>
                                        <Form.Item label="活动任务兜底刷新" extra="SSE 断线或事件丢失时的最短批量刷新间隔。" name={["canvas", "taskFallbackPollMinSeconds"]} rules={[{ required: true, type: "number", min: 1, max: 60, message: "活动任务兜底刷新必须是 1-60 秒" }]}>
                                            <InputNumber min={1} max={60} precision={0} aria-label="活动任务兜底刷新" addonAfter="秒" />
                                        </Form.Item>
                                        <Form.Item label="空闲任务兜底刷新" extra="没有活动任务时的低频刷新间隔，用于发现其他页面创建的任务。" name={["canvas", "taskFallbackPollMaxSeconds"]} rules={[{ required: true, type: "number", min: 1, max: 600, message: "空闲任务兜底刷新必须是 1-600 秒" }]}>
                                            <InputNumber min={1} max={600} precision={0} aria-label="空闲任务兜底刷新" addonAfter="秒" />
                                        </Form.Item>
                                    </div>
                                </SettingsSectionCard>
                            ) : <PolicySection {...section} />}
                        </div>
                    ))}
                </div>
            </Form>
        </AdminPageFrame>
    );
}

function PolicySection({ icon, title, description, fields, status }: PolicySectionDefinition) {
    return (
        <SettingsSectionCard icon={icon} title={title} description={description} status={status}>
            <div className="admin-runtime-policy-field-grid">
                {fields.map((field) => {
                    const inputId = `admin-runtime-policy-${field.group}-${field.name}`;
                    const min = field.min ?? 1;
                    return (
                        <Form.Item key={`${field.group}.${field.name}`} label={field.label} htmlFor={inputId} extra={field.extra}>
                            <div className="admin-runtime-policy-number-control">
                                <Form.Item
                                    noStyle
                                    name={[field.group, field.name]}
                                    rules={[
                                        { required: true, message: `请填写${field.label}` },
                                        { type: "number", min, max: field.max, message: `${field.label}必须是 ${min === 0 ? `0-${field.max}（0 表示不限制）` : `${min}-${field.max}`} 的整数` },
                                    ]}
                                >
                                    <InputNumber id={inputId} min={min} max={field.max} precision={0} aria-label={field.label} />
                                </Form.Item>
                                <span className="admin-runtime-policy-number-unit" aria-hidden="true">
                                    {field.unit}
                                </span>
                            </div>
                        </Form.Item>
                    );
                })}
            </div>
        </SettingsSectionCard>
    );
}

function toPolicyDraft(value: RuntimePolicyDraft): RuntimePolicyDraft {
    return { resource: { ...value.resource }, storage: { ...value.storage }, task: { ...value.task }, request: { ...value.request }, canvas: { ...value.canvas } };
}

function readPolicyValue(value: RuntimePolicyDraft, field: PolicyField) {
    return Number((value[field.group] as unknown as Record<string, unknown>)?.[field.name]);
}

function readDraftNumber(value: RuntimePolicyDraft, group: PolicyGroup, name: string) {
    return Number((value[group] as unknown as Record<string, unknown>)?.[name]);
}

function samePolicy(left: RuntimePolicyDraft, right: RuntimePolicyDraft) {
    return allPolicyFields.every((field) => readPolicyValue(left, field) === readPolicyValue(right, field)) && sameCanvasPolicy(left.canvas, right.canvas);
}

function sameCanvasPolicy(left?: RuntimePolicySetting["canvas"], right?: RuntimePolicySetting["canvas"]) {
    return (left?.connectionLineStyle || defaultCanvasPolicy.connectionLineStyle) === (right?.connectionLineStyle || defaultCanvasPolicy.connectionLineStyle) &&
        (left?.connectionArrowStyle || defaultCanvasPolicy.connectionArrowStyle) === (right?.connectionArrowStyle || defaultCanvasPolicy.connectionArrowStyle) &&
        (left?.connectionEffect || defaultCanvasPolicy.connectionEffect) === (right?.connectionEffect || defaultCanvasPolicy.connectionEffect) &&
        (left?.taskEventHeartbeatSeconds || defaultCanvasPolicy.taskEventHeartbeatSeconds) === (right?.taskEventHeartbeatSeconds || defaultCanvasPolicy.taskEventHeartbeatSeconds) &&
        (left?.taskEventMaxConnectionsPerUser || defaultCanvasPolicy.taskEventMaxConnectionsPerUser) === (right?.taskEventMaxConnectionsPerUser || defaultCanvasPolicy.taskEventMaxConnectionsPerUser) &&
        (left?.taskEventMaxReplayEvents || defaultCanvasPolicy.taskEventMaxReplayEvents) === (right?.taskEventMaxReplayEvents || defaultCanvasPolicy.taskEventMaxReplayEvents) &&
        (left?.taskEventRetentionHours || defaultCanvasPolicy.taskEventRetentionHours) === (right?.taskEventRetentionHours || defaultCanvasPolicy.taskEventRetentionHours) &&
        (left?.taskFallbackPollMinSeconds || defaultCanvasPolicy.taskFallbackPollMinSeconds) === (right?.taskFallbackPollMinSeconds || defaultCanvasPolicy.taskFallbackPollMinSeconds) &&
        (left?.taskFallbackPollMaxSeconds || defaultCanvasPolicy.taskFallbackPollMaxSeconds) === (right?.taskFallbackPollMaxSeconds || defaultCanvasPolicy.taskFallbackPollMaxSeconds);
}

function parseRuntimePolicySetting(value: RuntimePolicySetting): RuntimePolicySetting {
    if (!value || typeof value !== "object") throw new Error("服务端返回的资源与策略格式无效");
    value = { ...value, canvas: { ...defaultCanvasPolicy, ...value.canvas } };
    if (value.task?.providerRequestTimeoutSeconds == null) {
        throw new Error("当前后端尚不支持单次上游请求超时配置，请更新并重启后端后刷新；页面不能代替后端设置实际超时");
    }
    for (const field of allPolicyFields) {
        const fieldValue = readPolicyValue(value, field);
        const min = field.min ?? 1;
        if (!Number.isInteger(fieldValue) || fieldValue < min || fieldValue > field.max) throw new Error(`服务端返回的“${field.label}”无效`);
    }
    const canvas = value.canvas;
    const canvasRanges: Array<[keyof RuntimePolicySetting["canvas"], number, number, string]> = [
        ["taskEventHeartbeatSeconds", 5, 120, "事件心跳"],
        ["taskEventMaxConnectionsPerUser", 1, 32, "事件连接上限"],
        ["taskEventMaxReplayEvents", 1, 1000, "事件回放上限"],
        ["taskEventRetentionHours", 1, 720, "事件保留时间"],
        ["taskFallbackPollMinSeconds", 1, 60, "活动任务兜底刷新"],
        ["taskFallbackPollMaxSeconds", 1, 600, "空闲任务兜底刷新"],
    ];
    for (const [name, min, max, label] of canvasRanges) {
        const fieldValue = Number(canvas[name]);
        if (!Number.isInteger(fieldValue) || fieldValue < min || fieldValue > max) throw new Error(`服务端返回的“${label}”无效`);
    }
    if (canvas.taskFallbackPollMaxSeconds < canvas.taskFallbackPollMinSeconds) throw new Error("服务端返回的画布兜底刷新间隔无效");
    if (typeof value.configured !== "boolean") throw new Error("服务端未返回有效的配置来源状态");
    return value;
}

function validatePolicyRelationships(value: RuntimePolicyDraft) {
    const accountCapacityMB = readDraftNumber(value, "resource", "storedFileGB") * 1024;
    const oversized = resourceFields.slice(0, 3).find((field) => readPolicyValue(value, field) > accountCapacityMB);
    if (oversized) return `${oversized.label}不能大于账号文件总量`;
    if (value.canvas.taskFallbackPollMaxSeconds < value.canvas.taskFallbackPollMinSeconds) return "空闲任务兜底刷新不能小于活动任务兜底刷新";
    return "";
}

function formatPolicyValue(value: number, unit: string) {
    return `${formatNumber(value)} ${unit}`;
}
function formatNumber(value: number) {
    return Number.isFinite(value) ? new Intl.NumberFormat("zh-CN").format(value) : "--";
}
function formatTime(value?: string) {
    if (!value) return "--";
    const time = new Date(value);
    if (!Number.isFinite(time.getTime()) || time.getUTCFullYear() <= 1) return "--";
    return time.toLocaleString("zh-CN", { hour12: false });
}
