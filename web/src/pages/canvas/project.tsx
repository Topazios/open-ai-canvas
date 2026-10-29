import { CanvasWorkspacePanel } from "@/components/canvas/canvas-workspace-panel";
import { CanvasGlobalSettingsDialog } from "@/components/canvas/canvas-global-settings-dialog";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { layoutWorkflowImageGroups } from "@/lib/canvas/canvas-workflow-image-layout";
import { AssetSheetKind, assetReferenceStep, assetSheetLayoutInstruction } from "@/lib/asset-reference-sheet";
import { CanvasProjectAssociation } from "./canvas-project-association";
import { isCanvasNodeGenerating } from "@/lib/canvas/canvas-node-task-state";
import { createCanvasStateWriter } from "@/lib/canvas/canvas-editor-state";
import { layoutCanvasGridGroups } from "@/lib/canvas/canvas-group-grid";
import { canCancelGenerationTask } from "@/lib/generation-task-display";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router";
import { loadAssetsForUse, saveCanvasGlobalSettingsWithRemoteSync, saveRemoteUserDataNow } from "@/services/user-data-sync";
import { reserveProductionVariantCode } from "@/services/api/user-data";
import { canvasAssetHandoffIds } from "@/lib/canvas/canvas-asset-handoff";
import { logicalModelIDForConfig, modelOptionName, resolveModelRequestConfig, selectableModelsByCapability, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import type { ProductionAssetModelSelection } from "@/services/api/agent";
import { createCanvasGenerationLiveProjectAdapter, registerCanvasGenerationLiveProject } from "@/services/canvas-generation-consumer";
import { getActiveUserScope } from "@/lib/user-scope";
import { getResourceAccess, resolveResourceAccessURL, resourceFileUrl, resourceIdFromStorageKey, syncResourceToArkPrivateAsset } from "@/services/api/resources";
import { uploadImage } from "@/services/image-storage";
import { imageMetadata } from "@/lib/canvas/canvas-generation-task-sync";
import { isCanvasImageSourceNode } from "@/lib/canvas/canvas-image-source";
import copyToClipboard from "copy-to-clipboard";
import { nanoid } from "nanoid";
import { canvasAppearanceBaseTheme, canvasAppearanceForTheme, DEFAULT_CANVAS_BACKGROUND_MODE, normalizeCanvasAppearance, resolveCanvasAppearance, writeCanvasAppearanceDefault, type CanvasAppearance } from "@/lib/canvas/canvas-appearance";
import { canvasThemes, type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { persistCanvasMediaPerformanceMode, readCanvasMediaPerformanceMode } from "@/lib/canvas/canvas-performance-mode";
import { summarizeCanvasContext } from "@/lib/canvas/canvas-context-summary";
import { refreshCanvasCharacterReferenceNodes } from "@/lib/canvas/canvas-character-reference";
import { useAssetStore } from "@/stores/use-asset-store";
import { flushCanvasStorePersistence } from "@/stores/canvas/use-canvas-store";
import { ensureCanvasNodeAsset } from "@/services/project-asset-sync";
import { useCanvasThemeStore, useCanvasThemeScope } from "@/stores/canvas/use-canvas-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import { App, Button, Checkbox, Input, Modal } from "antd";
import { ArrowLeftRight, Users, MapPin, Package, AudioLines, Sparkles } from "lucide-react";
import { ModelPicker } from "@/components/model-picker";
import { ReasoningEffortSelect } from "@/components/reasoning-effort-select";
import { normalizeReasoningEffort, type ReasoningEffort } from "@/lib/reasoning-effort";
import { AppModal } from "@/components/ui/product/app-modal";
import { NODE_DEFAULT_SIZE, getNodeSpec } from "@/constant/canvas";
import { CanvasConfigComposer } from "@/components/canvas/canvas-config-composer";
import { CanvasConfigNodePanel } from "@/components/canvas/canvas-config-node-panel";
import { CanvasCloudAgentPanel } from "@/components/canvas/canvas-cloud-agent-panel";
import { CanvasActiveTaskPanel } from "@/components/canvas/canvas-active-task-panel";
import { CanvasProjectSidebar } from "@/components/canvas/canvas-project-sidebar";
import { CanvasProjectAssetModal } from "@/components/canvas/canvas-project-asset-modal";
import { CanvasCharacterReferenceNodeContent } from "@/components/canvas/canvas-character-reference-node";
import { CanvasCharacterReferenceModal } from "@/components/canvas/canvas-character-reference-modal";
import { WorkspaceState } from "@/components/layout/workspace-state";
import { resolveProjectCanvasStyle } from "@/components/canvas/canvas-style-picker-modal";
import { createStyleProfileSnapshot, resolveStyleProfile, serializeStyleProfile } from "@/lib/canvas/style-profile";
import { CanvasNodeToolbar, CanvasNodeInfoModal } from "@/components/canvas/canvas-node-toolbar";
import { CanvasWorkflowTaskDetails } from "./canvas-workflow-task-details";
import { CanvasGroupTaskDetails } from "./canvas-group-task-details";
import { nodeDetailsTarget } from "@/lib/canvas/canvas-group-session";
import { CanvasGenerationTaskDetails } from "./canvas-generation-task-details";
import { emptyWorkflowAssetManifest } from "@/lib/canvas/canvas-workflow-assets";
import { CanvasSubtitleDialog } from "@/components/canvas/canvas-subtitle-dialog";
import { CanvasVideoFrameDialog } from "@/components/canvas/canvas-video-frame-dialog";
import { CanvasVideoSegmentDialog } from "@/components/canvas/canvas-video-segment-dialog";
import { CanvasTimelineDialog } from "@/components/canvas/canvas-timeline-dialog";
import { syncNodeSubtitlesToTimeline } from "@/lib/timeline/timeline-build";
import { CanvasNodeAnglePanel } from "@/components/canvas/canvas-node-angle-dialog";
import { CanvasNodeLightingPanel } from "@/components/canvas/canvas-node-lighting-dialog";
import { CanvasTextEditorModal } from "@/components/canvas/canvas-text-editor-modal";
import { CanvasStoryDevelopmentEditor } from "@/components/canvas/canvas-story-development-editor";
import { CanvasWorkflowGenerator, type WorkflowGeneratorTarget } from "@/components/canvas/canvas-workflow-generator";
import { CanvasScreenplayNodeContent, CanvasScreenplayAuditDetails } from "@/components/canvas/canvas-screenplay-audit";
import { latestBodyAudit, screenplayAuditState } from "@/lib/canvas/workflow-screenplay-audit";
import { resetGenerationTaskMetadata } from "@/lib/canvas/canvas-task-state";
import { workflowAssetActions, workflowAssetRevisionMembers } from "@/lib/canvas/canvas-workflow-asset-actions";
import { CanvasWorkflowAssetReview } from "./canvas-workflow-asset-review";
import { nodeWorkflow, restoreWorkflowSourceConnections, workflowEpisodeProgress, workflowSignature, workflowGroupingProblem } from "@/lib/canvas/canvas-short-drama-workflow";
import { isStoryboardFrameStep, nextShortDramaStepGroups, nextShortDramaSteps, shortDramaStep, ShortDramaStep, type ShortDramaStepId } from "@/lib/short-drama-steps";
import { useShortDramaWorkflowGeneration } from "./use-short-drama-workflow-generation";
import { useProductionAgentRuns } from "./use-production-agent-runs";
import { CanvasProductionAgentDetails } from "./canvas-production-agent-details";
import { productionPlanAssetMenu, productionPlanInventoryRecoveryAvailable } from "@/lib/canvas/production-plan-asset-menu";
import { PlannedAssetKind } from "@/lib/production-plan";
import { useLegacyStoryRecovery } from "./use-legacy-story-recovery";
import { createNextStoryEpisode, prepareStoryEpisodeBatch, saveStoryDevelopmentNode } from "@/lib/canvas/canvas-story-development";
import { CanvasNodeSearchModal } from "@/components/canvas/canvas-node-search-modal";
import { CanvasStylePickerModal } from "@/components/canvas/canvas-style-picker-modal";
import { CanvasDirectorTemplateModal } from "@/components/canvas/director/canvas-director-template-modal";
import { CanvasFileDropOverlay } from "@/components/canvas/canvas-file-drop-overlay";
import { CanvasUploadModal } from "@/components/canvas/canvas-upload-modal";
import { CanvasPanoramaConfigModal } from "@/components/canvas/canvas-panorama-config-modal";
import { InfiniteCanvas } from "@/components/canvas/infinite-canvas";
import { Minimap } from "@/components/canvas/canvas-mini-map";
import { CanvasNodePromptPanel, type CanvasNodeGenerationMode } from "@/components/canvas/canvas-node-prompt-panel";
import { handleListGenerate } from "./list-mode-generator";
import { CanvasToolbar } from "@/components/canvas/canvas-toolbar";
import { useCanvasCreateCommands } from "@/components/canvas/use-canvas-create-commands";
import { AssetPickerModal } from "@/components/canvas/asset-picker-modal";
import { getProject } from "@/services/api/projects";
import { CanvasZoomControls } from "@/components/canvas/canvas-zoom-controls";
import { CanvasShareModal } from "@/components/canvas/canvas-share-modal";
import { CanvasScriptEditor, CanvasScriptNodeContent } from "@/components/canvas/canvas-script-node";
import { CanvasEpisodeStoryboard } from "@/components/canvas/canvas-episode-storyboard";
import { materializeEpisodeStoryboard } from "@/lib/canvas/workflow-episode-storyboard";
import { CanvasBatchTableNodeContent } from "@/components/canvas/canvas-batch-table-node";
import { BatchGenerationSettingsDialog } from "@/components/canvas/batch-generation-settings-dialog";
import { CanvasTextBatchGenerationModal, type TextAssetBatchGenerationSettings } from "@/components/canvas/canvas-text-batch-generation-modal";
import { batchReferenceColumns, promoteLegacyBatchTableSize } from "@/lib/canvas/canvas-batch-table";
import { storyboardMinNodeHeight } from "@/lib/canvas/canvas-storyboard-layout";
import { CanvasDirectorNodePanel } from "@/components/canvas/director/canvas-director-node-panel";
import { CanvasVersionCompareModal } from "@/components/canvas/canvas-version-compare-modal";
import { useFocusMode } from "@/hooks/use-focus-mode";
import { connectCanvasTextMention } from "@/lib/canvas/canvas-text-mention";
import { writeCanvasNodePrompt } from "@/lib/canvas/canvas-node-prompt";
import {
    applyCanvasConnectionPromptSync,
    buildCanvasAgentMentionReferences,
    canvasResourceMentionToken,
    buildCanvasNodeMentionReferenceMap,
    buildCanvasResourceReferences,
    normalizeCanvasNodeMentionTokens,
    reorderCanvasResourceConnections,
    replaceCanvasReferenceMentions,
    type CanvasResourceReference,
} from "@/lib/canvas/canvas-resource-references";
import { CanvasConnectionCreateMenu, CanvasNodePanelOverlay } from "@/components/canvas/canvas-workspace-overlays";
import { CanvasOverlayLayerContainer, CanvasOverlayLayerProvider } from "@/components/canvas/canvas-overlay-layer";
import { CanvasLeaferGraphicsLayer } from "@/components/canvas/canvas-leafer-graphics-layer";
import { CanvasFreeformEmptyState, CanvasLinkedProjectEmptyState, CanvasShortDramaEmptyState, CanvasShortDramaGuide, CanvasStoryInputNodeContent, CanvasStylePlaceholderNodeContent } from "@/components/canvas/canvas-short-drama-entry";
import { resolveCanvasEmptyStateKind } from "@/lib/canvas/canvas-starter";
import { failedImageBatchChildren, markImageBatchRetrying, reconcileImageBatchRoot, restoreUnsubmittedImageBatchChild } from "@/lib/canvas/canvas-image-batch-retry";
import { CONTENT_MODERATION_ERROR_CODE, isContentModerationError } from "@/lib/generation-error";
import { cinematicStoryboardColumns, createCanvasNode, isHiddenBatchChild } from "@/lib/canvas/canvas-project-domain";
import { bindStoryboardKeyframes, storyboardKeyframeTime, storyboardRowsFromBatchTable } from "@/lib/canvas/canvas-batch-storyboard";
import { stampCanvasNodeChanges } from "@/lib/canvas/canvas-node-timestamps";
import { canvasAssetHandoffAttempt, finalizeCanvasAssetHandoff, uninsertedCanvasAssetHandoffPayloads } from "@/lib/canvas/canvas-asset-handoff";
import { batchSourceRestriction } from "@/lib/canvas/canvas-batch-connection";
import { deriveStoryboardPipelineProgress } from "@/lib/canvas/canvas-storyboard-progress";
import { CanvasOperationChangeToast, CanvasMergeStatusToast, CanvasUploadStatusToast } from "./canvas-project-feedback";
import { backendProviderConfig, getGenerationCount } from "@/lib/canvas/canvas-project-generation";
import { generationSpecMetadata, specFromConfig } from "@/lib/canvas/generation-contract";
import { applyToolMention } from "@/lib/canvas/canvas-resource-references";
import { cancelGenerationTask } from "@/services/api/task-center";
import { cancelRemovedCanvasNodeTasks, reconcileCanvasNodeTasks } from "@/services/canvas-node-task-cleanup";
import { CanvasSyncStatus } from "./canvas-sync-status";
import { CanvasVersionHistory, useCanvasVersionHistory } from "./canvas-version-history";
import { CanvasTopBar } from "./canvas-project-top-bar";
import { LibTVImportDialog } from "./components/libtv-import-dialog";
import { TapNowImportDialog } from "./components/tapnow-import-dialog";
import { CanvasFocusModeBar } from "@/components/canvas/canvas-focus-mode-bar";
import { CanvasProjectContextMenu } from "./canvas-project-context-menu";
import { CanvasProjectMediaDialogs } from "./canvas-project-media-dialogs";
import { CanvasProjectSelectionToolbar } from "./canvas-project-selection-toolbar";
import { CanvasProjectStatusDialogs } from "./canvas-project-status-dialogs";
import { CanvasProjectWorldLayers } from "./canvas-project-world-layers";
import { CanvasNodeActionContext, type CanvasNodeActionContextValue } from "@/components/canvas/canvas-node-action-context";
import { bringCanvasNodeToFront, type CanvasNodeStackOrder } from "@/lib/canvas/canvas-node-stack-order";
import { AiArtCritiqueModal } from "@/components/canvas/art-critique/ai-art-critique-modal";
import { CanvasRefreshShell } from "./canvas-refresh-shell";
import { queryGenerationTask } from "@/services/api/task-center";
import type { CanvasImageEmotionPayload } from "@/components/canvas/canvas-node-emotion-panel";
import { CanvasEmotionWorkspace } from "@/components/canvas/canvas-emotion-workspace";
import { removeCanvasDrawing } from "@/lib/canvas/canvas-drawing-storage";
import { useCanvasConnectionController } from "./use-canvas-connection-controller";
import { useCanvasOperationHistory } from "./use-canvas-operation-history";
import { useCanvasAssistantVisibility } from "./use-canvas-assistant-visibility";
import { useCanvasActiveTasks } from "./use-canvas-active-tasks";
import { useCanvasStyleWorkflow } from "./use-canvas-style-workflow";
import { useCanvasDirector } from "./use-canvas-director";
import { useCanvasGeneration } from "./use-canvas-generation";
import { useCanvasGenerationBatches } from "./use-canvas-generation-batches";
import { useCanvasBatchTable } from "./use-canvas-batch-table";
import { useCanvasGenerationExecutor, type CanvasNodeGenerationOptions } from "./use-canvas-generation-executor";
import { useCanvasGenerationRetry } from "./use-canvas-generation-retry";
import { useCanvasHistory } from "./use-canvas-history";
import { useCanvasKeyboard } from "./use-canvas-keyboard";
import { useCanvasMediaTools } from "./use-canvas-media-tools";
import { useCanvasNodeEditor } from "./use-canvas-node-editor";
import { useCanvasNodeOperations } from "./use-canvas-node-operations";
import { useCanvasProjectLifecycle } from "./use-canvas-project-lifecycle";
import { useCanvasRenderModel } from "./use-canvas-render-model";
import { useCanvasScopedNodeRenderers, type CanvasCustomNodeScope } from "./use-canvas-scoped-node-renderers";
import { useCanvasEditorFocus } from "./use-canvas-editor-focus";
import { useCanvasShotProjection } from "./use-canvas-shot-projection";
import { useCanvasNodeContentUpdates } from "./use-canvas-node-content-updates";
import { useCanvasPerformanceDiagnostics } from "./use-canvas-performance-diagnostics";
import { useCanvasSelectionController } from "./use-canvas-selection-controller";
import { useCanvasShortDrama } from "./use-canvas-short-drama";
import { useCanvasStoryboard } from "./use-canvas-storyboard";
import { useEpisodeStoryboardFrames } from "./use-episode-storyboard-frames";
import { useCanvasUpload } from "./use-canvas-upload";
import { useCanvasTimelineAssetInsert } from "./use-canvas-timeline-asset-insert";
import { useCanvasViewportController } from "./use-canvas-viewport-controller";
import { findAvailableGenerationGroupPosition } from "@/lib/canvas/canvas-generation-layout";
import { FRAME_HEADER_HEIGHT } from "@/lib/canvas/canvas-frame";
import { nodeSizeFromRatio } from "@/lib/canvas/canvas-node-size";
import {
    CanvasNodeType,
    type CanvasAssistantSession,
    type CanvasConnection,
    type CanvasFolderStyle,
    type CanvasFolderTheme,
    type CanvasNodeData,
    type CanvasNodeRetryOptions,
    type CanvasNodeMetadata,
    type CanvasMediaPerformanceMode,
    type StoryboardColumn,
    type StoryboardShotCount,
    type StoryboardShotDuration,
    type CanvasWorkspaceMode,
    type CanvasToolMode,
    type ContextMenuState,
    type Position,
    type ViewportTransform,
} from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";
import type { TextAssetBatchItem } from "@/lib/canvas/text-asset-batch";
import { ART_CRITIQUE_NODE_TYPE } from "@/lib/art-critique/contracts";
import { copyImageToSystemClipboard } from "./canvas-clipboard";

const CanvasDirectorWorkbench = lazy(() => import("@/components/canvas/director/canvas-director-workbench").then((module) => ({ default: module.CanvasDirectorWorkbench })));
const CanvasDrawingEditorModal = lazy(() => import("@/components/canvas/canvas-drawing-editor-modal").then((module) => ({ default: module.CanvasDrawingEditorModal })));
const CanvasVersionPreview = lazy(() => import("./canvas-version-preview").then((module) => ({ default: module.CanvasVersionPreview })));

const RETRY_FAILED_CONCURRENCY = 3;
const REFERENCE_ASSET_GRID_GAP = 72;
const REFERENCE_ASSET_GRID_PADDING = 40;
const REFERENCE_ASSET_GRID_COLUMNS = 3;

const NODE_STATUS_SUCCESS = "success" as const;
const EMPTY_RESOURCE_REFERENCES: CanvasResourceReference[] = [];

function visibleGenerationBatch(node: CanvasNodeData) {
    const batches = node.metadata?.generationBatches || [];
    for (let index = batches.length - 1; index >= 0; index -= 1) {
        if (batches[index].status === "queued" || batches[index].status === "running") return batches[index];
    }
    return batches.at(-1);
}

export default function CanvasPage() {
    useCanvasThemeScope();
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
    }, []);

    if (!mounted) return <CanvasRefreshShell />;

    return <InfiniteCanvasPage />;
}

function InfiniteCanvasPage() {
    // 命令式确认必须走 App.useApp().modal；静态 Modal.confirm 拿不到主题和 App 上下文。
    const { message, modal } = App.useApp();
    const queryClient = useQueryClient();
    const params = useParams<{ id: string }>();
    const [searchParams, setSearchParams] = useSearchParams();
    const projectId = params.id || "";
    const [globalSettingsOpen, setGlobalSettingsOpen] = useState(false);
    const canvasStorageScope = getActiveUserScope();
    const containerRef = useRef<HTMLDivElement>(null);
    const editingNodeId = useCanvasEditorFocus(projectId, containerRef);
    const didInitialCenterRef = useRef(false);
    const toolbarHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const assetHandoffRef = useRef("");

    const effectiveConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const assets = useAssetStore((state) => state.assets);
    const assetsHydrated = useAssetStore((state) => state.hydrated);
    const cleanupAssetImages = useAssetStore((state) => state.cleanupImages);
    const colorTheme = useCanvasThemeStore((state) => state.theme);
    const setTheme = useCanvasThemeStore((state) => state.setTheme);
    const theme = canvasThemes[colorTheme];
    const defaultDrawingEngine = useUserStore((state) => state.drawingEngine.defaultEngine);
    const shortDramaEnabled = useUserStore((state) => state.features.shortDramaEnabled);
    const [projectAssociationOpen, setProjectAssociationOpen] = useState(false);
    const directorOnboardingScope = useUserStore((state) => state.user?.id?.trim() || "");
    const nodesRef = useRef<CanvasNodeData[]>([]);
    const [nodes, setNodesState] = useState<CanvasNodeData[]>([]);
    const setNodes = useMemo(() => createCanvasStateWriter(nodesRef, setNodesState, (before, after) => stampCanvasNodeChanges(before, layoutCanvasGridGroups(after))), []);
    const [nodeStackOrder, setNodeStackOrder] = useState<CanvasNodeStackOrder>([]);
    const bringNodeToFront = useCallback((nodeId: string) => {
        setNodeStackOrder((current) => bringCanvasNodeToFront(current, nodeId));
    }, []);
    const [connections, setConnectionsState] = useState<CanvasConnection[]>([]);
    const connectionsRef = useRef<CanvasConnection[]>([]);
    const setConnections = useMemo(() => createCanvasStateWriter(connectionsRef, setConnectionsState), []);
    const [chatSessions, setChatSessions] = useState<CanvasAssistantSession[]>([]);
    const [activeChatId, setActiveChatId] = useState<string | null>(null);
    const [viewport, setViewport] = useState<ViewportTransform>({ x: 0, y: 0, k: 1 });
    const [size, setSize] = useState({ width: 1200, height: 720 });
    const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
    const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
    const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
    const [agentPrefillPrompt, setAgentPrefillPrompt] = useState("");
    const [isMiniMapOpen, setIsMiniMapOpen] = useState(false);
    const [canvasAppearance, setCanvasAppearance] = useState<CanvasAppearance>(() => canvasAppearanceForTheme(colorTheme));
    const [backgroundMode, setBackgroundMode] = useState<CanvasBackgroundMode>(DEFAULT_CANVAS_BACKGROUND_MODE);
    const [showImageInfo, setShowImageInfo] = useState(false);
    const [canvasTool, setCanvasTool] = useState<CanvasToolMode>("box-select");
    const [mediaPerformanceMode, setMediaPerformanceMode] = useState<CanvasMediaPerformanceMode>(readCanvasMediaPerformanceMode);
    const canvasConnectionPolicy = useUserStore((state) => state.runtimeLimits.canvas);
    const [projectLoaded, setProjectLoaded] = useState(false);
    useCanvasPerformanceDiagnostics(projectLoaded && searchParams.get("canvasDiagnostics") === "1", containerRef, nodesRef, connectionsRef);
    const workspaceMode: CanvasWorkspaceMode = "professional";
    const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
    const [shareModalOpen, setShareModalOpen] = useState(false);
    const [tapNowImportOpen, setTapNowImportOpen] = useState(false);
    const [nodeSearchOpen, setNodeSearchOpen] = useState(false);
    const [toolbarNodeId, setToolbarNodeId] = useState<string | null>(null);
    const [arkPrivateAssetUploadNodeId, setArkPrivateAssetUploadNodeId] = useState<string | null>(null);
    const [nodeImageSettingsOpen, setNodeImageSettingsOpen] = useState(false);
    const [dialogNodeId, setDialogNodeId] = useState<string | null>(null);
    const [textBatchSourceNodeId, setTextBatchSourceNodeId] = useState<string | null>(null);
    const [textEditorNodeId, setTextEditorNodeId] = useState<string | null>(null);
    const [workflowGenerator, setWorkflowGenerator] = useState<WorkflowGeneratorTarget | null>(null);
    const [assetModelDialog, setAssetModelDialog] = useState<{ targetId: string; kinds: string[]; label: string; model: string; reasoningEffort: ReasoningEffort; instruction: string; continueAppend: boolean } | null>(null);
    const [screenplayAuditDetailId, setScreenplayAuditDetailId] = useState<string | null>(null);
    const [assetReviewId, setAssetReviewId] = useState<string | null>(null);
    const textEditorOriginalRef = useRef<CanvasNodeData | null>(null);
    const [characterReferenceNodeId, setCharacterReferenceNodeId] = useState<string | null>(null);
    const [drawingNodeId, setDrawingNodeId] = useState<string | null>(null);
    const [stylePickerOpen, setStylePickerOpen] = useState(false);
    // 新建导演台镜头必须先选模板：null 表示未在选择中，undefined position 表示用画布中心。
    const [directorTemplateRequest, setDirectorTemplateRequest] = useState<{ position?: Position } | null>(null);
    const [infoNodeId, setInfoNodeId] = useState<string | null>(null);
    const [subtitleNodeId, setSubtitleNodeId] = useState<string | null>(null);
    const [timelineNodeId, setTimelineNodeId] = useState<string | null>(null);
    const [superResolveNodeId, setSuperResolveNodeId] = useState<string | null>(null);
    const [previewNodeId, setPreviewNodeId] = useState<string | null>(null);
    const [scriptEditorNodeId, setScriptEditorNodeId] = useState<string | null>(null);
    const [artCritiqueNodeId, setArtCritiqueNodeId] = useState<string | null>(null);
    const artCritiqueRunningRef = useRef(false);
    const [artCritiqueStartRequest, setArtCritiqueStartRequest] = useState<{ nodeId: string; id: string; restart: boolean } | null>(null);
    const [scriptScrollTopById, setScriptScrollTopById] = useState<Record<string, number>>({});
    const [directorNodeId, setDirectorNodeId] = useState<string | null>(null);
    const [versionCompareRootId, setVersionCompareRootId] = useState<string | null>(null);
    const [libTVImportOpen, setLibTVImportOpen] = useState(false);
    const [titleEditing, setTitleEditing] = useState(false);
    const [titleDraft, setTitleDraft] = useState("");
    const [shortcutRequestNonce, setShortcutRequestNonce] = useState(0);
    const [cinematicAgentEntry, setCinematicAgentEntry] = useState(false);
    const { assistantOpen, closeAgent, openAgent: openAssistant } = useCanvasAssistantVisibility();
    const agentMentionReferences = useMemo(() => buildCanvasAgentMentionReferences(nodes), [nodes]);

    const { tasks: activeTasks } = useCanvasActiveTasks(projectId, projectLoaded);
    useEffect(() => {
        if (!projectLoaded) return;
        const converted = nodes.map(materializeEpisodeStoryboard);
        if (converted.some((node, index) => node !== nodes[index])) setNodes(converted);
    }, [nodes, projectLoaded, setNodes]);
    const { focusMode, enterFocusMode, exitFocusMode, toggleFocusMode } = useFocusMode();
    const [focusDockRevealed, setFocusDockRevealed] = useState(false);

    useEffect(() => {
        persistCanvasMediaPerformanceMode(mediaPerformanceMode);
    }, [mediaPerformanceMode]);

    useEffect(() => {
        didInitialCenterRef.current = false;
        setNodeStackOrder([]);
    }, [projectId]);

    useEffect(() => {
        const nodeIds = new Set(nodes.map((node) => node.id));
        setNodeStackOrder((current) => {
            const next = current.filter((nodeId) => nodeIds.has(nodeId));
            return next.length === current.length ? current : next;
        });
    }, [nodes]);

    const chatSessionsRef = useRef(chatSessions);
    const activeChatIdRef = useRef(activeChatId);
    const selectedNodeIdsRef = useRef(selectedNodeIds);
    const viewportRef = useRef(viewport);
    const [workspaceOpen, setWorkspaceOpen] = useState(false);
    const generateNodeRef = useRef<((nodeId: string, mode: CanvasNodeGenerationMode, prompt: string, options?: CanvasNodeGenerationOptions) => Promise<void>) | null>(null);

    useEffect(() => {
        if (!projectId) return;
        return registerCanvasGenerationLiveProject({
            scope: canvasStorageScope,
            projectId,
            adapter: createCanvasGenerationLiveProjectAdapter({ nodesRef, connectionsRef, chatSessionsRef, activeChatIdRef, setNodes, setConnections, setChatSessions, setActiveChatId }),
        });
    }, [canvasStorageScope, projectId]);

    const resolvedCanvasAppearance = useMemo(() => resolveCanvasAppearance(canvasAppearance, colorTheme), [canvasAppearance, colorTheme]);
    const applyCanvasAppearance = useCallback(
        (next: CanvasAppearance) => {
            const fallback = canvasAppearanceBaseTheme(next, colorTheme);
            const normalized = normalizeCanvasAppearance(next, fallback);
            setCanvasAppearance(normalized);
            setTheme(canvasAppearanceBaseTheme(normalized, fallback));
        },
        [colorTheme, setTheme],
    );
    const saveCanvasAppearanceDefault = useCallback(
        (next: CanvasAppearance) => {
            writeCanvasAppearanceDefault({ appearance: next, backgroundMode });
            message.success("已保存为当前账号在本机的新建画布默认外观");
        },
        [backgroundMode, message],
    );

    const { getHistoryCleanupContext, historyPausedRef, historyState, redoCanvas, resetHistory, undoCanvas } = useCanvasHistory({
        projectLoaded,
        nodes,
        connections,
        chatSessions,
        activeChatId,
        canvasAppearance,
        backgroundMode,
        showImageInfo,
        setNodes,
        setConnections,
        setChatSessions,
        setActiveChatId,
        applyCanvasAppearance,
        setBackgroundMode,
        setShowImageInfo,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setContextMenu,
    });

    const cleanupCanvasFiles = useCallback(
        (extra?: unknown) => {
            cleanupAssetImages({ extra, ...getHistoryCleanupContext() });
        },
        [cleanupAssetImages, getHistoryCleanupContext],
    );

    const { loadError, retryLoad, addedSkills, agentCreatedNodes, clearCanvasFiles, createAndOpenProject, currentProject, deleteCurrentProject, renameCurrentProject, reloadLatestCanvasProject, restoreCanvasProjectVersion, saveCanvasProject, persistLocalEdits, forceSaveCanvasProject, updateProject } = useCanvasProjectLifecycle({
        projectId,
        projectLoaded,
        nodes,
        connections,
        chatSessions,
        activeChatId,
        canvasAppearance,
        backgroundMode,
        showImageInfo,
        viewport,
        nodesRef,
        connectionsRef,
        chatSessionsRef,
        activeChatIdRef,
        viewportRef,
        historyPausedRef,
        setNodes,
        setConnections,
        setChatSessions,
        setActiveChatId,
        setCanvasAppearance,
        setBackgroundMode,
        setShowImageInfo,
        setViewport,
        setProjectLoaded,
        resetHistory,
        cleanupAssetImages,
        cleanupCanvasFiles,
    });

    const versions = useCanvasVersionHistory(projectId, restoreCanvasProjectVersion);
    useEffect(() => {
        if (!projectLoaded || versions.preview) return;
        const repaired = restoreWorkflowSourceConnections(nodes, connections);
        if (repaired === connections) return;
        setConnections(repaired);
        void saveCanvasProject({ requireRemote: true }).catch(() => message.warning("工作流来源连线已在本地恢复，云端保存待重试"));
    }, [connections, message, nodes, projectLoaded, saveCanvasProject, setConnections, versions.preview]);
    const openVersions = () => { closeAgent(); setVersionCompareRootId(null); versions.show(); };
    const openAgent = useCallback(() => { versions.close(); openAssistant(); }, [versions.close, openAssistant]);

    const sendSelectionToAgent = useCallback((nodeId?: string) => {
        const ids = nodeId ? [nodeId] : Array.from(selectedNodeIdsRef.current);
        const references = ids.map((id) => agentMentionReferences.find((reference) => reference.nodeId === id)).filter((reference): reference is CanvasResourceReference => Boolean(reference));
        if (!references.length) return;
        if (nodeId && !selectedNodeIdsRef.current.has(nodeId)) {
            const selection = new Set([nodeId]);
            selectedNodeIdsRef.current = selection;
            setSelectedNodeIds(selection);
        }
        setAgentPrefillPrompt(`${references.map(canvasResourceMentionToken).join(" ")} `);
        openAgent();
        setContextMenu(null);
    }, [agentMentionReferences, openAgent]);
    // 修复素材关联仍遵守当前画布版本，不能替用户确认覆盖云端的新内容。
    const confirmForceSaveCanvas = useCallback(() => {
        modal.confirm({
            title: "修复素材关联并保存？",
            content: "核对画布媒体与素材库的关联，补齐缺失素材后保存。若云端已有新版本，会保留本地草稿并提示加载最新版。",
            okText: "修复并保存",
            cancelText: "取消",
            onOk: () => forceSaveCanvasProject(),
        });
    }, [forceSaveCanvasProject, modal]);

    const applyLibTVImport = useCallback(
        async (importedNodes: CanvasNodeData[], importedConnections: CanvasConnection[]) => {
            const previousNodes = nodesRef.current;
            const previousConnections = connectionsRef.current;
            const nextNodes = [...nodesRef.current, ...importedNodes];
            const nextConnections = [...connectionsRef.current, ...importedConnections];
            nodesRef.current = nextNodes;
            connectionsRef.current = nextConnections;
            setNodes(nextNodes);
            setConnections(nextConnections);
            const saved = await saveCanvasProject({ requireRemote: false });
            if (!saved) {
                nodesRef.current = previousNodes;
                connectionsRef.current = previousConnections;
                setNodes(previousNodes);
                setConnections(previousConnections);
                throw new Error("画布保存失败，已撤销本次 LibTV 导入");
            }
        },
        [saveCanvasProject, setConnections, setNodes],
    );
    const applyTapNowImport = useCallback(
        async (importedNodes: CanvasNodeData[], importedConnections: CanvasConnection[]) => {
            const previousNodes = nodesRef.current;
            const previousConnections = connectionsRef.current;
            const nextNodes = [...nodesRef.current, ...importedNodes];
            const nextConnections = [...connectionsRef.current, ...importedConnections];
            nodesRef.current = nextNodes;
            connectionsRef.current = nextConnections;
            setNodes(nextNodes);
            setConnections(nextConnections);
            const saved = await saveCanvasProject({ requireRemote: false });
            if (!saved) {
                nodesRef.current = previousNodes;
                connectionsRef.current = previousConnections;
                setNodes(previousNodes);
                setConnections(previousConnections);
                throw new Error("画布保存失败，已撤销本次 TapNow 导入");
            }
        },
        [saveCanvasProject, setConnections, setNodes],
    );
    const linkedProjectId = shortDramaEnabled ? currentProject?.projectId || "" : "";
    const linkedProjectQuery = useQuery({ queryKey: ["project", linkedProjectId], queryFn: () => getProject(linkedProjectId), enabled: Boolean(linkedProjectId) });
    const refetchLinkedProject = linkedProjectQuery.refetch;
    const shotProjection = useCanvasShotProjection(linkedProjectId, projectId, linkedProjectQuery.data?.canvasNodeShotLinks);
    const isShotProjectionActive = useCallback((nodeId: string) => shotProjection.bindings.has(nodeId) && !shotProjection.originalNodeIds.has(nodeId), [shotProjection.bindings, shotProjection.originalNodeIds]);
    const batchProjectStyle = useMemo(() => {
        const project = linkedProjectQuery.data?.project;
        return resolveProjectCanvasStyle(project?.stylePresetId, project?.styleProfileJson) || null;
    }, [linkedProjectQuery.data?.project]);
    const archiveNodesToLinkedFolder = useCallback(
        (folder: CanvasNodeData, droppedNodes: CanvasNodeData[]) => {
            const folderId = folder.metadata?.folder?.assetFolderId;
            const domainProjectId = folder.metadata?.folder?.projectId || linkedProjectId;
            if (!folderId || !domainProjectId || !droppedNodes.length) return;
            void Promise.all(droppedNodes.map((node) => ensureCanvasNodeAsset({ canvasId: projectId, domainProjectId, folderId, node, source: "canvas-manual" })))
                .then((results) => {
                    const archivedByNodeId = new Map(droppedNodes.map((node, index) => [node.id, { assetId: results[index].assetId, content: node.metadata?.content, previousAssetId: node.metadata?.assetId }]));
                    setNodes((current) =>
                        current.map((node) => {
                            const archived = archivedByNodeId.get(node.id);
                            if (!archived || node.metadata?.content !== archived.content || node.metadata?.assetId !== archived.previousAssetId) return node;
                            return { ...node, metadata: { ...node.metadata, assetId: archived.assetId } };
                        }),
                    );
                    void refetchLinkedProject();
                    message.success(`已归档到“${folder.title}”`);
                })
                .catch((error) => message.error(error instanceof Error ? error.message : "素材归档失败"));
        },
        [linkedProjectId, message, projectId, refetchLinkedProject, setNodes],
    );
    useEffect(() => {
        if (!projectLoaded || !linkedProjectQuery.data) return;
        setNodes((current) => refreshCanvasCharacterReferenceNodes(current, linkedProjectQuery.data.assets));
    }, [linkedProjectQuery.data, projectLoaded, setNodes]);
    const canvasContext = useMemo(() => summarizeCanvasContext(nodes, selectedNodeIds, linkedProjectQuery.data?.units), [linkedProjectQuery.data?.units, nodes, selectedNodeIds]);
    // 扩展节点（对比/图表/调色）要读自己的上游才能渲染，经 Context 下发；
    // 取上游复用 canvas-resource-references 的实现，别在这里另写一份。必须 memo——
    // 每帧新对象会让所有节点跟着重渲染，错题本里多条崩溃都出在画布高频更新。

    const persistCanvasTaskBinding = useCallback(async () => {
        // 任务 ID 是刷新恢复的唯一稳定关联。创建任务后立即把绑定写入
        // 本地持久层和云端，页面关闭不依赖普通自动同步窗口。
        await persistLocalEdits();
        await saveRemoteUserDataNow(projectId);
    }, [persistLocalEdits, projectId]);
    const { applyGenerationTaskResult, bindGenerationTask, finishGenerationRequest, runningNodeId, setRunningNodeId, setTaskDetail, startGenerationRequest, taskDetail, taskDetailLoading, taskDetailLogs } = useCanvasGeneration({
        projectId,
        domainProjectId: linkedProjectId,
        projectLoaded,
        nodes,
        nodesRef,
        setNodes,
        persistTaskBinding: persistCanvasTaskBinding,
    });

    const cancelCanvasTask = useCallback(
        (task: import("@/services/api/task-center").GenerationTask) => {
            if (!canCancelGenerationTask(task)) {
                message.info("第三方请求已提交，任务将继续创作，不能取消");
                return;
            }
            modal.confirm({
                title: "取消生成任务？",
                content: "任务会立即停止本地执行；如果已经提交到上游，系统会继续核对取消结果和积分状态。",
                okText: "取消任务",
                okButtonProps: { danger: true },
                cancelText: "继续等待",
                onOk: async () => {
                    const latestTask = taskDetail?.id === task.id ? taskDetail : task;
                    if (!canCancelGenerationTask(latestTask)) {
                        message.info("第三方请求已提交，任务将继续创作，不能取消");
                        return;
                    }
                    try {
                        const next = await cancelGenerationTask(task.id);
                        const node = nodesRef.current.find((item) => item.metadata?.taskId === task.id);
                        if (node) bindGenerationTask(node.id, next);
                        setTaskDetail((current) => (current?.id === task.id ? next : current));
                        await queryClient.invalidateQueries({ queryKey: ["canvas-active-tasks", projectId] });
                        message.success("任务已取消");
                    } catch (error) {
                        message.error(error instanceof Error ? error.message : "取消任务失败");
                    }
                },
            });
        },
        [bindGenerationTask, message, modal, nodesRef, projectId, queryClient, setTaskDetail, taskDetail],
    );
    const cancelCanvasNodeTask = useCallback((node: CanvasNodeData) => {
        const taskId = node.metadata?.taskId;
        if (!taskId) {
            message.info("当前节点没有可取消的任务");
            return;
        }
        void queryGenerationTask(taskId)
            .then((task) => cancelCanvasTask(task))
            .catch((error) => message.error(error instanceof Error ? error.message : "任务状态加载失败"));
    }, [cancelCanvasTask, message]);

    useEffect(() => {
        const sessionId = searchParams.get("conversation");
        if (!projectLoaded || !sessionId) return;
        if (!chatSessions.some((session) => session.id === sessionId)) {
            message.warning("未找到要接续的会话，请从首页重新进入。");
        } else {
            activeChatIdRef.current = sessionId;
            setActiveChatId(sessionId);
            openAgent();
        }
        const next = new URLSearchParams(searchParams);
        next.delete("conversation");
        setSearchParams(next, { replace: true });
    }, [projectLoaded, chatSessions, searchParams, setSearchParams, openAgent, message]);

    useEffect(() => {
        if (!projectLoaded || searchParams.get("agent") !== "1") return;
        openAgent();
        const next = new URLSearchParams(searchParams);
        next.delete("agent");
        setSearchParams(next, { replace: true });
    }, [projectLoaded, searchParams, setSearchParams, openAgent]);

    // 沉浸专注进入时收起智能体与小地图、重置 Dock 唤出态；仅响应「进入」瞬间，避免关闭专注内主动唤出的面板。
    const prevFocusModeRef = useRef(focusMode);
    useEffect(() => {
        const enteredFocus = focusMode && !prevFocusModeRef.current;
        prevFocusModeRef.current = focusMode;
        if (!enteredFocus) return;
        closeAgent();
        setIsMiniMapOpen(false);
        setFocusDockRevealed(false);
    }, [closeAgent, focusMode]);

    useEffect(() => {
        if (!dialogNodeId) setNodeImageSettingsOpen(false);
    }, [dialogNodeId]);

    useLayoutEffect(() => {
        chatSessionsRef.current = chatSessions;
        activeChatIdRef.current = activeChatId;
        selectedNodeIdsRef.current = selectedNodeIds;
        viewportRef.current = viewport;
    }, [activeChatId, chatSessions, nodes, connections, selectedNodeIds, viewport]);

    useEffect(() => {
        if (!projectLoaded) return;
        const el = containerRef.current;
        if (!el) return;

        const updateSize = () => {
            const rect = el.getBoundingClientRect();
            setSize((current) => (current.width === rect.width && current.height === rect.height ? current : { width: rect.width, height: rect.height }));
            if (!didInitialCenterRef.current) {
                didInitialCenterRef.current = true;
                const current = viewportRef.current;
                if (current.x === 0 && current.y === 0 && current.k === 1) {
                    const centered = { x: rect.width / 2, y: rect.height / 2, k: 1 };
                    viewportRef.current = centered;
                    setViewport(centered);
                }
            }
        };

        updateSize();
        const resizeObserver = new ResizeObserver(updateSize);
        resizeObserver.observe(el);
        return () => resizeObserver.disconnect();
    }, [projectLoaded]);

    const {
        fitCanvasContent,
        fitCanvasSelection,
        focusCanvasImageNode,
        focusCanvasNode,
        getCanvasCenter,
        handleCanvasDoubleClick,
        handleViewportChange,
        handleViewportPreviewChange,
        previewViewport,
        screenToCanvas,
        setZoomScale,
        zoomCanvasIn,
        zoomCanvasOut,
        zoomToActualSize,
    } = useCanvasViewportController({
        agentCreatedNodes,
        containerRef,
        size,
        viewportRef,
        nodesRef,
        selectedNodeIdsRef,
        setViewport,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setContextMenu,
        setDialogNodeId,
        setToolbarNodeId,
    });

    useEffect(() => {
        const project = linkedProjectQuery.data?.project;
        const preset = resolveProjectCanvasStyle(project?.stylePresetId, project?.styleProfileJson);
        if (!projectLoaded || !preset) return;
        const profile = resolveStyleProfile(project?.stylePresetId, project?.styleProfileJson, preset.profile || createStyleProfileSnapshot(preset));
        if (!profile) return;
        const current = nodesRef.current.find((node) => node.type === CanvasNodeType.Text && node.metadata?.workflowKind === "styleboard");
        // A free-canvas style is authored content; project association must not replace it.
        if (current && !current.metadata?.locked) return;
        const nextMetadata = {
            content: profile.prompt,
            prompt: profile.prompt,
            status: NODE_STATUS_SUCCESS,
            workflowKind: "styleboard" as const,
            workflowTitle: "项目画风",
            workflowDescription: profile.description,
            stylePresetId: profile.presetId,
            styleProfileJson: serializeStyleProfile(profile),
            fontSize: 14,
            locked: true,
        };
        if (current) {
            if (current.metadata?.stylePresetId === profile.presetId && current.metadata?.content === profile.prompt && current.metadata?.styleProfileJson === nextMetadata.styleProfileJson && current.metadata?.locked) return;
            setNodes((nodes) => nodes.map((node) => (node.id === current.id ? { ...node, title: `项目画风 · ${profile.title}`, metadata: { ...node.metadata, ...nextMetadata } } : node)));
            return;
        }
        const node = createCanvasNode(CanvasNodeType.Text, getCanvasCenter(), nextMetadata);
        node.title = `项目画风 · ${profile.title}`;
        node.width = 420;
        node.height = 240;
        setNodes((nodes) => [...nodes, node]);
    }, [getCanvasCenter, linkedProjectQuery.data?.project, projectLoaded, setNodes]);

    const {
        assetPickerOpen,
        closeUploadModal,
        closeAssetPicker,
        createVideoNodeFromBlob,
        fileDropActive,
        handleAssetsInsert,
        handleDrop,
        handleFileDragEnter,
        handleFileDragLeave,
        handleFileDragOver,
        handleImageInputChange,
        handleProjectAssetsInsert,
        handleProjectChapterInsert,
        handleUploadFiles,
        handleUploadRequest,
        imageInputRef,
        openAssetsAtPosition,
        pasteSystemClipboard,
        replaceNodeMedia,
        createFileNode,
        startUploadStatus,
        uploadModalOpen,
        uploadTimelineMedia,
        uploadStatus,
    } = useCanvasUpload({
        canvasId: projectId,
        domainProjectId: linkedProjectId,
        nodesRef,
        selectedNodeIdsRef,
        getCanvasCenter,
        screenToCanvas,
        setNodes,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setContextMenu,
        setDialogNodeId,
    });
    const replaceCanvasNodeMedia = useCallback((node: CanvasNodeData) => handleUploadRequest(node.id), [handleUploadRequest]);
    const {
        timelineAddNodeRef,
        timelineMediaAddRef,
        assetInsertScope,
        projectAssetScope,
        projectAssetOpen,
        projectAssetInitialCategory,
        projectAssetInitialFolderId,
        projectAssetInsertPosition,
        handleLibraryAssetsInsert,
        handleTimelineProjectAssetsInsert,
        openProjectAssets,
        openCanvasAssetLibrary,
        openTimelineAssetLibrary,
        closeProjectAssets,
    } = useCanvasTimelineAssetInsert({
        linkedProjectId,
        refetchLinkedProject,
        handleAssetsInsert,
        handleProjectAssetsInsert,
        openAssetsAtPosition,
    });

    useEffect(() => {
        if (!projectLoaded || searchParams.get("mode") !== "handoff") return;
        void loadAssetsForUse(canvasAssetHandoffIds(searchParams)).catch((error) => message.error(error instanceof Error ? error.message : "转入素材读取失败"));
    }, [projectLoaded, searchParams, message]);

    useEffect(() => {
        if (!projectLoaded || !assetsHydrated || searchParams.get("mode") !== "handoff") return;
        const attempt = canvasAssetHandoffAttempt(assets, searchParams);
        const { assetIds, payloads } = attempt;
        if (!assetIds.length) return;
        const assetReadiness = assetIds
            .map((assetId) => {
                const asset = assets.find((candidate) => candidate.id === assetId);
                return `${assetId}:${asset?.kind || "missing"}`;
            })
            .join("|");
        const handoffKey = `${projectId}:${assetReadiness}`;
        if (assetHandoffRef.current === handoffKey) return;
        assetHandoffRef.current = handoffKey;

        if (attempt.kind === "retry") return;
        const pendingPayloads = uninsertedCanvasAssetHandoffPayloads(nodesRef.current, payloads);
        const persistHandoff = async (createdNodes: CanvasNodeData[]) => {
            const finalized = await finalizeCanvasAssetHandoff({
                searchParams,
                currentNodes: nodesRef.current,
                createdNodes,
                persist: async (nextNodes) => {
                    nodesRef.current = nextNodes;
                    updateProject(projectId, { nodes: nextNodes });
                    await flushCanvasStorePersistence();
                },
            });
            setSearchParams(finalized.searchParams, { replace: true });
        };
        const insertion = pendingPayloads.length ? handleProjectAssetsInsert(pendingPayloads) : Promise.resolve([] as CanvasNodeData[]);
        void insertion.then(persistHandoff).catch(() => {
            assetHandoffRef.current = "";
        });
    }, [assets, assetsHydrated, handleProjectAssetsInsert, message, nodesRef, projectId, projectLoaded, searchParams, setSearchParams, updateProject]);

    const {
        angleNodeId,
        lightingNodeId,
        emotionNodeId,
        annotationNodeId,
        annotationEditNodeId,
        createImageReversePromptNodes,
        openPortraitTextureEditor,
        cropImageNode,
        cropNodeId,
        closeFrameDialog,
        closeSegmentDialog,
        extractAudioFromVideo,
        extractVideoFrames,
        extractingVideoFramesNodeId,
        frameDialogNodeId,
        generateNineGridNode,
        generateAngleNode,
        generateLightingNode,
        openPanoramaConfig,
        createPanoramaViewerWithConfig,
        addPanoramaCaptureNode,
        panoramaConfigNodeId,
        setPanoramaConfigNodeId,
        generateEmotionNode,
        handleSegmentConfirm,
        maskEditImageNode,
        maskEditNodeId,
        imageEditNodeId,
        imageEditPreset,
        layerDecompositionNodeId,
        textEditNodeId,
        mergeSelectedVideos,
        mergeVideosByIds,
        mergeVideoProgress,
        saveAnnotatedImageNode,
        segmentDialogMode,
        segmentDialogNodeId,
        segmentRunningMode,
        setFrameDialogNodeId,
        setSegmentDialogNodeId,
        setAngleNodeId,
        setLightingNodeId,
        setEmotionNodeId,
        setAnnotationNodeId,
        setAnnotationEditNodeId,
        setCropNodeId,
        setMaskEditNodeId,
        setImageEditNodeId,
        setImageEditPreset,
        openBackgroundRemoval,
        openLayerDecomposition,
        decomposeImageLayers,
        setLayerDecompositionNodeId,
        setTextEditNodeId,
        openTextEditNode,
        openAnnotationEditNode,
        detectImageText,
        editTextImageNode,
        editAnnotatedImageNode,
        editImageNode,
        setUpscaleNodeId,
        splitImageNode,
        openVideoFrameExtractor,
        openVideoSegmentExtractor,
        upscaleImageNode,
        upscaleNodeId,
    } = useCanvasMediaTools({
        projectId,
        domainProjectId: linkedProjectId,
        nodesRef,
        connectionsRef,
        selectedNodeIdsRef,
        setNodes,
        setConnections,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setDialogNodeId,
        setContextMenu,
        setHoveredNodeId,
        setToolbarNodeId,
        setRunningNodeId,
        startUploadStatus,
        startGenerationRequest,
        finishGenerationRequest,
        bindGenerationTask,
    });

    const handleNodesDeleted = useCallback(
        (removedIds: Set<string>, nextNodes: CanvasNodeData[], removedNodes: CanvasNodeData[]) => {
            const clearDeletedId = (current: string | null) => (current && removedIds.has(current) ? null : current);
            setHoveredNodeId(clearDeletedId);
            setToolbarNodeId(clearDeletedId);
            setDialogNodeId(clearDeletedId);
            setTextEditorNodeId(clearDeletedId);
            setCharacterReferenceNodeId(clearDeletedId);
            setDrawingNodeId(clearDeletedId);
            setInfoNodeId(clearDeletedId);
            setSubtitleNodeId(clearDeletedId);
            setFrameDialogNodeId(clearDeletedId);
            setSegmentDialogNodeId(clearDeletedId);
            setCropNodeId(clearDeletedId);
            setMaskEditNodeId(clearDeletedId);
            setAnnotationNodeId(clearDeletedId);
            setUpscaleNodeId(clearDeletedId);
            setAngleNodeId(clearDeletedId);
            setLightingNodeId(clearDeletedId);
            setEmotionNodeId(clearDeletedId);
            setSuperResolveNodeId(clearDeletedId);
            setPreviewNodeId(clearDeletedId);
            setRunningNodeId(clearDeletedId);
            setScriptEditorNodeId(clearDeletedId);
            setArtCritiqueNodeId(clearDeletedId);
            setDirectorNodeId(clearDeletedId);
            setVersionCompareRootId(clearDeletedId);
            setScriptScrollTopById((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !removedIds.has(id))));
            setContextMenu((current) => (current?.type === "node" && removedIds.has(current.nodeId) ? null : current));
            const removedDrawingIds = removedNodes.flatMap((node) => (node.type === CanvasNodeType.Drawing && node.metadata?.drawingId ? [node.metadata.drawingId] : []));
            if (removedDrawingIds.length) {
                void Promise.all(removedDrawingIds.map((drawingId) => removeCanvasDrawing(projectId, drawingId))).catch(() => message.warning("绘图节点已删除，但本地绘图缓存清理失败"));
            }
            cleanupCanvasFiles({ projectId, nodes: nextNodes, chatSessions });
            void (async () => {
                if (await saveCanvasProject({ requireRemote: true })) await reconcileCanvasNodeTasks(projectId, [...removedIds]);
                else await cancelRemovedCanvasNodeTasks(removedNodes, nextNodes);
            })().catch((error) => message.warning(`节点任务清理尚未完成，将在下次同步时重试：${error instanceof Error ? error.message : "请检查网络"}`));
        },
        [
            chatSessions,
            cleanupCanvasFiles,
            saveCanvasProject,
            message,
            projectId,
            setAngleNodeId,
            setAnnotationNodeId,
            setArtCritiqueNodeId,
            setCropNodeId,
            setEmotionNodeId,
            setFrameDialogNodeId,
            setLightingNodeId,
            setMaskEditNodeId,
            setSegmentDialogNodeId,
            setUpscaleNodeId,
            setRunningNodeId,
        ],
    );

    const {
        alignSelectedNodes,
        autoArrangeCanvasNodes,
        arrangeSelectedNodes,
        spreadSelectedNodes,
        copyNodesToClipboard,
        copySelectedNodes,
        createFolder,
        createNode,
        createReferenceGroup,
        createStoryboardGroup,
        deleteConnection,
        deleteNodes,
        duplicateNode,
        hasCopiedNodes,
        pasteCopiedNodes,
        restoreCopiedNodesFromText,
        releaseCopiedNodesPastePriority,
        setPrimaryVersion,
        shouldPreferCopiedNodes,
        toggleNodeLocked,
    } = useCanvasNodeOperations({
        projectId,
        defaultDrawingEngine,
        nodesRef,
        connectionsRef,
        selectedNodeIdsRef,
        getCanvasCenter,
        setNodes,
        setConnections,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setContextMenu,
        setDialogNodeId,
        onNodesDeleted: handleNodesDeleted,
    });

    const handleReplaceNodeReference = useCallback(
        (targetNodeId: string, oldReference: { id: string; nodeId?: string; label?: string; title?: string }, sourceNodeId: string) => {
            const sourceNode = nodesRef.current.find((n) => n.id === sourceNodeId);
            if (!sourceNode || sourceNode.id === oldReference.nodeId) return;

            const previousNodes = nodesRef.current;
            const previousConnections = connectionsRef.current;

            const configNodeId = previousConnections.find((c) => c.fromNodeId === targetNodeId && previousNodes.find((n) => n.id === c.toNodeId)?.type === CanvasNodeType.Config)?.toNodeId;
            const receiverId = configNodeId || targetNodeId;

            let rewired = false;
            const nextConnections = previousConnections.map((c) => {
                if (!rewired && c.fromNodeId === oldReference.nodeId && (c.toNodeId === targetNodeId || c.toNodeId === configNodeId)) {
                    rewired = true;
                    return { ...c, fromNodeId: sourceNodeId };
                }
                return c;
            });

            if (!rewired) {
                nextConnections.push({
                    id: nanoid(),
                    fromNodeId: sourceNodeId,
                    toNodeId: receiverId,
                });
            }

            const nextReferencesMap = buildCanvasNodeMentionReferenceMap(previousNodes, nextConnections, previousNodes);
            const targetNextReferences = nextReferencesMap.get(targetNodeId) || [];
            const newRef = targetNextReferences.find((r) => r.nodeId === sourceNodeId);

            const targetNode = previousNodes.find((n) => n.id === targetNodeId);
            let nextNodes = previousNodes;
            if (targetNode && newRef) {
                const currentPrompt = targetNode.metadata?.composerContent ?? targetNode.metadata?.prompt ?? "";
                const replacementToken = `@${newRef.label}`;
                const updatedPrompt = replaceCanvasReferenceMentions(currentPrompt, oldReference, replacementToken, sourceNode.title ? sourceNode.title : newRef.label);

                nextNodes = previousNodes.map((n) => (n.id === targetNodeId ? writeCanvasNodePrompt(n, updatedPrompt) : n));
            }

            nodesRef.current = nextNodes;
            connectionsRef.current = nextConnections;
            setNodes(nextNodes);
            setConnections(nextConnections);
            message.success(`已将参考图「${oldReference.label || "参考图"}」替换为「${sourceNode.title || "新图片"}」，提示词已同步更新`);
        },
        [connectionsRef, message, nodesRef, setConnections, setNodes],
    );

    const handleReplaceNodeReferenceFiles = useCallback(
        (_targetNodeId: string, oldReference: { id: string; nodeId?: string; label?: string; title?: string }, files: File[]) => {
            const file = files.find((f) => f.type.startsWith("image/"));
            if (!file || !oldReference.nodeId) return;
            void replaceNodeMedia(oldReference.nodeId, file).then((success: boolean) => {
                if (success) {
                    message.success("参考图片已替换");
                }
            });
        },
        [message, replaceNodeMedia],
    );

    const {
        cancelPendingConnectionCreate,
        closeConnectionCreateMenu,
        connectionTargetAnchorRatio,
        connectionTargetNodeId,
        connectionApproach,
        connectionReplaceHover,
        connectingParams,
        createConnectedNode,
        getConnectionCreateDisabledReason,
        handleConnectStart,
        handleConnectDrop,
        handleBatchConnectionTargetClick,
        batchConnectionPreview,
        beginBatchConnectionMode,
        startBatchConnection,
        mouseWorld,
        pendingConnectionCreate,
    } = useCanvasConnectionController({
        projectId,
        config: effectiveConfig,
        defaultDrawingEngine,
        nodesRef,
        connectionsRef,
        viewportRef,
        scriptScrollTopById,
        screenToCanvas,
        setNodes,
        setConnections,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setContextMenu,
        setDialogNodeId,
        setDrawingNodeId,
        onReplaceReference: handleReplaceNodeReference,
    });

    const batchSourceNodeIds = useMemo(() => nodes.filter((node) => selectedNodeIds.has(node.id) && !batchSourceRestriction(node)).map((node) => node.id), [nodes, selectedNodeIds]);

    const handleCanvasSelectionStart = useCallback(() => {
        setContextMenu(null);
    }, []);

    const handleNodeInteractionStart = useCallback((selectionModifier: boolean) => {
        setContextMenu(null);
        setHoveredNodeId(null);
        setToolbarNodeId(null);
        if (selectionModifier) setDialogNodeId(null);
    }, []);

    const handleSelectedNodeClick = useCallback(
        (node: CanvasNodeData) => {
            if (isShotProjectionActive(node.id) || node.metadata?.storyDevelopment || node.metadata?.shortDrama) { setDialogNodeId(null); return; }
            // Selection is transient, but the LibTV-style paint order survives
            // deselection so a clicked lower node stays above its neighbours.
            if (node.type !== CanvasNodeType.Frame) bringNodeToFront(node.id);
            if (node.type === CanvasNodeType.Drawing) {
                setDialogNodeId(null);
                setDrawingNodeId(node.id);
            } else if (node.type === CanvasNodeType.Script) {
                setDialogNodeId(null);
            } else if (node.type === CanvasNodeType.Text) {
                setDialogNodeId(node.id);
            } else if (node.type === CanvasNodeType.Frame) {
                setDialogNodeId((current) => (current === node.id ? current : null));
            } else if (node.type === ART_CRITIQUE_NODE_TYPE) {
                setDialogNodeId(null);
                setArtCritiqueNodeId(node.id);
            } else if (node.type === CanvasNodeType.Panorama) {
                // 全景节点是纯查看器，没有可编辑提示词，不弹提示词面板。
                setDialogNodeId(null);
            } else {
                // 选择参考媒体时保留当前工作流配置面板，避免点击图片后配置“返回/消失”。
                // 没有工作流配置面板时，媒体节点仍按原逻辑打开自己的面板。
                setDialogNodeId((current) => {
                    const currentNode = current ? nodesRef.current.find((item) => item.id === current) : undefined;
                    return currentNode?.type === CanvasNodeType.Config ? current : node.id;
                });
            }
        },
        [bringNodeToFront, nodesRef, isShotProjectionActive],
    );

    const handleNodeBringToFront = useCallback(
        (nodeId: string) => {
            const node = nodesRef.current.find((item) => item.id === nodeId);
            if (node && node.type !== CanvasNodeType.Frame) bringNodeToFront(nodeId);
        },
        [bringNodeToFront, nodesRef],
    );

    const handleNodeDragEnd = useCallback(
        (nodeId: string) => {
            if (isShotProjectionActive(nodeId)) { setDialogNodeId(null); return; }
            const node = nodesRef.current.find((item) => item.id === nodeId);
            if (!node || node.metadata?.storyDevelopment || node.metadata?.shortDrama || node.type === CanvasNodeType.Script || node.type === CanvasNodeType.Drawing || node.type === CanvasNodeType.Panorama || node.type === ART_CRITIQUE_NODE_TYPE) {
                setDialogNodeId(null);
                return;
            }
            // A drag selects a new node even though it is not a click. Keep the
            // generation editor bound to the node most recently moved so a stale
            // panel from the previous node cannot reappear after mouse-up.
            setDialogNodeId(node.id);
        },
        [nodesRef, isShotProjectionActive],
    );

    const handleCanvasDeselect = useCallback(() => {
        setContextMenu(null);
        setHoveredNodeId(null);
        setToolbarNodeId(null);
        setDialogNodeId(null);
    }, []);

    const { alignmentGuides, cancelSelectionBox, deselectCanvas, dragPreview, frameDropTargetId, handleCanvasMouseDown, handleNodeMouseDown, isNodeDragging, nodeDraggingRef, selectionBoundsElementRef, selectionBox } = useCanvasSelectionController({
        containerRef,
        nodesRef,
        viewportRef,
        selectedNodeIdsRef,
        historyPausedRef,
        screenToCanvas,
        setNodes,
        setSelectedNodeIds,
        setSelectedConnectionId,
        cancelPendingConnectionCreate,
        onCanvasSelectionStart: handleCanvasSelectionStart,
        onNodeInteractionStart: handleNodeInteractionStart,
        onNodeBringToFront: handleNodeBringToFront,
        onNodeClick: handleSelectedNodeClick,
        onNodeDragEnd: handleNodeDragEnd,
        onBatchConnectionTarget: handleBatchConnectionTargetClick,
        onLinkedFolderDrop: archiveNodesToLinkedFolder,
        onDeselect: handleCanvasDeselect,
    });

    const keepNodeToolbar = useCallback(
        (nodeId: string) => {
            if (nodeDraggingRef.current || nodeImageSettingsOpen) return;
            if (toolbarHideTimerRef.current) {
                clearTimeout(toolbarHideTimerRef.current);
                toolbarHideTimerRef.current = null;
            }
            setToolbarNodeId(nodeId);
        },
        [nodeImageSettingsOpen],
    );

    const hideNodeToolbar = useCallback(() => {
        if (toolbarHideTimerRef.current) clearTimeout(toolbarHideTimerRef.current);
        toolbarHideTimerRef.current = setTimeout(() => {
            setToolbarNodeId(null);
            toolbarHideTimerRef.current = null;
        }, 120);
    }, []);

    const {
        collapsingBatchIds,
        downloadNodeImage,
        handleConfigNodeChange,
        handleFolderStyleChange,
        handleFolderThemeChange,
        handleFontSizeChange,
        handleNodeContentChange,
        handleNodePromptChange,
        handleNodeResize,
        handleFrameResizeGesture,
        handleNodeTitleChange,
        openingBatchIds,
        saveNodeAsset,
        setBatchPrimary,
        toggleBatchExpanded,
        toggleFrameCollapsed,
        toggleNodeFreeResize,
    } = useCanvasNodeEditor({
        canvasId: projectId,
        canvasTitle: currentProject?.title || "未命名画布",
        domainProjectId: linkedProjectId,
        nodesRef,
        historyPausedRef,
        setNodes,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setDialogNodeId,
        setToolbarNodeId,
        setHoveredNodeId,
    });

    const handleRemoveNodeReference = useCallback(
        (targetNodeId: string, reference: CanvasResourceReference) => {
            const referenceNodeId = reference.nodeId;
            if (!referenceNodeId) return;
            // 生成节点可能通过配置节点接收参考，只移除参考来源边，保留目标到配置节点的主链。
            const previousNodes = nodesRef.current;
            const previousConnections = connectionsRef.current;
            const configNodeId = previousConnections.find((connection) => {
                if (connection.fromNodeId !== targetNodeId) return false;
                return previousNodes.find((node) => node.id === connection.toNodeId)?.type === CanvasNodeType.Config;
            })?.toNodeId;
            const removedConnectionIds = new Set(previousConnections.filter((connection) => connection.fromNodeId === referenceNodeId && (connection.toNodeId === targetNodeId || connection.toNodeId === configNodeId)).map((connection) => connection.id));
            if (!removedConnectionIds.size) return;
            const nextConnections = previousConnections.filter((connection) => !removedConnectionIds.has(connection.id));
            const nextNodes = applyCanvasConnectionPromptSync(previousNodes, previousConnections, previousNodes, nextConnections);
            if (nextNodes !== previousNodes) {
                nodesRef.current = nextNodes;
                setNodes(nextNodes);
            }
            connectionsRef.current = nextConnections;
            setConnections(nextConnections);
            setSelectedConnectionId((current) => (current && removedConnectionIds.has(current) ? null : current));
        },
        [connectionsRef, nodesRef, setConnections, setNodes, setSelectedConnectionId],
    );

    const handleReorderNodeReferences = useCallback(
        (targetNodeId: string, orderedNodeIds: string[]) => {
            const previousNodes = nodesRef.current;
            const previousConnections = connectionsRef.current;
            const nextConnections = reorderCanvasResourceConnections(targetNodeId, orderedNodeIds, previousNodes, previousConnections);
            if (nextConnections === previousConnections) return;
            const nextNodes = applyCanvasConnectionPromptSync(previousNodes, previousConnections, previousNodes, nextConnections);
            if (nextNodes !== previousNodes) {
                nodesRef.current = nextNodes;
                setNodes(nextNodes);
            }
            connectionsRef.current = nextConnections;
            setConnections(nextConnections);
        },
        [connectionsRef, nodesRef, setConnections, setNodes],
    );

    const handleProjectFolderInsert = useCallback(
        (folderId: string) => {
            const folder = linkedProjectQuery.data?.assetFolders.find((item) => item.id === folderId);
            if (!folder || !linkedProjectId) throw new Error("素材文件夹已不存在，请刷新后重试");
            const style: CanvasFolderStyle = folder.style === "stacked" || folder.style === "midnight" || folder.style === "paper" || folder.style === "cinema" || folder.style === "compact" ? folder.style : "glass";
            const theme: CanvasFolderTheme = folder.theme === "obsidian" || folder.theme === "ember" || folder.theme === "pearl" ? folder.theme : "aurora";
            createFolder(projectAssetInsertPosition, { id: folder.id, projectId: linkedProjectId, title: folder.name, style, theme, createdAt: folder.createdAt });
        },
        [createFolder, linkedProjectId, linkedProjectQuery.data?.assetFolders, projectAssetInsertPosition],
    );

    const handleFrameToggle = useCallback(
        (nodeId: string) => {
            const node = nodesRef.current.find((item) => item.id === nodeId);
            const linkedFolderId = node?.metadata?.folder?.assetFolderId;
            if (linkedFolderId) {
                openProjectAssets("all", node ? { x: node.position.x + node.width + 40, y: node.position.y } : undefined, "canvas", linkedFolderId);
                return;
            }
            toggleFrameCollapsed(nodeId);
        },
        [nodesRef, openProjectAssets, toggleFrameCollapsed],
    );

    const linkedFolderPreviewNodesById = useMemo(() => {
        const result = new Map<string, CanvasNodeData[]>();
        const localById = new Map(assets.map((asset) => [asset.id, asset]));
        for (const asset of linkedProjectQuery.data?.assets || []) {
            if (!asset.folderId) continue;
            const local = localById.get(asset.id);
            const characterCover = asset.character?.representations.find((item) => item.role === "turnaround_sheet") || asset.character?.representations.find((item) => item.role === "primary") || asset.character?.representations[0];
            const type = asset.category === "character" || asset.mediaType === "image" ? CanvasNodeType.Image : asset.mediaType === "video" ? CanvasNodeType.Video : asset.mediaType === "audio" ? CanvasNodeType.Audio : CanvasNodeType.Text;
            const remoteResourceId = resourceIdFromStorageKey(asset.storageKey);
            const storageKey = characterCover
                ? `resource:${characterCover.resourceId}`
                : local?.kind === "image" || local?.kind === "video" || local?.kind === "audio"
                  ? local.data.storageKey
                  : remoteResourceId
                    ? asset.storageKey
                    : undefined;
            const content = characterCover
                ? resourceFileUrl(characterCover.resourceId)
                : local?.kind === "image"
                  ? local.data.dataUrl || local.coverUrl
                  : local?.kind === "video" || local?.kind === "audio"
                    ? local.data.url
                    : local?.kind === "text"
                      ? local.data.content
                      : remoteResourceId
                        ? resourceFileUrl(remoteResourceId)
                        : asset.previewText || "";
            const preview: CanvasNodeData = { id: asset.id, type, title: asset.title, position: { x: 0, y: 0 }, width: 240, height: 160, metadata: { assetId: asset.id, content, storageKey } };
            const current = result.get(asset.folderId) || [];
            current.push(preview);
            result.set(asset.folderId, current);
        }
        return result;
    }, [assets, linkedProjectQuery.data?.assets]);

    useEffect(() => {
        const folders = linkedProjectQuery.data?.assetFolders;
        if (!folders?.length) return;
        const byId = new Map(folders.map((folder) => [folder.id, folder]));
        setNodes((current) => {
            let changed = false;
            const next = current.map((node) => {
                const folderId = node.metadata?.folder?.assetFolderId;
                const folder = folderId ? byId.get(folderId) : undefined;
                if (!folder) return node;
                const style: CanvasFolderStyle = folder.style === "stacked" || folder.style === "midnight" || folder.style === "paper" || folder.style === "cinema" || folder.style === "compact" ? folder.style : "glass";
                const theme: CanvasFolderTheme = folder.theme === "obsidian" || folder.theme === "ember" || folder.theme === "pearl" ? folder.theme : "aurora";
                if (node.title === folder.name && node.metadata?.folder?.style === style && node.metadata?.folder?.theme === theme) return node;
                changed = true;
                return { ...node, title: folder.name, metadata: { ...node.metadata, folder: { ...node.metadata!.folder!, style, theme, themeCover: undefined } } };
            });
            return changed ? next : current;
        });
    }, [linkedProjectQuery.data?.assetFolders, setNodes]);

    const {
        activeDirectorScene,
        activeNodeId,
        activeScriptNode,
        activeStylePresetId,
        angleNode,
        lightingNode,
        emotionNode,
        annotationNode,
        batchChildCountById,
        batchMotionById,
        configInputsById,
        connectionLayerBounds,
        contextMenuNode,
        cropNode,
        displayConnections,
        frameChildrenById,
        infoNode: rawInfoNode,
        maskEditNode,
        imageEditNode,
        mentionReferencesByNodeId,
        nodeById,
        nodeRenderLODById,
        previewNode,
        reduceMediaEffects,
        relatedHighlight,
        resourceReferenceByNodeId,
        selectedNodeBounds,
        selectedVideoNodes,
        skillMentionReferences,
        superResolveNode,
        toolbarNode,
        upscaleNode,
        versionCompareNodes,
        visibleNodes,
        viewportNodeIds,
        upstreamNodesById,
    } = useCanvasRenderModel({
        nodes,
        connections,
        assets,
        viewport,
        viewportSize: size,
        mediaPerformanceMode,
        selectedNodeIds,
        editingNodeId,
        hoveredNodeId,
        dragPreview,
        collapsingBatchIds,
        addedSkills,
        directorScenes: currentProject?.directorScenes,
        infoNodeId,
        cropNodeId,
        maskEditNodeId,
        imageEditNodeId,
        annotationNodeId,
        splitNodeId: null,
        upscaleNodeId,
        superResolveNodeId,
        angleNodeId,
        lightingNodeId,
        emotionNodeId,
        previewNodeId,
        contextMenu,
        versionCompareRootId,
        directorNodeId,
        scriptEditorNodeId,
        dialogNodeId,
    });

    const visibleDisplayConnections = displayConnections;
    useEffect(() => {
        setNodes((current) => {
            let changed = false;
            const next = current.map((node) => {
                const references = mentionReferencesByNodeId.get(node.id);
                const savedPrompt = node.metadata?.composerContent ?? node.metadata?.prompt;
                if (!references?.length || !savedPrompt?.includes("@[node:")) return node;
                const normalizedPrompt = normalizeCanvasNodeMentionTokens(savedPrompt, references);
                if (normalizedPrompt === savedPrompt) return node;
                changed = true;
                return {
                    ...node,
                    metadata: node.metadata?.composerContent !== undefined ? { ...node.metadata, composerContent: normalizedPrompt } : { ...node.metadata, prompt: normalizedPrompt },
                };
            });
            return changed ? next : current;
        });
    }, [mentionReferencesByNodeId, setNodes]);
    const dialogNode = dialogNodeId ? nodeById.get(dialogNodeId) || null : null;
    // dragPreview is published on the same pointer-down frame as isNodeDragging.
    // Treat either signal as moving so floating editors disappear before the
    // first preview transform is painted and never affect drag layout.
    const isCanvasNodeMoving = isNodeDragging || Boolean(dragPreview?.nodeIds.size);
    const subtitleNode = subtitleNodeId ? nodeById.get(subtitleNodeId) || null : null;
    const timelineNode = timelineNodeId ? nodeById.get(timelineNodeId) || null : null;
    const frameNode = frameDialogNodeId ? nodeById.get(frameDialogNodeId) || null : null;
    const segmentNode = segmentDialogNodeId ? nodeById.get(segmentDialogNodeId) || null : null;
    const textEditorNode = textEditorNodeId ? nodeById.get(textEditorNodeId) || null : null;
    const characterReferenceNode = characterReferenceNodeId ? nodeById.get(characterReferenceNodeId) || null : null;
    const drawingNode = drawingNodeId ? nodeById.get(drawingNodeId) || null : null;
    const artCritiqueNode = artCritiqueNodeId ? nodeById.get(artCritiqueNodeId) || null : null;
    const artCritiqueInputs = artCritiqueNode
        ? connections
              .filter((connection) => connection.toNodeId === artCritiqueNode.id)
              .sort((left, right) => left.id.localeCompare(right.id))
              .map((connection) => nodeById.get(connection.fromNodeId))
              .filter((node): node is CanvasNodeData => Boolean(node))
        : [];
    const pendingConnectionSourceNode = pendingConnectionCreate?.connection.handleType === "source" ? nodeById.get(pendingConnectionCreate.connection.nodeId) : null;
    const canCreateDrawingFromConnection = !pendingConnectionCreate?.batchSourceNodeIds?.length && pendingConnectionSourceNode?.type === CanvasNodeType.Image && Boolean(pendingConnectionSourceNode.metadata?.content);

    const openTextNodeEditor = useCallback((node: CanvasNodeData) => {
        const data = nodeWorkflow(node);
        const editTarget = data?.step === ShortDramaStep.Audit && data.screenplayAudit?.bodyNodeId
            ? nodesRef.current.find((candidate) => candidate.id === data.screenplayAudit?.bodyNodeId) || node
            : node;
        if (editTarget.type !== CanvasNodeType.Text && editTarget.type !== CanvasNodeType.Markdown) return;
        textEditorOriginalRef.current = editTarget;
        setSelectedNodeIds(new Set([editTarget.id]));
        setSelectedConnectionId(null);
        setContextMenu(null);
        setDialogNodeId(null);
        setToolbarNodeId(null);
        if (editTarget.metadata?.workflowKind === "character" && editTarget.metadata.characterAssetId) {
            setCharacterReferenceNodeId(editTarget.id);
            return;
        }
        setTextEditorNodeId(editTarget.id);
    }, [nodesRef]);

    const openDrawingNode = useCallback((node: CanvasNodeData) => {
        if (node.type !== CanvasNodeType.Drawing) return;
        setSelectedNodeIds(new Set([node.id]));
        setSelectedConnectionId(null);
        setContextMenu(null);
        setDialogNodeId(null);
        setToolbarNodeId(null);
        setDrawingNodeId(node.id);
    }, []);

    const openArtCritique = useCallback((node: CanvasNodeData) => {
        if (node.type !== ART_CRITIQUE_NODE_TYPE) return;
        setSelectedNodeIds(new Set([node.id]));
        setSelectedConnectionId(null);
        setContextMenu(null);
        setDialogNodeId(null);
        setToolbarNodeId(null);
        setArtCritiqueNodeId(node.id);
    }, []);
    const duplicateNodeFromContent = useCallback((node: CanvasNodeData) => duplicateNode(node.id), [duplicateNode]);
    const deleteNodeFromContent = useCallback((node: CanvasNodeData) => deleteNodes(new Set([node.id])), [deleteNodes]);
    const { updateNode: updateNodeFromContent, updateMediaNode: updateMediaNodeFromContent } = useCanvasNodeContentUpdates(projectId, nodesRef, setNodesState);
    const updateNodeMetadataFromContent = useCallback(
        (nodeId: string, patch: CanvasNodeMetadata) => {
            updateNodeFromContent(nodeId, (node) => ({ ...node, metadata: { ...node.metadata, ...patch } }));
        },
        [updateNodeFromContent],
    );
    const canvasNodeActions = useMemo<CanvasNodeActionContextValue>(
        () => ({
            upload: replaceCanvasNodeMedia,
            download: downloadNodeImage,
            duplicate: duplicateNodeFromContent,
            deleteNode: deleteNodeFromContent,
            openAssetReview: node => setAssetReviewId(node.id),
            generateAssetSound: node => {
                const data = nodeWorkflow(node);
                if (data) setWorkflowGenerator({ step: ShortDramaStep.VoiceSamples, pipelineId: data.pipelineId, anchorId: node.id });
            },
            updateMetadata: updateNodeMetadataFromContent,
            updateNode: updateNodeFromContent,
            updateMediaNode: updateMediaNodeFromContent,
            openArtCritique,
            addPanoramaCaptureNode,
        }),
        [addPanoramaCaptureNode, deleteNodeFromContent, downloadNodeImage, duplicateNodeFromContent, openArtCritique, replaceCanvasNodeMedia, updateMediaNodeFromContent, updateNodeFromContent, updateNodeMetadataFromContent],
    );
    const { dismissLastAgentChange, lastAgentChange, undoAgentOps, viewLastAgentChange } = useCanvasOperationHistory({
        projectId,
        domainProjectId: currentProject?.projectId,
        projectTitle: currentProject?.title || "未命名画布",
        nodes,
        connections,
        selectedNodeIds,
        viewport,
        nodesRef,
        connectionsRef,
        selectedNodeIdsRef,
        viewportRef,
        generateNodeRef,
        setNodes,
        setConnections,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setViewport,
        setContextMenu,
        focusSelection: fitCanvasSelection,
    });

    const { selectCanvasStyle, styleApplying } = useCanvasStyleWorkflow({
        canvasId: projectId,
        domainProjectId: currentProject?.projectId,
        nodesRef,
        selectedNodeIdsRef,
        getCanvasCenter,
        setNodes,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setDialogNodeId,
        setStylePickerOpen,
    });

    const { applyDirectorOutput, createDirectorShot, openDirectorWorkbench, saveDirectorScene } = useCanvasDirector({
        projectId,
        domainProjectId: currentProject?.projectId,
        directorNodeId,
        directorScenes: currentProject?.directorScenes || [],
        nodesRef,
        connectionsRef,
        getCanvasCenter,
        setNodes,
        setConnections,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setDirectorNodeId,
        updateProject,
    });

    const openWorkflowGenerator = useCallback((step: ShortDramaStepId, anchorId?: string, stepIds?: ShortDramaStepId[]) => {
        if (step === ShortDramaStep.Reconcile) { step = ShortDramaStep.Audit; stepIds = undefined; }
        if (isStoryboardFrameStep(step)) { message.info("首帧、尾帧和关键帧请在分镜列表中生成"); return; }
        const anchor = nodesRef.current.find((node) => node.id === anchorId);
        const pipelineId = nodeWorkflow(anchor)?.pipelineId || nodesRef.current.map(nodeWorkflow).find(Boolean)?.pipelineId;
        if (!pipelineId) { message.info("请先创建短剧流程并采用选题"); return; }
        setTextEditorNodeId(null); setContextMenu(null); setDialogNodeId(null);
        setWorkflowGenerator({ step, pipelineId, anchorId, stepIds });
    }, [message, nodesRef]);

    const workflowGeneration = useShortDramaWorkflowGeneration({ projectId, config: effectiveConfig, nodesRef, connectionsRef, setNodes, setConnections,
        save: (options) => saveCanvasProject({ requireRemote: true, quiet: options?.quiet }), center: getCanvasCenter, focus: focusCanvasNode, bindTask: bindGenerationTask, applyResult: applyGenerationTaskResult });
    const runSingleScreenplayAudit = useCallback(async (body: CanvasNodeData) => {
        const data = nodeWorkflow(body);
        if (!data?.episodeNumber || data.step !== ShortDramaStep.Body) { message.warning("请选择已完成的分集正文"); return; }
        const model = effectiveConfig.textModel || "";
        const currentSettings = useCanvasStore.getState().openProject(projectId)?.globalSettings;
        const resetReviewState = {
            ...data,
            submission: undefined,
            materializedTaskId: undefined,
            screenplayAudit: undefined,
            screenplayRepair: undefined,
        };
        // Re-audit is a new review attempt. Clear the old repair task and report
        // before saving so submit/recovery cannot validate against stale state.
        setNodes(current => current.map(node => node.id !== body.id ? node : {
            ...node,
            metadata: {
                ...resetGenerationTaskMetadata(node.metadata, "success"),
                taskStage: "准备重新审核",
                shortDrama: resetReviewState,
            },
        }));
        if (!await saveCanvasProject({ requireRemote: true })) {
            message.error("正文状态清理后未能保存到云端，尚未重新审核，请稍后重试");
            return;
        }
        try {
            await workflowGeneration.run({
                step: ShortDramaStep.Audit,
                pipelineId: data.pipelineId,
                sourceNodeIds: [body.id],
                anchorId: body.id,
                model,
                instruction: "",
                episodeCount: data.parameters?.episodeCount || currentProject?.globalSettings?.episodeCount || 1,
                minutesPerEpisode: data.parameters?.minutesPerEpisode || "1-2",
                reasoningEffort: effectiveConfig.textReasoningEffort || "medium",
                start: data.episodeNumber,
                count: 1,
                globalSettings: currentSettings,
            });
        } catch (error) {
            message.error(error instanceof Error ? error.message : "一键诊断提交失败");
        }
    }, [effectiveConfig, message, projectId, saveCanvasProject, setNodes, workflowGeneration]);
    const openScreenplayRepair = useCallback((nodeId: string) => {
        const report = nodesRef.current.find(node => node.id === nodeId);
        const data = report ? nodeWorkflow(report) : undefined;
        const body = data?.screenplayAudit?.bodyNodeId === report?.id ? report : nodesRef.current.find(node => node.id === data?.screenplayAudit?.bodyNodeId);
        const state = screenplayAuditState(report, nodesRef.current, useCanvasStore.getState().openProject(projectId)?.globalSettings);
        if (!report || !body || !state.report || !state.report.findings.length) { message.warning("当前没有可修复的诊断问题，请先审核正文"); return; }
        if (state.stale) {
            setScreenplayAuditDetailId(report.id);
            message.info("旧诊断已失效，请在详情中重新审核当前正文");
            return;
        }
        setScreenplayAuditDetailId(null); setTextEditorNodeId(null); setContextMenu(null);
        setWorkflowGenerator({ step: ShortDramaStep.Body, pipelineId: nodeWorkflow(body)!.pipelineId, anchorId: body.id, auditRepairReportId: report.id });
    }, [message, nodesRef, projectId]);
    const restoreScreenplayBeforeRepair = useCallback(async (bodyId: string) => {
        const body = nodesRef.current.find(node => node.id === bodyId);
        const repair = body?.metadata?.shortDrama?.screenplayRepair;
        if (!body || !repair || repair.previousContent === undefined) { message.warning("没有可恢复的修复前版本"); return; }
        setNodes(current => current.map(node => node.id !== bodyId ? node : { ...node, metadata: { ...node.metadata, content: repair.previousContent, richText: repair.previousRichText as Record<string, unknown> | undefined, status: "success", taskStage: "已恢复修复前版本，待重新诊断", errorDetails: undefined, shortDrama: { ...node.metadata!.shortDrama!, screenplayRepair: undefined, screenplayAudit: node.metadata!.shortDrama?.screenplayAudit ? { ...node.metadata!.shortDrama.screenplayAudit, report: undefined, reportSignature: undefined, rawResult: undefined, reportMarkdown: undefined, bodySignature: undefined } : undefined } } }));
        setScreenplayAuditDetailId(null);
        if (await saveCanvasProject({ requireRemote: true })) message.success("已恢复修复前版本，请重新诊断正文");
        else message.warning("已在本地恢复，云端保存待重试");
    }, [message, nodesRef, saveCanvasProject]);
    const productionAgentRuns = useProductionAgentRuns(projectId, nodesRef, workflowGeneration.submissionLock, {
        config: effectiveConfig,
        setNodes,
        save: () => saveCanvasProject({ requireRemote: true }),
    });
    useLegacyStoryRecovery({ canvasId: projectId, loaded: projectLoaded, nodesRef, setNodes, save: () => saveCanvasProject({ requireRemote: true }) });

    const {
        activateTask: activateShortDramaTask,
        createPipeline: createShortDramaPipeline,
        guideCollapsed: shortDramaGuideCollapsed,
        openStoryInput,
        progress: shortDramaProgress,
        setGuideCollapsed: setShortDramaGuideCollapsed,
        skipGuide: skipShortDramaGuide,
    } = useCanvasShortDrama({
        globalSettings: currentProject?.globalSettings,
        nodes,
        connections,
        nodesRef,
        connectionsRef,
        selectedNodeIdsRef,
        getCanvasCenter,
        setNodes,
        setConnections,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setStylePickerOpen,
        fitCanvasSelection,
        focusCanvasNode,
        openTextEditor: openTextNodeEditor,
        openGeneration: openWorkflowGenerator,
        openAssets: () => openCanvasAssetLibrary(),
        openAudio: (nodeId) => nodeId ? setPreviewNodeId(nodeId) : openCanvasAssetLibrary(),
        openStoryboard: (nodeId) => {
            if (nodesRef.current.find((node) => node.id === nodeId)?.type === CanvasNodeType.Script) setScriptEditorNodeId(nodeId);
            else focusCanvasNode(nodeId);
        },
        openTimeline: setTimelineNodeId,
        openPreview: setPreviewNodeId,
    });

    const shortDramaGuide = shortDramaEnabled && !currentProject?.projectId && shortDramaProgress.active ? { progress: shortDramaProgress, collapsed: shortDramaGuideCollapsed, onToggle: () => setShortDramaGuideCollapsed((value) => !value) } : undefined;

    const clearCanvas = useCallback(() => {
        const drawingIds = nodesRef.current.flatMap((node) => (node.type === CanvasNodeType.Drawing && node.metadata?.drawingId ? [node.metadata.drawingId] : []));
        if (drawingIds.length) {
            void Promise.all(drawingIds.map((drawingId) => removeCanvasDrawing(projectId, drawingId))).catch(() => message.warning("画布已清空，但部分本地绘图缓存清理失败"));
        }
        setNodes([]);
        setConnections([]);
        setTextEditorNodeId(null);
        setDrawingNodeId(null);
        setInfoNodeId(null);
        setSubtitleNodeId(null);
        setCropNodeId(null);
        setMaskEditNodeId(null);
        setAnnotationNodeId(null);
        setAngleNodeId(null);
        setLightingNodeId(null);
        setEmotionNodeId(null);
        setPreviewNodeId(null);
        setRunningNodeId(null);
        setArtCritiqueNodeId(null);
        deselectCanvas();
        setClearConfirmOpen(false);
        clearCanvasFiles();
    }, [clearCanvasFiles, deselectCanvas, message, nodesRef, projectId, setEmotionNodeId]);

    useCanvasKeyboard({
        enabled: projectLoaded && !versions.preview,
        nodesRef,
        selectedNodeIdsRef,
        selectedConnectionId,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setContextMenu,
        setShortcutRequestNonce,
        setInfoNodeId,
        setCropNodeId,
        setMaskEditNodeId,
        setAnnotationNodeId,
        saveCanvasProject,
        zoomToActualSize,
        fitCanvasContent,
        fitCanvasSelection,
        undoCanvas,
        redoCanvas,
        cancelSelectionBox,
        copySelectedNodes,
        pasteCopiedNodes,
        restoreCopiedNodesFromText,
        shouldPreferCopiedNodes,
        pasteSystemClipboard,
        deleteNodes,
        deleteConnection,
        deselectCanvas,
        zoomCanvasIn,
        zoomCanvasOut,
        focusMode,
        exitFocusMode,
        toggleFocusMode,
        onOpenSearch: () => setNodeSearchOpen(true),
        beginBatchConnection: () => beginBatchConnectionMode(Array.from(selectedNodeIdsRef.current)),
    });


    const startTitleEditing = useCallback(() => {
        setTitleDraft(currentProject?.title || "未命名画布");
        setTitleEditing(true);
    }, [currentProject?.title]);

    const finishTitleEditing = useCallback(() => {
        const nextTitle = titleDraft.trim();
        if (nextTitle) renameCurrentProject(nextTitle);
        setTitleEditing(false);
    }, [renameCurrentProject, titleDraft]);

    const pasteAtPosition = useCallback(
        (position: Position) => {
            if (shouldPreferCopiedNodes() && pasteCopiedNodes(position)) return;
            void (async () => {
                try {
                    // 标记写入成功时仍优先系统图片，兼容截图和从外部应用复制的媒体。
                    const handled = await pasteSystemClipboard(position);
                    if (!handled) pasteCopiedNodes(position);
                } catch {
                    if (!pasteCopiedNodes(position)) message.warning("无法读取剪贴板内容");
                }
            })();
        },
        [message, pasteCopiedNodes, pasteSystemClipboard, shouldPreferCopiedNodes],
    );

    const copyingNodeContentRef = useRef(false);
    const copyNodeContentToClipboard = useCallback(
        async (node: CanvasNodeData | null) => {
            if (copyingNodeContentRef.current) return;
            copyingNodeContentRef.current = true;
            releaseCopiedNodesPastePriority();
            if (!node) {
                copyingNodeContentRef.current = false;
                message.warning("没有可复制的内容");
                return;
            }

            try {
                const content = node.metadata?.content?.trim();
                const resourceId = resourceIdFromStorageKey(node.metadata?.storageKey);
                // Resource-backed media must use the central access contract. This keeps
                // copy operations on the configured CDN/OSS URL instead of copying the
                // platform file endpoint or a stale URL persisted in canvas metadata.
                const copySource = resourceId
                    ? resolveResourceAccessURL((await getResourceAccess(`resource:${resourceId}`, "copy")).url)
                    : content || "";
                if (!copySource) throw new Error("没有可复制的内容");
                if (node.type === CanvasNodeType.Image) {
                    try {
                        await copyImageToSystemClipboard(copySource, node.metadata?.storageKey);
                        message.success("图片已复制到剪贴板");
                        return;
                    } catch (imageErr) {
                        const fallbackUrl = new URL(copySource, window.location.href).toString();
                        if (navigator.clipboard?.writeText) {
                            await navigator.clipboard.writeText(fallbackUrl).catch(() => undefined);
                            message.info("由于浏览器未获得焦点，已为您复制图片地址");
                            return;
                        }
                        if (await copyToClipboard(fallbackUrl)) {
                            message.info("由于浏览器未获得焦点，已为您复制图片地址");
                            return;
                        }
                        throw imageErr;
                    }
                }

                if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(copySource);
                else if (!copyToClipboard(copySource)) throw new Error("当前浏览器不支持写入剪贴板");
                message.success(node.type === CanvasNodeType.Text ? "文本已复制" : "内容链接已复制");
            } catch (error) {
                message.error(error instanceof Error ? error.message : "复制失败，请检查浏览器剪贴板权限");
            } finally {
                copyingNodeContentRef.current = false;
            }
        },
        [message, releaseCopiedNodesPastePriority],
    );

    const copyNodeMediaUrlToClipboard = useCallback(
        async (node: CanvasNodeData | null) => {
            releaseCopiedNodesPastePriority();
            try {
                const storageKey = node?.metadata?.storageKey;
                const content = node?.metadata?.content?.trim();
                const resourceId = resourceIdFromStorageKey(storageKey);
                const mediaPath = content && !content.startsWith("data:") && !content.startsWith("blob:") ? content : "";
                const mediaURL = resourceId
                    ? resolveResourceAccessURL((await getResourceAccess(`resource:${resourceId}`, "copy")).url)
                    : mediaPath ? new URL(mediaPath, window.location.href).toString() : "";
                if (!mediaURL) throw new Error("当前媒体只有本地内容，没有可复制的地址");
                if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(mediaURL);
                else if (!(await copyToClipboard(mediaURL))) throw new Error("当前浏览器不支持写入剪贴板");
                message.success(node?.type === CanvasNodeType.Video ? "视频地址已复制" : "图片地址已复制");
            } catch (error) {
                message.error(error instanceof Error ? error.message : "媒体地址复制失败");
            }
        },
        [message, releaseCopiedNodesPastePriority],
    );

    const uploadNodeImageToArkPrivateAsset = useCallback(
        async (node: CanvasNodeData) => {
            if (node.type !== CanvasNodeType.Image || !node.metadata?.content) {
                message.warning("请选择一张可用图片后再上传");
                return;
            }
            if (arkPrivateAssetUploadNodeId === node.id) return;
            const feedbackKey = `ark-private-asset-${node.id}`;
            setArkPrivateAssetUploadNodeId(node.id);
            message.loading({ key: feedbackKey, content: "正在保存并上传到方舟素材库...", duration: 0 });
            try {
                let resourceID = resourceIdFromStorageKey(node.metadata.storageKey);
                let persistedNode = node;
                if (!resourceID) {
                    const uploaded = await uploadImage(node.metadata.content);
                    resourceID = resourceIdFromStorageKey(uploaded.storageKey);
                    if (!resourceID) throw new Error("图片未能保存到系统素材库，请检查对象存储配置后重试");
                    handleConfigNodeChange(node.id, imageMetadata(uploaded));
                    persistedNode = { ...node, metadata: { ...node.metadata, ...imageMetadata(uploaded) } };
                }
                const asset = await ensureCanvasNodeAsset({ canvasId: projectId, domainProjectId: currentProject?.projectId, node: persistedNode, source: "canvas-manual" });
                handleConfigNodeChange(node.id, { assetId: asset.assetId });
                await syncResourceToArkPrivateAsset(resourceID);
                message.success({ key: feedbackKey, content: "已同步到方舟素材库，Seedance 将自动复用该素材", duration: 4 });
            } catch (error) {
                message.error({ key: feedbackKey, content: error instanceof Error ? error.message : "上传到方舟素材库失败", duration: 5 });
            } finally {
                setArkPrivateAssetUploadNodeId((current) => (current === node.id ? null : current));
            }
        },
        [arkPrivateAssetUploadNodeId, currentProject?.projectId, handleConfigNodeChange, message, projectId],
    );

    const confirmUploadNodeImageToArkPrivateAsset = useCallback(
        (node: CanvasNodeData) => {
            modal.confirm({
                title: "上传到方舟素材库",
                content: "仅可上传你拥有肖像、版权或其他合法使用权的图片。方舟审核通过后，Seedance 会使用受控素材标识生成视频。",
                okText: "确认拥有使用权并上传",
                cancelText: "取消",
                onOk: () => uploadNodeImageToArkPrivateAsset(node),
            });
        },
        [modal, uploadNodeImageToArkPrivateAsset],
    );

    const handleCanvasContextMenu = useCallback(
        (event: ReactMouseEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest("[data-node-id],[data-connection-id]")) return;

            event.preventDefault();
            event.stopPropagation();
            if (target?.closest("[data-canvas-no-zoom],.ant-modal,.ant-popover,.ant-dropdown")) {
                setContextMenu(null);
                return;
            }

            closeConnectionCreateMenu();
            setContextMenu({ type: "canvas", x: event.clientX, y: event.clientY, position: screenToCanvas(event.clientX, event.clientY) });
        },
        [closeConnectionCreateMenu, screenToCanvas],
    );

    const handleNodeContextMenu = useCallback(
        (event: ReactMouseEvent, id: string) => {
            event.preventDefault();
            event.stopPropagation();
            setSelectedNodeIds((current) => {
                if (current.has(id) && current.size > 1) return current;
                return new Set([id]);
            });
            setSelectedConnectionId(null);
            closeConnectionCreateMenu();
            setToolbarNodeId(null);
            setDialogNodeId(null);
            setContextMenu({ type: "node", x: event.clientX, y: event.clientY, nodeId: id });
        },
        [closeConnectionCreateMenu],
    );

    const handleGenerateNode = useCanvasGenerationExecutor({
        projectId,
        domainProjectId: currentProject?.projectId,
        addedSkills,
        assets,
        nodesRef,
        connectionsRef,
        setNodes,
        setConnections,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setDialogNodeId,
        setRunningNodeId,
        startGenerationRequest,
        finishGenerationRequest,
        bindGenerationTask,
        applyGenerationTaskResult,
    });
    useEffect(() => {
        generateNodeRef.current = handleGenerateNode;
    }, [handleGenerateNode]);

    const persistGenerationBatches = useCallback(async () => {
        await persistLocalEdits();
        await saveRemoteUserDataNow(projectId);
    }, [persistLocalEdits, projectId]);
    const { enqueueGenerationBatch, retryFailedBatchItems, stopRemainingBatchItems, pauseGenerationBatches } = useCanvasGenerationBatches({
        projectId,
        projectLoaded,
        nodes,
        nodesRef,
        setNodes,
        handleGenerateNode,
        persistBatches: persistGenerationBatches,
    });

    const {
        addReferenceColumn: addBatchReferenceColumn,
        addRow: addBatchRow,
        batchGenDialogConfig,
        batchGenDialogOpen,
        batchGenDialogRowCount,
        closeBatchGenDialog,
        confirmBatchGenDialog,
        fillRowsFromConnections,
        generateRows: generateBatchRows,
        moveReferenceCell: moveBatchReferenceCell,
        patchTable: patchBatchTable,
        removeReferenceColumn: removeBatchReferenceColumn,
        removeRow: removeBatchRow,
        reorderReferenceColumns: reorderBatchReferenceColumns,
        syncRowsFromConnections,
        updateRow: updateBatchRow,
    } = useCanvasBatchTable({
        nodesRef,
        connectionsRef,
        setNodes,
        setConnections,
        setSelectedNodeIds,
        enqueueGenerationBatch,
    });

    const openTextAssetBatchGeneration = useCallback((node: CanvasNodeData) => {
        const content = (node.metadata?.content || node.metadata?.prompt || "").trim();
        if (!content) {
            message.warning("文本节点为空，无法拆分资产");
            return;
        }
        setTextBatchSourceNodeId(node.id);
    }, [message]);

    const confirmTextAssetBatchGeneration = useCallback((items: TextAssetBatchItem[], settings: TextAssetBatchGenerationSettings) => {
        const sourceNode = nodesRef.current.find((node) => node.id === textBatchSourceNodeId);
        if (!sourceNode || sourceNode.type !== CanvasNodeType.Text) {
            message.error("原文本节点已不存在，请重新选择");
            return;
        }
        const model = settings.imageModel || settings.model;
        if (!isAiConfigReady({ ...effectiveConfig, ...settings, model, imageModel: model }, model)) {
            message.error("所选图片模型尚未配置，未创建生成任务");
            return;
        }
        const imageDefaults = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
        // 先按所选比例预留真实卡片尺寸，避免生成后节点变成方图/竖图而侵入下一行。
        const imageSize = nodeSizeFromRatio(settings.size || "auto", imageDefaults.width, imageDefaults.height) || imageDefaults;
        const gap = REFERENCE_ASSET_GRID_GAP;
        const padding = REFERENCE_ASSET_GRID_PADDING;
        const columns = Math.min(REFERENCE_ASSET_GRID_COLUMNS, items.length);
        const rows = Math.ceil(items.length / columns);
        const frameWidth = padding * 2 + columns * imageSize.width + Math.max(0, columns - 1) * gap;
        const frameHeight = FRAME_HEADER_HEIGHT + padding * 2 + rows * imageSize.height + Math.max(0, rows - 1) * gap;
        const groupPosition = findAvailableGenerationGroupPosition(
            nodesRef.current,
            { x: sourceNode.position.x + sourceNode.width + 120, y: sourceNode.position.y },
            { width: frameWidth, height: frameHeight },
        );
        const frame = createCanvasNode(
            CanvasNodeType.Frame,
            { x: groupPosition.x + frameWidth / 2, y: groupPosition.y + frameHeight / 2 },
            {
                workflowKind: "reference_set",
                workflowTitle: "Note 资产组",
                referenceAssetNodeIds: [],
                frame: { collapsed: false, expandedWidth: frameWidth, expandedHeight: frameHeight },
            },
        );
        frame.title = `设定板资产组 · 角色 ${items.filter((item) => item.category === "character").length} · 场景 ${items.filter((item) => item.category === "environment").length}`;
        frame.position = groupPosition;
        frame.width = frameWidth;
        frame.height = frameHeight;
        const targets = items.map((item, index) => {
            const promptPrefix = item.sheetPrompt?.trim() || item.prompt.trim();
            const kind = item.category === "character" ? AssetSheetKind.Character : AssetSheetKind.Environment;
            const skillPrompt = [assetSheetLayoutInstruction(kind, settings.size || "横向画幅"), promptPrefix,
                "最终必须一次生成一张完整设定板原图，包含完整资料栏、视图布局、中文标签和已有尺寸标注；不要只生成视图素材，不要裁切、切图或交由程序重新拼版。",
                item.negativePrompt?.trim() ? `避免：${item.negativePrompt.trim()}` : ""].filter(Boolean).join("\n\n");
            const prompt = settings.styleTool
                ? applyToolMention(skillPrompt, { id: settings.styleTool.id, label: settings.styleTool.label, type: "style" }, "Palette")
                : skillPrompt;
            const generationSpec = specFromConfig(
                "image",
                prompt,
                {
                    ...effectiveConfig,
                    ...settings,
                    model,
                    imageModel: model,
                    count: "1",
                },
            );
            const node = createCanvasNode(
                CanvasNodeType.Image,
                {
                    x: groupPosition.x + padding + (index % columns) * (imageSize.width + gap) + imageSize.width / 2,
                    y: groupPosition.y + FRAME_HEADER_HEIGHT + padding + Math.floor(index / columns) * (imageSize.height + gap) + imageSize.height / 2,
                },
                {
                    prompt,
                    composerContent: prompt,
                    model,
                    size: settings.size,
                    quality: settings.quality,
                    transparentBackground: settings.transparentBackground,
                    count: 1,
                    generationMode: "image",
                    generationType: "generation",
                    workflowKind: item.category === "character" ? "character" : "scene",
                    workflowTitle: item.title.trim(),
                    workflowDescription: item.prompt.trim(),
                    assetCategory: item.category,
                    batchSourceNodeId: sourceNode.id,
                    batchRowId: item.id,
                    batchOperation: "creative",
                    status: "idle",
                    cameraControl: settings.cameraControl,
                    skillIds: settings.skillIds,
                    stylePresetId: settings.stylePresetId,
                    styleProfileJson: settings.styleProfileJson,
                    styleInheritance: "isolated",
                },
            );
            node.width = imageSize.width;
            node.height = imageSize.height;
            node.position = {
                x: groupPosition.x + padding + (index % columns) * (imageSize.width + gap),
                y: groupPosition.y + FRAME_HEADER_HEIGHT + padding + Math.floor(index / columns) * (imageSize.height + gap),
            };
            node.title = `${item.category === "character" ? "角色" : "场景"} · ${item.title.trim()}`;
            node.parentId = frame.id;
            node.metadata = {
                ...node.metadata,
                ...generationSpecMetadata(generationSpec),
                characterAliases: item.aliases,
                workflowDescription: item.summary ? `${item.summary}\n\n${item.sourceEvidence || ""}`.trim() : item.sourceEvidence,
                referenceSetId: frame.id,
                manualSize: true,
            };
            return { item, node };
        });
        frame.metadata = { ...frame.metadata, referenceAssetNodeIds: targets.map(({ node }) => node.id) };
        const nextNodes = [...nodesRef.current, frame, ...targets.map(({ node }) => node)];
        const nextConnections = [...connectionsRef.current];
        nodesRef.current = nextNodes;
        connectionsRef.current = nextConnections;
        setNodes(nextNodes);
        setConnections(nextConnections);
        setSelectedNodeIds(new Set(targets.map(({ node }) => node.id)));
        enqueueGenerationBatch(sourceNode.id, "batch_image", targets.map(({ item, node }) => ({ rowId: item.id, nodeId: node.id })));
        setTextBatchSourceNodeId(null);
        message.success(`已创建 ${targets.length} 个角色/场景图片任务`);
    }, [effectiveConfig, enqueueGenerationBatch, isAiConfigReady, message, nodesRef, setConnections, setNodes, setSelectedNodeIds, textBatchSourceNodeId]);


    useEffect(() => {
        if (!projectLoaded) return;
        setNodes((current) => {
            let changed = false;
            const next = current.map((node) => {
                const promoted = promoteLegacyBatchTableSize(node);
                if (promoted !== node) changed = true;
                return promoted;
            });
            return changed ? next : current;
        });
        nodesRef.current.filter((node) => node.type === CanvasNodeType.BatchTable).forEach((node) => {
            syncRowsFromConnections(node.id, true);
        });
    }, [connections, projectLoaded, setNodes, syncRowsFromConnections]);

    const handleUploadBatchReference = useCallback(async (tableNodeId: string, rowId: string, columnIndex: number, file: File) => {
        const tableNode = nodesRef.current.find((item) => item.id === tableNodeId);
        const table = tableNode?.metadata?.batchTable;
        const row = table?.rows.find((item) => item.id === rowId);
        if (!tableNode || !table || !row) return;
        const existingId = row.inputNodeIds[columnIndex];
        if (existingId) {
            await replaceNodeMedia(existingId, file);
            return;
        }
        const rowIndex = table.rows.findIndex((item) => item.id === rowId);
        const uploadedNodeId = await createFileNode(file, {
            x: tableNode.position.x - 240,
            y: tableNode.position.y + 170 + Math.max(0, rowIndex) * 220,
        });
        if (!uploadedNodeId) return;
        const inputNodeIds = Array.from({ length: Math.max(batchReferenceColumns(table).length, columnIndex + 1) }, (_, index) => row.inputNodeIds[index] || "");
        inputNodeIds[columnIndex] = uploadedNodeId;
        updateBatchRow(tableNodeId, rowId, { inputNodeIds });
        message.success(`已上传并填入参考图 ${columnIndex + 1}`);
    }, [createFileNode, message, nodesRef, replaceNodeMedia, updateBatchRow]);

    const { addScriptRow, createAndGenerateScriptVideos, createScriptActionBoards, createScriptImageNodes, generateScriptImages, generateScriptRows, generateScriptVideos, removeScriptRow, replaceScriptRows, updateScriptRow } =
        useCanvasStoryboard({
            projectId,
            addedSkills,
            nodesRef,
            connectionsRef,
            setNodes,
            setConnections,
            setSelectedNodeIds,
            enqueueGenerationBatch,
        });

    const createStoryboardFromBatchTable = useCallback(async (tableNodeId: string) => {
        const tableNode = nodesRef.current.find((node) => node.id === tableNodeId && node.type === CanvasNodeType.BatchTable);
        const table = tableNode?.metadata?.batchTable;
        if (!tableNode || !table || table.contentKind !== "storyboard") return;
        const rows = storyboardRowsFromBatchTable(table);
        if (!rows.length) return message.warning("当前表格没有可用的分镜行");
        const sourceIds = Array.from(new Set([
            ...(table.storyboardSourceNodeIds || []),
            ...connectionsRef.current.filter((connection) => connection.toNodeId === tableNodeId && connection.relation !== "batch-output").map((connection) => connection.fromNodeId),
        ])).filter((id) => nodesRef.current.some((node) => node.id === id));
        const sourceVideo = sourceIds.map((id) => nodesRef.current.find((node) => node.id === id)).find((node): node is CanvasNodeData => node?.type === CanvasNodeType.Video);
        const keyframeTimesMs = rows.map(storyboardKeyframeTime).filter((value): value is number => value !== undefined);
        const useKeyframes = Boolean(sourceVideo && keyframeTimesMs.length);
        const scriptSpec = getNodeSpec(CanvasNodeType.Script);
        const scriptNode = createCanvasNode(CanvasNodeType.Script, {
            x: tableNode.position.x + tableNode.width + 160 + scriptSpec.width / 2,
            y: tableNode.position.y + Math.max(tableNode.height, scriptSpec.height) / 2,
        }, {
            storyboard: { rows, visibleColumns: cinematicStoryboardColumns(), referenceNodeIds: sourceIds },
            storyboardVideoInputMode: useKeyframes ? "keyframe" : "direct",
            workflowKind: "storyboard",
            workflowTitle: table.storyboardTitle || "视频脚本",
            composerContent: table.storyboardTitle || "来自多维表格的视频分镜脚本",
            status: "idle",
        });
        scriptNode.title = table.storyboardTitle || "视频脚本";
        const nextConnections = [
            ...connectionsRef.current,
            ...sourceIds.map((sourceId) => ({ id: nanoid(), fromNodeId: sourceId, toNodeId: scriptNode.id, toHandleId: "storyboard:context", relation: "storyboard-asset-reference" as const })),
        ];
        const nextNodes = [...nodesRef.current, scriptNode];
        nodesRef.current = nextNodes;
        connectionsRef.current = nextConnections;
        setNodes(nextNodes);
        setConnections(nextConnections);
        setSelectedNodeIds(new Set([scriptNode.id]));
        setDialogNodeId(null);
        if (sourceVideo && keyframeTimesMs.length) {
            const frameNodes = await extractVideoFrames(sourceVideo, { timesMs: keyframeTimesMs });
            if (frameNodes.length) {
                const withFrames = nodesRef.current.map((node) => node.id === scriptNode.id ? { ...node, metadata: { ...node.metadata, storyboard: { ...node.metadata?.storyboard, rows: bindStoryboardKeyframes(node.metadata?.storyboard?.rows || rows, frameNodes, sourceVideo.id), visibleColumns: cinematicStoryboardColumns(), referenceNodeIds: sourceIds } } } : node);
                nodesRef.current = withFrames;
                setNodes(withFrames);
                message.success(`已创建视频脚本并自动抽取 ${frameNodes.length} 个关键帧，点击“生成视频”继续`);
            } else {
                message.warning("视频脚本已创建，但关键帧抽取失败；请检查视频是否已保存或允许跨域读取");
            }
        } else {
            message.success(`已创建视频脚本：${rows.length} 个镜头`);
        }
    }, [connectionsRef, extractVideoFrames, message, nodesRef, setConnections, setDialogNodeId, setNodes, setSelectedNodeIds]);

    const handleRetryNode = useCanvasGenerationRetry({
        projectId,
        domainProjectId: currentProject?.projectId,
        addedSkills,
        assets,
        nodesRef,
        connectionsRef,
        setNodes,
        setRunningNodeId,
        startGenerationRequest,
        finishGenerationRequest,
        bindGenerationTask,
        applyGenerationTaskResult,
    });
    const { extractStoryboardKeyframes, generateStoryboardFrames, retryStoryboardFrame, selectStoryboardFrameModel } = useEpisodeStoryboardFrames({
        projectId, nodesRef, connectionsRef, setNodes, setConnections,
        retry: handleRetryNode, enqueue: enqueueGenerationBatch,
        save: () => saveCanvasProject({ requireRemote: true }),
    });
    const reloadCanvasNodeResource = useCallback(
        async (node: CanvasNodeData) => {
            const taskId = node.metadata?.taskId;
            if (!taskId || !node.metadata?.resourceReloadAvailable) return;
            setNodes((current) => current.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: "loading", taskStage: "正在重新加载资源", errorDetails: undefined } } : item)));
            try {
                const task = await queryGenerationTask(taskId);
                if (task.status !== "succeeded") throw new Error("原生成任务尚未成功，无法重新加载资源");
                await applyGenerationTaskResult(node.id, task);
            } catch (error) {
                setNodes((current) =>
                    current.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: "error", errorDetails: error instanceof Error ? error.message : "资源重新加载失败", resourceReloadAvailable: true } } : item)),
                );
            }
        },
        [applyGenerationTaskResult, setNodes],
    );
    const reconcileImageBatchRootNode = useCallback(
        (rootId: string) => {
            setNodes((current) => {
                const root = current.find((item) => item.id === rootId);
                if (!root) return current;
                const reconciled = reconcileImageBatchRoot(root, current);
                return current.map((item) => (item.id === root.id ? reconciled : item));
            });
        },
        [setNodes],
    );
    const retryImageBatchChildren = useCallback(
        (rootId: string, children: CanvasNodeData[], options?: CanvasNodeRetryOptions) => {
            const childIds = children.map((child) => child.id);
            setNodes((current) => markImageBatchRetrying(rootId, childIds, current));
            return Promise.allSettled(
                children.map(async (child) => {
                    await handleRetryNode(child, options);
                    setNodes((current) => current.map((item) => (item.id === child.id ? restoreUnsubmittedImageBatchChild(item, child) : item)));
                }),
            ).finally(() => reconcileImageBatchRootNode(rootId));
        },
        [handleRetryNode, reconcileImageBatchRootNode, setNodes],
    );

    const generateImageFromTextNode = useCallback(
        (node: CanvasNodeData) => {
            const prompt = (node.metadata?.content || node.metadata?.prompt || "").trim();
            if (!prompt) {
                message.warning("文本节点为空，无法生图");
                return;
            }
            const sourceNode = nodesRef.current.find((item) => item.id === node.id);
            if (!sourceNode) return;
            const sourceWorkflow = nodeWorkflow(sourceNode);
            const referenceStep = sourceWorkflow && assetReferenceStep(sourceWorkflow.step);
            if (referenceStep) {
                openWorkflowGenerator(referenceStep, sourceNode.id);
                return;
            }
            const nodeSize = getNodeSpec(CanvasNodeType.Image);
            const imageNode = createCanvasNode(
                CanvasNodeType.Image,
                {
                    x: sourceNode.position.x + sourceNode.width + 96 + nodeSize.width / 2,
                    y: sourceNode.position.y + sourceNode.height / 2,
                },
                {
                    prompt: "@文本1",
                    composerContent: "@文本1",
                    model: effectiveConfig.imageModel || effectiveConfig.model,
                    size: effectiveConfig.size,
                    quality: effectiveConfig.quality,
                    transparentBackground: effectiveConfig.transparentBackground,
                    count: getGenerationCount(effectiveConfig.canvasImageCount || effectiveConfig.count),
                    ...(sourceNode.metadata?.shortDrama ? {
                        shortDrama: {
                            stage: sourceNode.metadata.shortDrama.stage,
                            step: sourceNode.metadata.shortDrama.step,
                            pipelineId: sourceNode.metadata.shortDrama.pipelineId,
                            role: "document" as const,
                            sourceNodeIds: [sourceNode.id],
                            sourceSignatures: { [sourceNode.id]: workflowSignature(sourceNode) },
                            sourceSteps: [sourceNode.metadata.shortDrama.step],
                            mediaKind: "image" as const,
                            version: sourceNode.metadata.shortDrama.version,
                        },
                    } : {}),
                },
            );
            const workflowMediaLabel = sourceNode.metadata?.shortDrama ? shortDramaStep(sourceNode.metadata.shortDrama.step)?.mediaActionLabel : undefined;
            imageNode.title = workflowMediaLabel || "图片生成";
            const connection = { id: nanoid(), fromNodeId: sourceNode.id, toNodeId: imageNode.id };
            const nextNodes = nodesRef.current.map((item) => (item.id === sourceNode.id ? { ...item, metadata: { ...item.metadata, content: prompt, richText: undefined, prompt, status: NODE_STATUS_SUCCESS } } : item)).concat(imageNode);
            const nextConnections = [...connectionsRef.current, connection];
            nodesRef.current = nextNodes;
            connectionsRef.current = nextConnections;
            setNodes(nextNodes);
            setConnections(nextConnections);
            setSelectedNodeIds(new Set([imageNode.id]));
            setSelectedConnectionId(null);
            setDialogNodeId(imageNode.id);
        },
        [effectiveConfig, message, openWorkflowGenerator],
    );

    const renderCanvasNodePanel = useCallback(
        (panelNode: CanvasNodeData) => {
            if (panelNode.type === CanvasNodeType.Script || panelNode.type === CanvasNodeType.Drawing) return null;
            return panelNode.type === CanvasNodeType.Config ? (
                <CanvasConfigComposer
                    value={panelNode.metadata?.composerContent ?? panelNode.metadata?.prompt ?? ""}
                    inputs={configInputsById.get(panelNode.id) || []}
                    skillReferences={skillMentionReferences}
                    generationMode={panelNode.metadata?.generationMode}
                    metadata={panelNode.metadata}
                    workspaceMode={workspaceMode}
                    onChange={(composerContent) => handleConfigNodeChange(panelNode.id, { composerContent })}
                    onMetadataChange={(patch) => handleConfigNodeChange(panelNode.id, patch)}
                    onClose={() => setDialogNodeId(null)}
                />
            ) : (
                <CanvasNodePromptPanel
                    projectId={projectId}
                    node={panelNode}
                    isRunning={isCanvasNodeGenerating(panelNode, runningNodeId)}
                    mentionReferences={[
                        ...(mentionReferencesByNodeId.get(panelNode.id) || EMPTY_RESOURCE_REFERENCES),
                        ...buildCanvasResourceReferences(nodesRef.current, connectionsRef.current).filter((reference) => reference.kind === "text" && reference.nodeId !== panelNode.id && !(mentionReferencesByNodeId.get(panelNode.id) || []).some((active) => active.nodeId === reference.nodeId)),
                    ]}
                    onAddReference={(nodeId, reference) => {
                        if (reference.active || reference.assetId || reference.kind === "skill") return reference;
                        if (reference.kind !== "text" || !reference.nodeId || reference.nodeId === nodeId) return undefined;
                        try {
                            const linked = connectCanvasTextMention(nodesRef.current, connectionsRef.current, nodeId, reference.nodeId, nanoid());
                            nodesRef.current = linked.nodes;
                            connectionsRef.current = linked.connections;
                            setNodes(linked.nodes);
                            setConnections(linked.connections);
                            return linked.reference;
                        } catch (cause) {
                            message.warning(cause instanceof Error ? cause.message : "文本引用失败");
                            return undefined;
                        }
                    }}
                    onPromptChange={handleNodePromptChange}
                    onConfigChange={handleConfigNodeChange}
                    onGenerate={handleGenerateNode}
                    onRemoveReference={handleRemoveNodeReference}
                    onReorderReferences={handleReorderNodeReferences}
                    onReplaceReference={handleReplaceNodeReference}
                    onReplaceReferenceFiles={handleReplaceNodeReferenceFiles}
                    onClose={() => setDialogNodeId(null)}
                    onNodeMouseDown={handleNodeMouseDown}
                    workspaceMode={workspaceMode}
                    onImageSettingsOpenChange={(open) => {
                        setNodeImageSettingsOpen(open);
                        if (open) setToolbarNodeId(null);
                    }}
                    onListGenerate={(nodeId, listPrompt) => {
                        void handleListGenerate({
                            sourceNodeId: nodeId,
                            prompt: listPrompt,
                            nodes: nodesRef.current,
                            connections: connectionsRef.current,
                            config: effectiveConfig,
                            projectId,
                            setNodes,
                            setConnections,
                            setRunningNodeId,
                            setDialogNodeId,
                        });
                    }}
                />
            );
        },
        [
            configInputsById,
            effectiveConfig,
            handleConfigNodeChange,
            handleGenerateNode,
            handleNodePromptChange,
            handleRemoveNodeReference,
            handleReorderNodeReferences,
            handleReplaceNodeReference,
            handleReplaceNodeReferenceFiles,
            mentionReferencesByNodeId,
            message,
            projectId,
            runningNodeId,
            setConnections,
            setDialogNodeId,
            setNodes,
            setRunningNodeId,
            skillMentionReferences,
            workspaceMode,
        ],
    );

    const renderCanvasNodeContent = useCallback(
        (contentNode: CanvasNodeData, scope: CanvasCustomNodeScope) => {
            const diagnosticNode = Boolean(contentNode.metadata?.shortDrama?.screenplayAudit || contentNode.metadata?.shortDrama?.screenplayRepair);
            if ([ShortDramaStep.Body, ShortDramaStep.Audit].includes(contentNode.metadata?.shortDrama?.step as ShortDramaStep) && contentNode.metadata?.content?.trim() && contentNode.metadata.status !== "loading" && (contentNode.metadata.status !== "error" || diagnosticNode)) {
                const auditBody = contentNode.metadata?.shortDrama?.screenplayAudit?.bodyNodeId ? scope.nodes.find((source) => source.id === contentNode.metadata?.shortDrama?.screenplayAudit?.bodyNodeId) : undefined;
                return <CanvasScreenplayNodeContent node={contentNode} nodes={scope.nodes} settings={currentProject?.globalSettings} onRepair={openScreenplayRepair} onReport={setScreenplayAuditDetailId} onAudit={() => runSingleScreenplayAudit(auditBody || contentNode)} onEdit={() => openTextNodeEditor(contentNode)} />;
            }
            if (contentNode.metadata?.workflowKind === "character" && contentNode.metadata.characterAssetId) {
                return <CanvasCharacterReferenceNodeContent node={contentNode} onInfo={() => setInfoNodeId(contentNode.id)} />;
            }
            if (contentNode.metadata?.workflowKind === "styleboard" && !contentNode.metadata.content) {
                return <CanvasStylePlaceholderNodeContent onChoose={() => setStylePickerOpen(true)} onInfo={() => setInfoNodeId(contentNode.id)} />;
            }
            if (contentNode.metadata?.workflowKind === "story_input") {
                return <CanvasStoryInputNodeContent node={contentNode} onEdit={() => openStoryInput(contentNode.id)} />;
            }
            if (contentNode.type === CanvasNodeType.BatchTable) {
                return (
                    <CanvasBatchTableNodeContent
                        node={contentNode}
                        nodes={scope.nodes}
                        connections={scope.connections}
                        batch={visibleGenerationBatch(contentNode)}
                        theme={theme}
                        onPatchTable={(patch) => patchBatchTable(contentNode.id, patch)}
                        onAddRow={() => addBatchRow(contentNode.id)}
                        onRemoveRow={(rowId) => removeBatchRow(contentNode.id, rowId)}
                        onUpdateRow={(rowId, patch) => updateBatchRow(contentNode.id, rowId, patch)}
                        onFillRows={() => fillRowsFromConnections(contentNode.id)}
                        onGenerate={(rowIds) => void generateBatchRows(contentNode.id, rowIds)}
                        onCreateStoryboard={() => createStoryboardFromBatchTable(contentNode.id)}
                        onRetryItem={(batchId, itemId) => retryFailedBatchItems(contentNode.id, batchId, itemId)}
                        onAddReferenceColumn={() => addBatchReferenceColumn(contentNode.id)}
                        onRemoveReferenceColumn={() => removeBatchReferenceColumn(contentNode.id)}
                        onFocusOutput={(nodeId) => focusCanvasImageNode(nodeId)}
                        onReorderReferenceColumns={(fromColumnId, toColumnId) => reorderBatchReferenceColumns(contentNode.id, fromColumnId, toColumnId)}
                        onMoveReferenceCell={(sourceRowId, sourceColumnIndex, targetRowId, targetColumnIndex) => moveBatchReferenceCell(contentNode.id, sourceRowId, sourceColumnIndex, targetRowId, targetColumnIndex)}
                        onUploadReference={(rowId, columnIndex, file) => { void handleUploadBatchReference(contentNode.id, rowId, columnIndex, file); }}
                        onConnectStart={(event, handleId) => handleConnectStart(event, contentNode.id, "target", handleId)}
                        onConnectDrop={(event, handleId) => handleConnectDrop(event, contentNode.id, handleId)}
                    />
                );
            }
            if (contentNode.type === CanvasNodeType.Script) {
                if (contentNode.metadata?.shortDrama?.step === ShortDramaStep.Shots) return <CanvasEpisodeStoryboard
                    node={contentNode} nodes={scope.nodes}
                    progress={productionAgentRuns.runs.find(run => run.id === contentNode.metadata?.shortDrama?.productionAgent?.runId && run.production?.targetNodeId === contentNode.id)?.production}
                    onGenerate={(ids) => createAndGenerateScriptVideos(contentNode.id, ids)}
                    onPause={() => pauseGenerationBatches(contentNode.id)}
                    onRetry={(video) => {
                        const row = contentNode.metadata?.storyboard?.rows.find(row => row.videoNodeId === video.id);
                        if (row) void createAndGenerateScriptVideos(contentNode.id, [row.id]);
                    }}
                    onDetails={() => setInfoNodeId(contentNode.id)}
                    onUpdate={(id, patch) => updateScriptRow(contentNode.id, id, patch)}
                    onCancel={cancelCanvasTask}
                    onModelChange={(model) => useConfigStore.getState().rememberModel("video", model)}
                    onGenerateFrames={(rowId, kind, options) => generateStoryboardFrames(contentNode.id, rowId, kind, options)}
                    onExtractKeyframes={(rowId) => extractStoryboardKeyframes(contentNode.id, rowId)}
                    onRetryFrame={(image) => { void retryStoryboardFrame(image); }}
                    onFrameModelChange={(kind, model) => selectStoryboardFrameModel(contentNode.id, kind, model)}
                />;
                const pipeline = deriveStoryboardPipelineProgress(contentNode, scope.nodes, scope.connections);
                return (
                    <CanvasScriptNodeContent
                        node={contentNode}
                        nodes={scope.nodes}
                        batch={visibleGenerationBatch(contentNode)}
                        pipeline={pipeline}
                        scale={viewport.k}
                        mentionReferences={scope.mentionReferences}
                        onOpen={() => setScriptEditorNodeId(contentNode.id)}
                        onCreateImageNodes={() => createScriptImageNodes(contentNode.id)}
                        onGenerateImages={(rowIds) => void generateScriptImages(contentNode.id, rowIds)}
                        onGenerateVideos={(rowIds) => (contentNode.metadata?.storyboardVideoInputMode === "keyframe" ? void generateScriptVideos(contentNode.id, rowIds) : void createAndGenerateScriptVideos(contentNode.id, rowIds))}
                        onVideoInputModeChange={(storyboardVideoInputMode) => handleConfigNodeChange(contentNode.id, { storyboardVideoInputMode })}
                        onMergeVideos={() => void mergeVideosByIds(pipeline.successfulVideoNodeIds)}
                        onCreateActionBoards={() => void createScriptActionBoards(contentNode.id)}
                        onRetryBatch={(batchId) => retryFailedBatchItems(contentNode.id, batchId)}
                        onRetryBatchItem={(batchId, itemId) => retryFailedBatchItems(contentNode.id, batchId, itemId)}
                        onStopBatch={(batchId) => stopRemainingBatchItems(contentNode.id, batchId)}
                        onAddRow={() => addScriptRow(contentNode.id)}
                        onRemoveRow={(rowId) => removeScriptRow(contentNode.id, rowId)}
                        onUpdateRow={(rowId, patch) => updateScriptRow(contentNode.id, rowId, patch)}
                        onPromptChange={(composerContent) => handleConfigNodeChange(contentNode.id, { composerContent })}
                        onGenerateScript={(prompt) => void generateScriptRows(contentNode.id, prompt)}
                        onModelChange={(model) => handleConfigNodeChange(contentNode.id, { model })}
                        onShotDurationChange={(duration: StoryboardShotDuration) => handleConfigNodeChange(contentNode.id, { storyboardShotDuration: duration })}
                        onShotCountChange={(count: StoryboardShotCount) => handleConfigNodeChange(contentNode.id, { storyboardShotCount: count })}
                        workspaceMode={workspaceMode}
                        onComposerHeightChange={(height) => {
                            if (contentNode.metadata?.storyboardComposerHeight === height) return;
                            handleConfigNodeChange(contentNode.id, { storyboardComposerHeight: height });
                            const minHeight = storyboardMinNodeHeight(height);
                            if (contentNode.height < minHeight) handleNodeResize(contentNode.id, contentNode.width, minHeight);
                        }}
                        onConnectStart={(event, rowId, handleType) => handleConnectStart(event, contentNode.id, handleType, rowId === "context" ? "storyboard:context" : `row:${rowId}`)}
                        onScrollTopChange={(scrollTop) => setScriptScrollTopById((current) => (current[contentNode.id] === scrollTop ? current : { ...current, [contentNode.id]: scrollTop }))}
                    />
                );
            }
            if (contentNode.metadata?.directorSceneId) {
                return (
                    <CanvasDirectorNodePanel
                        node={contentNode}
                        scene={scope.directorScene}
                        readNodeContent={(nodeId) => (nodeId ? scope.nodes.find((item) => item.id === nodeId)?.metadata?.content : undefined)}
                        professional={workspaceMode === "professional"}
                        onOpen={() => openDirectorWorkbench(contentNode.id)}
                        onInfo={() => setInfoNodeId(contentNode.id)}
                    />
                );
            }
            return (
                <CanvasConfigNodePanel
                    node={contentNode}
                    isRunning={scope.isRunning}
                    inputSummary={scope.inputSummary}
                    onConfigChange={handleConfigNodeChange}
                    onComposerToggle={() => setDialogNodeId((current) => (current === contentNode.id ? null : contentNode.id))}
                    onGenerate={(nodeId) => {
                        const target = nodesRef.current.find((item) => item.id === nodeId);
                        void handleGenerateNode(nodeId, target?.metadata?.generationMode || "image", target?.metadata?.composerContent ?? target?.metadata?.prompt ?? "");
                    }}
                    workspaceMode={workspaceMode}
                />
            );
        },
        [
            addBatchReferenceColumn,
            addBatchRow,
            addScriptRow,
            createAndGenerateScriptVideos,
            createScriptActionBoards,
            createStoryboardFromBatchTable,
            createScriptImageNodes,
            fillRowsFromConnections,
            focusCanvasImageNode,
            generateBatchRows,
            generateScriptImages,
            generateScriptRows,
            generateScriptVideos,
            handleUploadBatchReference,
            moveBatchReferenceCell,
            handleConfigNodeChange,
            handleConnectDrop,
            handleConnectStart,
            handleGenerateNode,
            handleNodeResize,
            mergeVideosByIds,
            openDirectorWorkbench,
            openStoryInput,
            openScreenplayRepair,
            openTextNodeEditor,
            currentProject?.globalSettings,
            patchBatchTable,
            removeBatchReferenceColumn,
            removeBatchRow,
            reorderBatchReferenceColumns,
            removeScriptRow,
            retryFailedBatchItems,
            cancelCanvasTask,
            pauseGenerationBatches,
            generateStoryboardFrames,
            extractStoryboardKeyframes,
            retryStoryboardFrame,
            selectStoryboardFrameModel,
            productionAgentRuns.runs,
            stopRemainingBatchItems,
            theme,
            updateBatchRow,
            updateScriptRow,
            viewport.k,
            workspaceMode,
        ],
    );

    const renderCanvasNodeContentById = useCanvasScopedNodeRenderers({
        visibleNodes, nodes, connections, mentionReferencesByNodeId, configInputsById,
        directorScenes: currentProject?.directorScenes, runningNodeId,
    }, renderCanvasNodeContent);

    const handleCanvasNodeHoverStart = useCallback(
        (nodeId: string) => {
            if (nodeDraggingRef.current) return;
            setHoveredNodeId(nodeId);
            keepNodeToolbar(nodeId);
        },
        [keepNodeToolbar],
    );
    const handleCanvasNodeHoverEnd = useCallback(
        (nodeId: string) => {
            setHoveredNodeId((current) => (current === nodeId ? null : current));
            hideNodeToolbar();
        },
        [hideNodeToolbar],
    );
    const retryCanvasNode = useCallback(
        (node: CanvasNodeData, options?: CanvasNodeRetryOptions) => {
            if (node.metadata?.storyboardFramePlan) { void extractStoryboardKeyframes(node.metadata.storyboardFramePlan.scriptId, node.metadata.storyboardFramePlan.rowId); return; }
            if (node.metadata?.storyboardFrame) { void retryStoryboardFrame(node); return; }
            if (node.metadata?.shortDrama?.submission === "planned") { setInfoNodeId(node.id); return; }
            if (node.metadata?.shortDrama?.productionAgent) { setInfoNodeId(node.id); return; }
            if (node.type === CanvasNodeType.Script) {
                const prompt = (node.metadata?.composerContent || node.metadata?.prompt || "").trim();
                if (!prompt) {
                    message.warning("分镜脚本缺少剧情内容，无法重试");
                    return;
                }
                void generateScriptRows(node.id, prompt);
                return;
            }
            if (node.type === CanvasNodeType.Image && node.metadata?.isBatchRoot) {
                const failedChildren = failedImageBatchChildren(node, nodesRef.current);
                if (!failedChildren.length) {
                    message.info("当前批次没有需要重试的失败图片");
                    return;
                }
                message.info(`正在重试 ${failedChildren.length} 个失败图片`);
                retryImageBatchChildren(node.id, failedChildren);
                return;
            }
            if (node.type === CanvasNodeType.Image && node.metadata?.batchRootId) {
                retryImageBatchChildren(node.metadata.batchRootId, [node]);
                return;
            }
            void handleRetryNode(node, options);
        },
        [extractStoryboardKeyframes, retryStoryboardFrame, generateScriptRows, handleRetryNode, message, nodesRef, retryImageBatchChildren],
    );
    const retryingFailedRef = useRef(false);
    const retryFailedFrameNodes = useCallback(
        (_frame: CanvasNodeData, failedNodes: CanvasNodeData[]) => {
            if (retryingFailedRef.current) {
                message.info("正在重试失败任务，请稍候");
                return;
            }
            const latest = new Map(nodesRef.current.map((item) => [item.id, item]));
            const candidates = failedNodes.map((item) => latest.get(item.id) ?? item).filter((item) => item.metadata?.status === "error");
            const batches = new Map<string, CanvasNodeData[]>();
            const singles: CanvasNodeData[] = [];
            let moderated = 0;
            let skipped = 0;
            for (const node of candidates) {
                const meta = node.metadata;
                if (meta?.generationErrorCode === CONTENT_MODERATION_ERROR_CODE || isContentModerationError(meta?.errorDetails)) { moderated += 1; continue; }
                if (meta?.shortDrama?.submission === "planned") { skipped += 1; continue; }
                if (node.type === CanvasNodeType.Image && meta?.batchRootId && !meta.storyboardFrame && !meta.storyboardFramePlan) {
                    batches.set(meta.batchRootId, [...(batches.get(meta.batchRootId) ?? []), node]);
                } else {
                    singles.push(node);
                }
            }
            const total = singles.length + [...batches.values()].reduce((sum, children) => sum + children.length, 0);
            if (!total) {
                message.info(moderated ? `${moderated} 个失败任务因内容审核未通过，需要先修改提示词` : "没有可以直接重试的失败任务");
                return;
            }
            const run = async () => {
                retryingFailedRef.current = true;
                let failedToSubmit = skipped;
                const acknowledged: CanvasNodeRetryOptions = { billingAcknowledged: true };
                const jobs: Array<() => Promise<unknown>> = [
                    ...[...batches].map(([rootId, children]) => () => retryImageBatchChildren(rootId, children, acknowledged)),
                    ...singles.map((node) => async () => {
                        const meta = node.metadata;
                        try {
                            if (meta?.storyboardFramePlan) {
                                await extractStoryboardKeyframes(meta.storyboardFramePlan.scriptId, meta.storyboardFramePlan.rowId);
                            } else if (meta?.storyboardFrame) {
                                await retryStoryboardFrame(node);
                            } else if (node.type === CanvasNodeType.Script) {
                                const prompt = (meta?.composerContent || meta?.prompt || "").trim();
                                if (!prompt) { failedToSubmit += 1; return; }
                                await generateScriptRows(node.id, prompt);
                            } else {
                                await handleRetryNode(node, acknowledged);
                            }
                        } catch {
                            failedToSubmit += 1;
                        }
                    }),
                ];
                message.info(`已加入队列 ${total} 个失败任务，将自动依次提交`);
                try {
                    // 按并发上限从队列取任务，确认只在入口做一次。
                    const queue = [...jobs];
                    const workers = Array.from({ length: Math.min(RETRY_FAILED_CONCURRENCY, queue.length) }, async () => {
                        for (let job = queue.shift(); job; job = queue.shift()) {
                            try { await job(); } catch { failedToSubmit += 1; }
                        }
                    });
                    await Promise.all(workers);
                } finally {
                    retryingFailedRef.current = false;
                }
                const notes = [failedToSubmit ? `${failedToSubmit} 个未能提交` : "", moderated ? `${moderated} 个因内容审核未通过已跳过` : ""].filter(Boolean);
                if (notes.length) message.info(`失败任务重试完成，${notes.join("，")}`);
            };
            modal.confirm({
                title: "重试失败任务",
                content: `将重新提交 ${total} 个失败任务并自动排队，确认后不再逐个询问。其中上次请求未返回结果的任务费用仍待核对，重新提交会发起新的调用，原调用仍可能产生费用。${moderated ? `另有 ${moderated} 个因内容审核未通过的任务不会重试。` : ""}`,
                okText: "确认并全部重试",
                cancelText: "取消",
                onOk: () => { void run(); },
            });
        },
        [extractStoryboardKeyframes, generateScriptRows, handleRetryNode, message, modal, nodesRef, retryImageBatchChildren, retryStoryboardFrame],
    );
    const infoNode = nodeDetailsTarget(rawInfoNode, nodes);
    const openCanvasNodeTaskDetails = useCallback(
        (node: CanvasNodeData) => setInfoNodeId(node.id),
        [],
    );
    const openCanvasNodeVersions = useCallback((node: CanvasNodeData) => setVersionCompareRootId(node.metadata?.versionOfNodeId || node.id), []);
    const viewCanvasNodeImage = useCallback((node: CanvasNodeData) => setPreviewNodeId(node.id), []);
    const maskEditCanvasNodeImage = useCallback((node: CanvasNodeData) => setMaskEditNodeId(node.id), [setMaskEditNodeId]);
    const editCanvasDirector = useCallback((node: CanvasNodeData) => openDirectorWorkbench(node.id), [openDirectorWorkbench]);
    const locateProjectStyleNode = useCallback(() => {
        const styleNode = nodesRef.current.find((node) => node.type === CanvasNodeType.Text && node.metadata?.workflowKind === "styleboard");
        if (!styleNode) {
            message.info("项目画风节点正在同步，请稍后再试");
            return;
        }
        focusCanvasNode(styleNode.id);
    }, [focusCanvasNode, message, nodesRef]);
    const freeformCreateCommands = useCanvasCreateCommands({
        workspaceMode,
        isProjectLinked: Boolean(shortDramaEnabled && currentProject?.projectId),
        handlers: {
            onAddText: () => createNode(CanvasNodeType.Text),
            onAddImage: () => createNode(CanvasNodeType.Image),
            onAddVideo: () => createNode(CanvasNodeType.Video),
            onAddAudio: () => createNode(CanvasNodeType.Audio),
            onAddScript: () => createNode(CanvasNodeType.Script),
            onAddFrame: () => createNode(CanvasNodeType.Frame),
            onAddFolder: createFolder,
            onAddDrawing: () => createNode(CanvasNodeType.Drawing),
            onAddWorkflow: () => createNode(CanvasNodeType.Config),
            onAddExtensionNode: (type) => createNode(type),
            onChooseStyle: () => setStylePickerOpen(true),
            onOpenDirector: () => setDirectorTemplateRequest({}),
            onUpload: () => handleUploadRequest(),
            onOpenMyAssets: () => openCanvasAssetLibrary(),
            onOpenProjectCharacters: () => openProjectAssets("character"),
        },
    });
    const emptyStateKind = resolveCanvasEmptyStateKind({
        nodeCount: nodes.length,
        shortDramaEnabled,
        isProjectLinked: Boolean(currentProject?.projectId),
        starterMode: currentProject?.starterMode,
    });
    const emptyCanvasState =
        emptyStateKind === "freeform" ? (
            <CanvasFreeformEmptyState commands={freeformCreateCommands} />
        ) : emptyStateKind === "linked" ? (
            <CanvasLinkedProjectEmptyState
                projectName={linkedProjectQuery.data?.project.name || currentProject?.title || "项目画布"}
                hasChapter={Boolean(linkedProjectQuery.data?.units.length)}
                onAddFirstChapter={() => {
                    const first = linkedProjectQuery.data?.units.slice().sort((left, right) => left.position - right.position)[0];
                    if (first) void handleProjectChapterInsert({ id: first.id, projectId: linkedProjectId, title: first.title, position: first.position });
                }}
                onOpenAssets={() => openProjectAssets()}
                onAddText={() => createNode(CanvasNodeType.Text)}
            />
        ) : emptyStateKind === "guided" ? (
            <CanvasShortDramaEmptyState
                onCreatePipeline={createShortDramaPipeline}
                onOpenAgent={() => {
                    setCinematicAgentEntry(true);
                    openAgent();
                }}
                onStartFreeform={() => updateProject(projectId, { starterMode: "freeform" })}
                onUpload={() => handleUploadRequest()}
                onAddText={() => createNode(CanvasNodeType.Text)}
                onAddScript={() => createNode(CanvasNodeType.Script)}
            />
        ) : null;
    if (!projectLoaded && loadError)
        return (
            <main className="flex h-full flex-col items-center justify-center gap-4">
                <p role="alert">{loadError}</p>
                <Button onClick={retryLoad}>重新加载</Button>
                <Link to="/canvas">返回画布库</Link>
            </main>
        );
    if (!projectLoaded) return <CanvasRefreshShell />;

    return (
        <>
            <a
                href="#canvas-main"
                className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[var(--z-toast)] focus:rounded-md focus:border focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:shadow-lg"
            >
                跳转到画布主内容
            </a>
            <main id="canvas-main" tabIndex={-1} className={`relative flex h-full min-h-0 overflow-hidden outline-none ${!focusMode && !versions.preview ? `canvas-main-with-workspace ${workspaceOpen ? "canvas-workspace-expanded" : ""}` : ""}`} style={{ background: resolvedCanvasAppearance.background, color: theme.node.text }}>
                {!focusMode && !versions.preview ? <CanvasWorkspacePanel key={projectId} open={workspaceOpen} onOpen={() => setWorkspaceOpen(true)} onInsertAssets={handleProjectAssetsInsert} projectId={projectId} nodes={nodes} selectedNodeIds={selectedNodeIds} onClose={() => setWorkspaceOpen(false)} onAssets={() => openCanvasAssetLibrary()} onProjectAssets={currentProject?.projectId ? () => openProjectAssets() : undefined} onCancelTask={cancelCanvasTask} onFocus={nodeId => {
                    const target = nodeById.get(nodeId);
                    const parent = target?.parentId ? nodeById.get(target.parentId) : null;
                    if (parent?.metadata?.frame?.collapsed) toggleFrameCollapsed(parent.id);
                    const batchRoot = target?.metadata?.batchRootId ? nodeById.get(target.metadata.batchRootId) : null;
                    if (batchRoot && !batchRoot.metadata?.imageBatchExpanded) toggleBatchExpanded(batchRoot.id);
                    const selection = new Set([nodeId]); selectedNodeIdsRef.current = selection; setSelectedNodeIds(selection); setSelectedConnectionId(null); focusCanvasNode(nodeId);
                }} /> : null}
                {!workspaceOpen && !focusMode && !versions.preview && shortDramaEnabled && currentProject?.projectId ? (
                    <CanvasProjectSidebar projectId={currentProject.projectId} detail={linkedProjectQuery.data} onAddChapter={handleProjectChapterInsert} onLocateStyle={locateProjectStyleNode} onOpenAssets={() => openProjectAssets()} />
                ) : null}
                <CanvasOverlayLayerProvider>
                    <div className="canvas-editor-shell relative flex min-w-0 flex-1" data-director-open={directorNodeId && activeDirectorScene ? "true" : undefined}>
                    <section data-canvas-editor inert={Boolean(versions.preview)} style={{ visibility: versions.preview ? "hidden" : undefined, opacity: versions.preview ? 0 : undefined }} className="relative min-w-0 flex-1 flex flex-col min-h-0 overflow-hidden">
                        {!focusMode ? (
                            <CanvasTopBar
                                syncStatus={<CanvasSyncStatus projectId={projectId} onLoadLatest={reloadLatestCanvasProject} onOpenVersions={openVersions} />}
                                versionsOpen={versions.open}
                                onToggleVersions={() => { closeAgent(); setVersionCompareRootId(null); versions.toggle(); }}
                                title={currentProject?.title || "未命名画布"}
                                titleDraft={titleDraft}
                                isTitleEditing={titleEditing}
                                onTitleDraftChange={setTitleDraft}
                                onStartTitleEditing={startTitleEditing}
                                onFinishTitleEditing={finishTitleEditing}
                                onCancelTitleEditing={() => setTitleEditing(false)}
                                canUndo={historyState.canUndo}
                                canRedo={historyState.canRedo}
                                onCreateProject={createAndOpenProject}
                                onOpenGlobalSettings={() => setGlobalSettingsOpen(true)}
                                onDeleteProject={deleteCurrentProject}
                                onSave={() => void saveCanvasProject()}
                                onOpenProjectAssociation={shortDramaEnabled ? () => setProjectAssociationOpen(true) : undefined}
                                onForceSave={confirmForceSaveCanvas}
                                onImportImage={() => handleUploadRequest()}
                                onImportLibTV={() => setLibTVImportOpen(true)}
                                onImportTapNow={() => setTapNowImportOpen(true)}
                                onUndo={undoCanvas}
                                onRedo={redoCanvas}
                                onShare={() => setShareModalOpen(true)}
                                shortcutRequestNonce={shortcutRequestNonce}
                                mediaPerformanceMode={mediaPerformanceMode}
                                onMediaPerformanceModeChange={setMediaPerformanceMode}
                                onOpenSearch={() => setNodeSearchOpen(true)}
                                projectContext={
                                    shortDramaEnabled && currentProject?.projectId
                                        ? {
                                              ...canvasContext,
                                              projectId: currentProject.projectId,
                                              projectName: linkedProjectQuery.data?.project.name || currentProject.title,
                                          }
                                        : undefined
                                }
                                onEnterFocusMode={enterFocusMode}
                                shortDramaGuide={shortDramaGuide}
                            />
                        ) : null}

                        <CanvasNodeSearchModal
                            open={nodeSearchOpen}
                            nodes={nodes}
                            onClose={() => setNodeSearchOpen(false)}
                            onFocus={(nodeId) => {
                                const target = nodeById.get(nodeId);
                                const parent = target?.parentId ? nodeById.get(target.parentId) : null;
                                if (parent?.metadata?.frame?.collapsed) toggleFrameCollapsed(parent.id);
                                const batchRoot = target?.metadata?.batchRootId ? nodeById.get(target.metadata.batchRootId) : null;
                                if (batchRoot && !batchRoot.metadata?.imageBatchExpanded) toggleBatchExpanded(batchRoot.id);
                                const selection = new Set([nodeId]);
                                selectedNodeIdsRef.current = selection;
                                setSelectedNodeIds(selection);
                                setSelectedConnectionId(null);
                                focusCanvasNode(nodeId);
                            }}
                        />

                        {shortDramaGuide ? (
                            <CanvasShortDramaGuide key={projectId} progress={shortDramaGuide.progress} collapsed={shortDramaGuide.collapsed} onToggle={shortDramaGuide.onToggle} onSkip={skipShortDramaGuide} onTaskClick={activateShortDramaTask} onOpenGlobalSettings={() => setGlobalSettingsOpen(true)} topInset={focusMode ? "var(--space-24)" : undefined} />
                        ) : null}

                        <CanvasShareModal projectId={projectId} open={shareModalOpen} onClose={() => setShareModalOpen(false)} beforeCreate={saveCanvasProject} />
                        {projectAssociationOpen ? <CanvasProjectAssociation key={JSON.stringify([getActiveUserScope(), projectId])} canvasId={projectId} onClose={() => setProjectAssociationOpen(false)} onSave={saveCanvasProject} onReload={reloadLatestCanvasProject} /> : null}
                        <LibTVImportDialog open={libTVImportOpen} projectId={projectId} viewport={viewport} viewportSize={size} onClose={() => setLibTVImportOpen(false)} onApply={applyLibTVImport} />
                        <TapNowImportDialog open={tapNowImportOpen} projectId={projectId} viewport={viewport} viewportSize={size} onClose={() => setTapNowImportOpen(false)} onApply={applyTapNowImport} />

                        <CanvasStylePickerModal open={stylePickerOpen} value={activeStylePresetId} applying={styleApplying} onClose={() => setStylePickerOpen(false)} onSelect={selectCanvasStyle} />

                        <CanvasDirectorTemplateModal open={Boolean(directorTemplateRequest)} onClose={() => setDirectorTemplateRequest(null)} onSelect={(templateId) => createDirectorShot(templateId, directorTemplateRequest?.position)} />

                        <div className="relative flex min-h-0 min-w-0 flex-1">
                            <div className="relative min-w-0 flex-1 overflow-hidden">
                                <InfiniteCanvas
                                    interactive={!versions.preview}
                                    containerRef={containerRef}
                                    viewport={viewport}
                                    appearance={canvasAppearance}
                                    backgroundMode={backgroundMode}
                                    graphicsLayer={
                                        <CanvasLeaferGraphicsLayer
                                            containerRef={containerRef}
                                            viewport={viewport}
                                            theme={theme}
                                            displayConnections={visibleDisplayConnections}
                                            connectionPolicy={canvasConnectionPolicy}
                                            selectedConnectionId={selectedConnectionId}
                                            relatedConnectionIds={relatedHighlight.connectionIds}
                                            scriptScrollTopById={scriptScrollTopById}
                                            connectingParams={connectingParams}
                                            batchConnectionPreview={batchConnectionPreview}
                                            mouseWorld={mouseWorld}
                                            connectionTargetNodeId={connectionTargetNodeId}
                                            connectionTargetAnchorRatio={connectionTargetAnchorRatio}
                                            nodeById={nodeById}
                                            selectionBox={selectionBox}
                                            selectedNodeBounds={selectedNodeBounds}
                                            alignmentGuides={alignmentGuides}
                                        />
                                    }
                                    onViewportChange={handleViewportChange}
                                    onViewportPreviewChange={handleViewportPreviewChange}
                                    onCanvasMouseDown={handleCanvasMouseDown}
                                    boxSelectEnabled={canvasTool === "box-select"}
                                    onCanvasDoubleClick={handleCanvasDoubleClick}
                                    onCanvasDeselect={deselectCanvas}
                                    onContextMenu={handleCanvasContextMenu}
                                    onDrop={handleDrop}
                                    onFileDragEnter={handleFileDragEnter}
                                    onFileDragLeave={handleFileDragLeave}
                                    onFileDragOver={handleFileDragOver}
                                >
                                    <CanvasNodeActionContext.Provider value={canvasNodeActions}>
                                            <CanvasProjectWorldLayers
                                                productionRuns={productionAgentRuns.runs}
                                                productionBusy={productionAgentRuns.busy}
                                                onGeneratePlanAssets={(id) => setInfoNodeId(id)}
                                                shotBindings={shotProjection.bindings}
                                                originalNodeIds={shotProjection.originalNodeIds}
                                                onOriginalNodeView={shotProjection.setOriginalView}
                                                onRefreshShot={shotProjection.refresh}
                                                connectionApproach={connectionApproach}
                                                projectId={projectId}
                                                viewportScale={viewport.k}
                                                connectionLayerBounds={connectionLayerBounds}
                                                displayConnections={visibleDisplayConnections}
                                                connectionPolicy={canvasConnectionPolicy}
                                                selectedConnectionId={selectedConnectionId}
                                                relatedConnectionIds={relatedHighlight.connectionIds}
                                                scriptScrollTopById={scriptScrollTopById}
                                                connectingParams={connectingParams}
                                                mouseWorld={mouseWorld}
                                                connectionTargetNodeId={connectionTargetNodeId}
                                                nodeById={nodeById}
                                                visibleNodes={visibleNodes}
                                                viewportNodeIds={viewportNodeIds}
                                                upstreamNodesById={upstreamNodesById}
                                                nodeRenderLODById={nodeRenderLODById}
                                                nodeStackOrder={nodeStackOrder}
                                                frameChildrenById={frameChildrenById}
                                                linkedFolderPreviewNodesById={linkedFolderPreviewNodesById}
                                                dragPreview={dragPreview}
                                                selectedNodeIds={selectedNodeIds}
                                                frameDropTargetId={frameDropTargetId}
                                                relatedNodeIds={relatedHighlight.nodeIds}
                                                activeNodeId={activeNodeId}
                                                selectionBox={selectionBox}
                                                batchChildCountById={batchChildCountById}
                                                collapsingBatchIds={collapsingBatchIds}
                                                openingBatchIds={openingBatchIds}
                                                batchMotionById={batchMotionById}
                                                showImageInfo={showImageInfo}
                                                reduceMediaEffects={reduceMediaEffects}
                                                resourceReferenceByNodeId={resourceReferenceByNodeId}
                                                mentionReferencesByNodeId={mentionReferencesByNodeId}
                                                mediaEffectsDisabledNodeId={emotionNodeId}
                                                selectedNodeBounds={selectedNodeBounds}
                                                batchSourceNodeIds={batchSourceNodeIds}
                                                batchConnectionPreview={batchConnectionPreview}
                                                isNodeDragging={isNodeDragging}
                                                selectionBoundsElementRef={selectionBoundsElementRef}
                                                renderCanvasNodeContentById={renderCanvasNodeContentById}
                                                onConnectionSelect={(connectionId) => {
                                                    setSelectedConnectionId(connectionId);
                                                    const selection = new Set<string>(); selectedNodeIdsRef.current = selection; setSelectedNodeIds(selection);
                                                    setContextMenu(null);
                                                }}
                                                onConnectionContextMenu={(event, connectionId) => {
                                                    setSelectedConnectionId(connectionId);
                                                    const selection = new Set<string>(); selectedNodeIdsRef.current = selection; setSelectedNodeIds(selection);
                                                    closeConnectionCreateMenu();
                                                    setContextMenu({ type: "connection", x: event.clientX, y: event.clientY, connectionId });
                                                }}
                                                onNodeMouseDown={handleNodeMouseDown}
                                                onNodeHoverStart={handleCanvasNodeHoverStart}
                                                onNodeHoverEnd={handleCanvasNodeHoverEnd}
                                                onConnectStart={handleConnectStart}
                                                onNodeResize={handleNodeResize}
                                                onFrameResizeGesture={handleFrameResizeGesture}
                                                onToggleFrame={handleFrameToggle}
                                                onFolderStyleChange={handleFolderStyleChange}
                                                onFolderThemeChange={handleFolderThemeChange}
                                                onNodeTitleChange={handleNodeTitleChange}
                                                onNodeContextMenu={handleNodeContextMenu}
                                                onNodeContentChange={handleNodeContentChange}
                                                onToggleBatch={toggleBatchExpanded}
                                                onSetBatchPrimary={setBatchPrimary}
                                                onRetry={retryCanvasNode}
                                                onReloadResource={reloadCanvasNodeResource}
                                                onRetryFailed={retryFailedFrameNodes}
                                                onOpenInfo={(node) => (node.metadata?.workflowKind === "character" && node.metadata.characterAssetId ? openTextNodeEditor(node) : setInfoNodeId(node.id))}
                                                onOpenTaskDetails={openCanvasNodeTaskDetails}
                                                onCancelTask={cancelCanvasNodeTask}
                                                onOpenVersions={openCanvasNodeVersions}
                                                onViewImage={viewCanvasNodeImage}
                                                onMaskEdit={maskEditCanvasNodeImage}
                                                onReplaceMedia={replaceCanvasNodeMedia}
                                                onOpenTextEditor={openTextNodeEditor}
                                                onOpenDirector={editCanvasDirector}
                                                onOpenDrawing={openDrawingNode}
                                                onStartBatchConnection={startBatchConnection}
                                            />
                                    </CanvasNodeActionContext.Provider>
                                </InfiniteCanvas>

                                <CanvasActiveTaskPanel tasks={activeTasks} agentRuns={productionAgentRuns.runs} nodes={nodes} onOpenNode={setInfoNodeId} onCancelTask={cancelCanvasTask} workflowSubmitting={workflowGeneration.submitting} onCancelWorkflowSubmission={workflowGeneration.cancel} topInset={focusMode ? "var(--space-3)" : "var(--canvas-topbar-offset)"} />

                                {focusMode ? (
                                    <CanvasFocusModeBar
                                        onOpenGlobalSettings={() => setGlobalSettingsOpen(true)}
                                        onOpenProjectAssociation={shortDramaEnabled ? () => setProjectAssociationOpen(true) : undefined}
                                        shortDramaGuide={shortDramaGuide}
                                        syncStatus={<CanvasSyncStatus projectId={projectId} onLoadLatest={reloadLatestCanvasProject} onOpenVersions={openVersions} />}
                                        versionsOpen={versions.open}
                                        onToggleVersions={() => { closeAgent(); versions.toggle(); }}
                                        dockRevealed={focusDockRevealed}
                                        zoomPercent={viewport.k}
                                        onToggleDock={() => setFocusDockRevealed((value) => !value)}
                                        onExit={exitFocusMode}
                                        onZoomIn={zoomCanvasIn}
                                        onZoomOut={zoomCanvasOut}
                                        onFit={fitCanvasContent}
                                    />
                                ) : null}

                                <CanvasFileDropOverlay active={fileDropActive} theme={theme} />

                                {emptyCanvasState}

                                {!focusMode || focusDockRevealed ? (
                                    <CanvasToolbar
                                        selectedCount={selectedNodeIds.size}
                                        workspaceMode={workspaceMode}
                                        canvasTool={canvasTool}
                                        onToolChange={setCanvasTool}
                                        isProjectLinked={Boolean(shortDramaEnabled && currentProject?.projectId)}
                                        canUndo={historyState.canUndo}
                                        canRedo={historyState.canRedo}
                                        appearance={canvasAppearance}
                                        backgroundMode={backgroundMode}
                                        showImageInfo={showImageInfo}
                                        onAddImage={() => createNode(CanvasNodeType.Image)}
                                        onAddVideo={() => createNode(CanvasNodeType.Video)}
                                        onAddAudio={() => createNode(CanvasNodeType.Audio)}
                                        onAddText={() => createNode(CanvasNodeType.Text)}
                                        onChooseStyle={() => setStylePickerOpen(true)}
                                        onAddScript={() => createNode(CanvasNodeType.Script)}
                                        onAddFrame={() => createNode(CanvasNodeType.Frame)}
                                        onAddFolder={createFolder}
                                        onAddDrawing={() => createNode(CanvasNodeType.Drawing)}
                                        onAddExtensionNode={(type) => createNode(type)}
                                        onAddWorkflow={() => createNode(CanvasNodeType.Config)}
                                        onOpenDirector={() => setDirectorTemplateRequest({})}
                                        onUndo={undoCanvas}
                                        onRedo={redoCanvas}
                                        onUpload={() => handleUploadRequest()}
                                        onDelete={() => deleteNodes(new Set(selectedNodeIds))}
                                        onClear={() => setClearConfirmOpen(true)}
                                        onDeselect={deselectCanvas}
                                        onAppearanceChange={applyCanvasAppearance}
                                        onSaveAppearanceDefault={saveCanvasAppearanceDefault}
                                        onBackgroundModeChange={setBackgroundMode}
                                        onShowImageInfoChange={setShowImageInfo}
                                        onOpenWorkspace={() => setWorkspaceOpen(value => !value)}
                                        onOpenMyAssets={() => {
                                            openCanvasAssetLibrary();
                                        }}
                                        onOpenProjectCharacters={() => openProjectAssets("character")}
                                    />
                                ) : null}
                            </div>

                            <div className={versions.open ? "hidden" : "contents"}>
                            <CanvasCloudAgentPanel canvasId={projectId} domainProjectId={currentProject?.projectId} canvasNodes={nodes} runningNodeId={runningNodeId} nodeCount={nodes.length} selectedNodeIds={Array.from(selectedNodeIds)} references={agentMentionReferences} prefillPrompt={agentPrefillPrompt} open={assistantOpen} onOpen={openAgent} onCollapse={closeAgent} onFocusNode={(nodeId) => {
                                const currentNodes = nodesRef.current;
                                const target = currentNodes.find((node) => node.id === nodeId);
                                if (!target) { message.info("该节点已删除或尚未同步到画布"); return; }

                                const parent = target.parentId ? currentNodes.find((node) => node.id === target.parentId) : null;
                                if (parent?.metadata?.frame?.collapsed) toggleFrameCollapsed(parent.id);

                                const batchRootId = target.metadata?.batchRootId;
                                const batchRoot = batchRootId ? currentNodes.find((node) => node.id === batchRootId) : null;
                                if (batchRoot && isHiddenBatchChild(target, currentNodes) && !batchRoot.metadata?.imageBatchExpanded) toggleBatchExpanded(batchRoot.id);

                                focusCanvasNode(nodeId);
                            }} />
                            </div>
                        </div>

                        {angleNode?.metadata?.content ? (
                            <CanvasNodePanelOverlay
                                node={angleNode}
                                viewport={viewport}
                                containerRef={containerRef}
                                panelWidth={640}
                                panelHeight={540}
                                allowOverflow
                                dragOffset={dragPreview?.nodeIds.has(angleNode.id) ? { x: dragPreview.x, y: dragPreview.y } : null}
                                isDragging={isNodeDragging && Boolean(dragPreview?.nodeIds.has(angleNode.id))}
                            >
                                <CanvasNodeAnglePanel
                                    dataUrl={angleNode.metadata.content}
                                    onClose={() => setAngleNodeId(null)}
                                    onConfirm={(params) => {
                                        void generateAngleNode(angleNode, params);
                                    }}
                                />
                            </CanvasNodePanelOverlay>
                        ) : null}

                        {lightingNode?.metadata?.content ? (
                            <AppModal flush open centered title={null} closable={false} footer={null} width={720} onCancel={() => setLightingNodeId(null)}>
                                <CanvasNodeLightingPanel
                                    dataUrl={lightingNode.metadata.content}
                                    onClose={() => setLightingNodeId(null)}
                                    onConfirm={(options, prompt) => {
                                        generateLightingNode(lightingNode, options, prompt);
                                    }}
                                />
                            </AppModal>
                        ) : null}

                        {emotionNode?.metadata?.content && !isCanvasNodeMoving ? (
                            <CanvasEmotionWorkspace
                                node={emotionNode}
                                viewport={viewport}
                                containerRef={containerRef}
                                dragOffset={dragPreview?.nodeIds.has(emotionNode.id) ? { x: dragPreview.x, y: dragPreview.y } : null}
                                isDragging={isNodeDragging && Boolean(dragPreview?.nodeIds.has(emotionNode.id))}
                                onClose={() => setEmotionNodeId(null)}
                                onConfirm={(payload: CanvasImageEmotionPayload) => {
                                    void generateEmotionNode(emotionNode, payload);
                                }}
                            />
                        ) : null}

                        {dialogNode &&
                        !isShotProjectionActive(dialogNode.id) &&
                        !dialogNode.metadata?.storyDevelopment &&
                        !dialogNode.metadata?.shortDrama &&
                        !isCanvasImageSourceNode(dialogNode) &&
                        !dialogNode.metadata?.fileUpload &&
                        dialogNode.type !== CanvasNodeType.Script &&
                        dialogNode.type !== CanvasNodeType.BatchTable &&
                        dialogNode.type !== CanvasNodeType.Drawing &&
                        dialogNode.type !== CanvasNodeType.Panorama &&
                        !selectionBox &&
                        !isCanvasNodeMoving ? (
                            <CanvasNodePanelOverlay
                                node={dialogNode}
                                viewport={viewport}
                                containerRef={containerRef}
                                scaleWithNode
                                allowOverflow={dialogNode.type !== CanvasNodeType.Config}
                                dragOffset={dragPreview?.nodeIds.has(dialogNode.id) ? { x: dragPreview.x, y: dragPreview.y } : null}
                                isDragging={isNodeDragging && Boolean(dragPreview?.nodeIds.has(dialogNode.id))}
                            >
                                {renderCanvasNodePanel(dialogNode)}
                            </CanvasNodePanelOverlay>
                        ) : null}

                        {pendingConnectionCreate ? (
                            <CanvasConnectionCreateMenu
                                pending={pendingConnectionCreate}
                                viewport={viewport}
                                viewportSize={size}
                                containerRef={containerRef}
                                canCreateDrawing={canCreateDrawingFromConnection}
                                getDisabledReason={(type) => getConnectionCreateDisabledReason(type, pendingConnectionCreate)}
                                onCreate={(type) => void createConnectedNode(type, pendingConnectionCreate)}
                                onClose={cancelPendingConnectionCreate}
                            />
                        ) : null}

                        {connectionReplaceHover ? (
                            <div
                                className="pointer-events-none fixed z-[var(--z-dialog-popover)] flex select-none items-center gap-1.5 rounded-full border border-white/15 bg-black/60 px-2.5 py-1 text-[11px] font-medium text-white/90 shadow-[0_8px_24px_rgba(0,0,0,0.4)] backdrop-blur-md transition-all"
                                style={{
                                    left: connectionReplaceHover.clientX + 14,
                                    top: connectionReplaceHover.clientY + 14,
                                    transform: "translateY(-50%)",
                                }}
                            >
                                <ArrowLeftRight className="size-3 text-blue-400" />
                                <span>松开替换</span>
                                <span className="rounded bg-white/15 px-1.5 py-0.5 text-[10px] font-semibold text-blue-200">@{connectionReplaceHover.referenceLabel}</span>
                            </div>
                        ) : null}

                        {selectedNodeBounds && !selectionBox && !isCanvasNodeMoving ? (
                            <CanvasProjectSelectionToolbar
                                anchorRef={selectionBoundsElementRef}
                                containerRef={containerRef}
                                count={selectedNodeBounds.count}
                                selectedVideoCount={selectedVideoNodes.length}
                                mergingVideos={Boolean(mergeVideoProgress)}
                                onAlign={alignSelectedNodes}
                                onArrange={arrangeSelectedNodes}
                                onCreateStoryboard={createStoryboardGroup}
                                onCreateReferenceGroup={createReferenceGroup}
                                onBatchConnect={() => beginBatchConnectionMode(Array.from(selectedNodeIds))}
                                onMergeVideos={() => void mergeSelectedVideos()}
                                onSendSelectionToAgent={() => sendSelectionToAgent()}
                            />
                        ) : null}

                        {uploadStatus ? <CanvasUploadStatusToast status={uploadStatus} theme={theme} /> : null}
                        {mergeVideoProgress ? <CanvasMergeStatusToast progress={mergeVideoProgress} theme={theme} /> : null}
                        {lastAgentChange ? (
                            <CanvasOperationChangeToast
                                change={lastAgentChange}
                                theme={theme}
                                onView={viewLastAgentChange}
                                onUndo={() => {
                                    undoAgentOps();
                                }}
                                onClose={dismissLastAgentChange}
                            />
                        ) : null}

                        <CanvasNodeToolbar
                            node={isCanvasNodeMoving || nodeImageSettingsOpen || emotionNodeId || angleNodeId || (dialogNode || toolbarNode)?.metadata?.storyDevelopment || (dialogNode || toolbarNode)?.metadata?.shortDrama || isShotProjectionActive((dialogNode || toolbarNode)?.id || "") ? null : dialogNode || toolbarNode}
                            scaleWithNode
                            panelOpen={Boolean(dialogNode)}
                            workspaceMode={workspaceMode}
                            hideInlineActions
                            viewport={viewport}
                            containerRef={containerRef}
                            onKeep={keepNodeToolbar}
                            onLeave={hideNodeToolbar}
                            onInfo={(node) => (node.metadata?.workflowKind === "character" && node.metadata.characterAssetId ? openTextNodeEditor(node) : setInfoNodeId(node.id))}
                            onEditText={openTextNodeEditor}
                            onDecreaseFont={(node) => handleFontSizeChange(node.id, Math.max(10, (node.metadata?.fontSize || 14) - 2))}
                            onIncreaseFont={(node) => handleFontSizeChange(node.id, Math.min(32, (node.metadata?.fontSize || 14) + 2))}
                            onToggleDialog={(node) => setDialogNodeId((current) => (current === node.id ? null : node.id))}
                            onGenerateImage={generateImageFromTextNode}
                            onBatchGenerateImages={openTextAssetBatchGeneration}
                            onUpload={(node) => handleUploadRequest(node.id)}
                            onDownload={downloadNodeImage}
                            onSaveAsset={(node) => void saveNodeAsset(node)}
                            onAnnotate={(node) => setAnnotationNodeId(node.id)}
                            onAnnotationEdit={openAnnotationEditNode}
                            onMaskEdit={(node) => setMaskEditNodeId(node.id)}
                            onRemoveBackground={openBackgroundRemoval}
                            onLayerDecomposition={openLayerDecomposition}
                            onTextEdit={openTextEditNode}
                            onEmotion={(node) => {
                                setDialogNodeId(null);
                                setEmotionNodeId((current) => (current === node.id ? null : node.id));
                            }}
                            onPortraitTexture={openPortraitTextureEditor}
                            onCrop={(node) => setCropNodeId(node.id)}
                            onSplit={(node, params) => void splitImageNode(node, params)}
                            onUpscale={(node) => setUpscaleNodeId(node.id)}
                            onSuperResolve={(node) => setSuperResolveNodeId(node.id)}
                            onAngle={(node) => {
                                setDialogNodeId(null);
                                setAngleNodeId((current) => (current === node.id ? null : node.id));
                            }}
                            onLighting={(node) => {
                                setDialogNodeId(null);
                                setLightingNodeId((current) => (current === node.id ? null : node.id));
                            }}
                            onPanorama={openPanoramaConfig}
                            onViewImage={(node) => setPreviewNodeId(node.id)}
                            onExtractVideoFrames={openVideoFrameExtractor}
                            onExtractAudioFromVideo={(node) => void extractAudioFromVideo(node)}
                            onTrimVideoSegments={openVideoSegmentExtractor}
                            onSubtitles={(node) => setSubtitleNodeId(node.id)}
                            onTimeline={(node) => setTimelineNodeId(node.id)}
                            extractingVideoFrames={toolbarNode?.id === extractingVideoFramesNodeId}
                            extractingAudio={segmentRunningMode === "audio"}
                            trimmingVideo={segmentRunningMode === "video"}
                            onNineGrid={(node, id, label, icon) => void generateNineGridNode(node, id, label, icon)}
                            onReversePrompt={createImageReversePromptNodes}
                            onRetry={retryCanvasNode}
                            onToggleFreeResize={(node) => toggleNodeFreeResize(node.id)}
                            onToggleLocked={(node) => toggleNodeLocked(node.id)}
                            onDelete={(node) => deleteNodes(new Set([node.id]))}
                        />

{isMiniMapOpen && !focusMode ? <Minimap nodes={nodes} viewport={viewport} viewportSize={size} canvasContainerRef={containerRef} onViewportPreviewChange={previewViewport} onViewportChange={handleViewportChange} /> : null}

                        {!focusMode ? (
                            <CanvasOverlayLayerContainer
                                overlayId="asset-tray"
                                fallbackZIndex="var(--z-panel)"
                                className="canvas-workspace-zoom-controls absolute bottom-[calc(var(--canvas-inset-y)+var(--space-16))] left-[var(--canvas-inset-x)] flex items-end gap-2 lg:bottom-[var(--canvas-inset-y)]"
                                onMouseDown={(event) => event.stopPropagation()}
                                onPointerDown={(event) => event.stopPropagation()}
                                onWheel={(event) => event.stopPropagation()}
                            >
                                <CanvasZoomControls
                                    scale={viewport.k}
                                    containerRef={containerRef}
                                    onScaleChange={setZoomScale}
                                    onFitContent={fitCanvasContent}
                                    onAutoArrange={autoArrangeCanvasNodes}
                                    isMiniMapOpen={isMiniMapOpen}
                                    onToggleMiniMap={() => setIsMiniMapOpen((value) => !value)}
                                    onOpenShortcuts={() => setShortcutRequestNonce((value) => value + 1)}
                                />
                            </CanvasOverlayLayerContainer>
                        ) : null}

                        <CanvasProjectContextMenu
                            menu={contextMenu}
                            node={contextMenuNode}
                            workflowActions={(() => {
                                if (!contextMenu || contextMenu.type === "connection") return [];
                                const groupSelection = (ids: string[], targetId?: string) => {
                                    void workflowGeneration.groupEpisodes(ids, targetId).then((id) => {
                                        if (!id || !nodesRef.current.some((node) => node.id === id)) return;
                                        const selected = new Set([id]); selectedNodeIdsRef.current = selected; setSelectedNodeIds(selected);
                                    });
                                };
                                const selection = [...selectedNodeIds];
                                const selectionActions = (ids: string[]) => [
                                    { label: "将所选节点归入阶段容器", run: () => groupSelection(ids) },
                                    ...nodes.filter((node) => node.type === CanvasNodeType.Frame && !workflowGroupingProblem(ids, nodes, node.id)).map((node) => ({ label: `加入容器：${node.title}`, run: () => groupSelection(ids, node.id) })),
                                ];
                                if ((contextMenu.type === "canvas" || (selection.length > 1 && contextMenuNode?.type !== CanvasNodeType.Frame)) && selection.some((id) => nodeWorkflow(nodes.find((node) => node.id === id))?.episodeNumber)) return selectionActions(selection);
                                const data = nodeWorkflow(contextMenuNode || undefined);
                                if (!data && contextMenuNode?.type === CanvasNodeType.Frame) {
                                    const members = nodes.filter((node) => node.parentId === contextMenuNode.id).map((node) => node.id);
                                    if (members.length && !workflowGroupingProblem(members, nodes, contextMenuNode.id)) return [{ label: "识别为阶段容器", run: () => groupSelection(members, contextMenuNode.id) }];
                                }
                                if (!data || !contextMenuNode) return [];
                                const anchorId = contextMenuNode.id;
                                if (data.step === ShortDramaStep.Reconcile) return [{ label: "正文质量审核（替代旧资产校核）", run: () => openWorkflowGenerator(ShortDramaStep.Audit, anchorId) }];
                                const planOwner = data.role === "collection" ? contextMenuNode : nodes.find(node => node.id === contextMenuNode.parentId);
                                const planTargetId = data.assetKey === "$summary" ? anchorId : (data.assetGroup?.manifestId || nodeWorkflow(planOwner)?.assetGroup?.manifestId);
                                const planRun = productionAgentRuns.runs.find(run => run.production?.targetNodeId === planTargetId && run.production?.workKind === "plan");
                                const categoryIcons = { [PlannedAssetKind.Character]: Users, [PlannedAssetKind.Environment]: MapPin, [PlannedAssetKind.Prop]: Package, [PlannedAssetKind.Sound]: AudioLines, [PlannedAssetKind.Special]: Sparkles };
                                const planSelectionActions = data.step === ShortDramaStep.Plan && planTargetId ? [
                                    ...(planRun && productionPlanInventoryRecoveryAvailable(planRun) ? [{ label: "重新生成资产总表", detail: "当前资产总表为 0 项；重建清单后即可选择并生成资产", disabled: productionAgentRuns.busy[planTargetId] || !["completed", "failed", "cancelled", "waiting_user"].includes(planRun.status) && !planRun.production?.paused, run: () => {
                                        void productionAgentRuns.control(planTargetId, "generate_plans", undefined, undefined, ["inventory"]).then(result => {
                                            if (result?.error) message.error(result.error);
                                            else if (result?.success) message.success("已启动资产总表重建");
                                        });
                                    } }] : []),
                                    ...(data.role === "collection" && planRun?.production?.planReady && !planRun.production.plansStarted ? [{ label: "创作其余制作方案", detail: "资产总表、视觉与美术、导演与视听、生成与一致性规范将作为独立任务并发生成", disabled: productionAgentRuns.busy[planTargetId] || !["completed", "failed"].includes(planRun.status), run: () => {
                                        void productionAgentRuns.control(planTargetId, "generate_plans", undefined, undefined, ["inventory", "visual", "direction", "generation"]).then(result => {
                                            if (result?.error) message.error(result.error);
                                            else if (result?.success) message.success("已并发启动其余独立制作方案");
                                        });
                                    } }] : []),
                                    ...productionPlanAssetMenu(planRun, productionAgentRuns.busy[planTargetId]).map(action => {
                                        const Icon = categoryIcons[action.kind];
                                        return { label: action.label, detail: action.detail, icon: <Icon />, disabled: action.disabled, run: () => {
                                            setContextMenu(null);
                                            const textModels = selectableModelsByCapability(effectiveConfig, "text");
                                            const preferredModel = effectiveConfig.textModel || effectiveConfig.model;
                                            const model = textModels.includes(preferredModel) ? preferredModel : textModels[0] || "";
                                              setAssetModelDialog({ targetId: planTargetId, kinds: action.kinds, label: action.label, model, reasoningEffort: normalizeReasoningEffort(effectiveConfig.textReasoningEffort), instruction: "", continueAppend: false });
                                        } };
                                    }),
                                    ...(!planRun || productionAgentRuns.readErrors[planTargetId] ? [{ label: "刷新资产状态", detail: productionAgentRuns.readErrors[planTargetId], run: productionAgentRuns.refresh }] : []),
                                ] : [];
                                const assetActions = workflowAssetActions(contextMenuNode);
                                if (assetActions) {
                                    let ready = true;
                                    try { workflowAssetRevisionMembers(contextMenuNode, nodes); } catch { ready = false; }
                                    return [
                                        ...planSelectionActions,
                                        { label: "重做另一版", disabled: !ready || workflowGeneration.submitting, run: () => { setContextMenu(null); setWorkflowGenerator({ step: assetActions.step, pipelineId: data.pipelineId, anchorId, assetRevisionSourceId: anchorId }); } },
                                        ...(assetActions.imageStep ? [{ label: "生图", disabled: workflowGeneration.submitting || (data.role !== "collection" && !ready), run: () => openWorkflowGenerator(assetActions.imageStep!, anchorId) }] : []),
                                        ...(assetActions.audioStep ? [{ label: "生成试听", disabled: workflowGeneration.submitting || (data.role !== "collection" && !ready), run: () => openWorkflowGenerator(assetActions.audioStep!, anchorId) }] : []),
                                    ];
                                }
                                const stepDefinition = shortDramaStep(data.step);
                                const emptyManifest = emptyWorkflowAssetManifest(nodes, anchorId);
                                const bibleParent = nodes.find((node) => node.id === contextMenuNode.parentId && nodeWorkflow(node)?.assetGroup?.kind === "bible");
                                const supportingDocument = data.role !== "collection" && Boolean(data.planSection || data.bibleSection || bibleParent || (data.step === ShortDramaStep.Plan && data.assetKey));
                                const reportNode = data.screenplayAudit ? contextMenuNode : data.step === ShortDramaStep.Body && data.role === "document" ? latestBodyAudit(contextMenuNode, nodes) : undefined;
                                const auditState = screenplayAuditState(reportNode, nodes, currentProject?.globalSettings);
                                return [
                                    ...planSelectionActions,
                                    ...(reportNode ? [{ label: "查看正文诊断报告", run: () => { setContextMenu(null); setScreenplayAuditDetailId(reportNode.id); } }] : []),
                                    ...(reportNode && auditState.report?.findings.length && !auditState.stale ? [{ label: "依据诊断修复正文（保留原稿）", disabled: workflowGeneration.submitting, run: () => openScreenplayRepair(reportNode.id) }] : []),
                                    ...(emptyManifest?.metadata?.taskId ? [{ label: "重新提取空资产分组", disabled: emptyManifest.metadata.status === "loading", run: () => retryCanvasNode(emptyManifest) }] : []),
                                    ...(data.assetGroup?.kind === "bible" || bibleParent ? [{ label: "查看制作规范", run: () => setAssetReviewId(bibleParent?.id || anchorId) }] : []),
                                    ...(data.assetKey && data.assetKey !== "$summary" && !supportingDocument ? [{ label: "资产资料与参考", run: () => setAssetReviewId(anchorId) }] : []),
                                    ...(data.episodeNumber && !data.mediaKind && !contextMenuNode.parentId ? [{ label: "整理同源分集为容器", run: () => void workflowGeneration.groupEpisodes(anchorId) }] : []),
                                    ...(data.episodeNumber && !contextMenuNode.parentId ? nodes.filter((node) => node.type === CanvasNodeType.Frame && !workflowGroupingProblem([anchorId], nodes, node.id)).map((node) => ({ label: `加入容器：${node.title}`, run: () => groupSelection([anchorId], node.id) })) : []),
                                    ...(data.role === "collection" && nodes.some((node) => data.sourceNodeIds.includes(node.id) && node.metadata?.shortDrama?.submission === "planned") ? [{ label: "继续提交未开始的任务", disabled: workflowGeneration.submitting, run: () => void workflowGeneration.resume(anchorId) }] : []),
                                    ...(data.role === "collection" && data.step === ShortDramaStep.Body ? (() => {
                                        const bodyProgress = workflowEpisodeProgress(nodes, data.pipelineId, undefined, anchorId, connections);
                                        return bodyProgress.missing > 0 || bodyProgress.failed > 0 || bodyProgress.pending > 0
                                            ? [{ label: `继续生成正文（从第 ${bodyProgress.next} 集起，默认追加 10 集）`, disabled: workflowGeneration.submitting, run: () => { setContextMenu(null); setWorkflowGenerator({ step: ShortDramaStep.Body, pipelineId: data.pipelineId, anchorId, continueGeneration: true }); } }]
                                            : [];
                                    })() : []),
                                    ...(data.mediaGroup ? [{ label: "追加生成图片", disabled: workflowGeneration.submitting, run: () => openWorkflowGenerator(data.step, data.mediaGroup!.sourceNodeId) }] : []),
                                    ...(data.mediaGroup ? [{ label: "整理图片排列", run: () => setNodes((current) => layoutWorkflowImageGroups(current, new Set([anchorId]))) }] : []),
                                    ...(data.role === "collection" && !data.assetGroup && !data.mediaGroup && data.step !== ShortDramaStep.Audit && data.step !== ShortDramaStep.Body && data.step !== ShortDramaStep.Extract ? [{ label: "汇总分集文稿", run: () => setWorkflowGenerator({ step: data.step, pipelineId: data.pipelineId, anchorId, aggregate: true }) }] : []),
                                    ...(data.step === ShortDramaStep.Plan && data.role === "document" && data.planSection === "story" ? [{ label: "创作其余制作方案", disabled: !planRun?.production?.planReady || Boolean(planRun?.production?.plansStarted) || workflowGeneration.submitting, run: () => {
                                        if (planTargetId) void productionAgentRuns.control(planTargetId, "generate_plans", undefined, undefined, ["inventory", "visual", "direction", "generation"]).then(result => {
                                            if (result?.error) message.error(result.error);
                                            else if (result?.success) message.success("已并发启动其余独立制作方案");
                                        });
                                    } }] : []),
                                    ...(data.assetGroup ? [{ label: `生成另一版${shortDramaStep(data.step)!.label}`, run: () => openWorkflowGenerator(data.step, anchorId) }] : []),
                                    ...(data.submission === "planned" ? [{ label: "继续提交此节点", disabled: workflowGeneration.submitting, run: () => void workflowGeneration.resume(anchorId) }] : []),
                                    ...(data.step !== ShortDramaStep.Topic && data.role !== "collection" && !supportingDocument ? [{ label: `生成另一版${shortDramaStep(data.step)!.label}`, run: () => data.aggregate ? setWorkflowGenerator({ step: data.step, pipelineId: data.pipelineId, anchorId: data.sourceNodeIds[0], aggregate: true }) : openWorkflowGenerator(data.step, anchorId) }] : []),
                                    ...(stepDefinition?.mediaOutput === "image" && contextMenuNode.type === CanvasNodeType.Text && data.role !== "collection" && Boolean(contextMenuNode.metadata?.content?.trim()) ? [{ label: stepDefinition.mediaActionLabel || "根据当前资产生成图片", disabled: contextMenuNode.metadata?.status === "loading", run: () => generateImageFromTextNode(contextMenuNode) }] : []),
                                    ...(supportingDocument ? [] : nextShortDramaStepGroups(data.step)).map((group) => ({ label: `下一步：${group.label}`, disabled: data.role !== "collection" && (!contextMenuNode.metadata?.content?.trim() || contextMenuNode.metadata?.status === "loading" || contextMenuNode.metadata?.status === "error"), run: () => openWorkflowGenerator(group.entryStepId, anchorId, [...group.stepIds]) })),
                                ];
                            })()}
                            workspaceMode={workspaceMode}
                            isProjectLinked={Boolean(currentProject?.projectId)}
                            canUndo={historyState.canUndo}
                            canRedo={historyState.canRedo}
                            canPaste={hasCopiedNodes || Boolean(navigator.clipboard)}
                            selectedCount={selectedNodeIds.size}
                            screenToCanvas={screenToCanvas}
                            onClose={() => setContextMenu(null)}
                            onAddNode={(type, position) => createNode(type, position)}
                            onAddFolder={createFolder}
                            onChooseStyle={() => setStylePickerOpen(true)}
                            onOpenDirector={(position) => setDirectorTemplateRequest({ position })}
                            onUpload={(nodeId, position) => handleUploadRequest(nodeId, position)}
                            onOpenAssets={openCanvasAssetLibrary}
                            onOpenProjectCharacters={(position) => openProjectAssets("character", position)}
                            onUndo={undoCanvas}
                            onRedo={redoCanvas}
                            onPaste={pasteAtPosition}
                            onCopyNode={(nodeId) => copyNodesToClipboard(new Set([nodeId]))}
                            onCreateGenerationCopy={(nodeId) => duplicateNode(nodeId, "copy")}
                            onDuplicate={duplicateNode}
                            onDeleteNode={(nodeId) => deleteNodes(new Set([nodeId]))}
                            onDeleteConnection={deleteConnection}
                            onSaveAsset={(node) => {
                                void saveNodeAsset(node);
                            }}
                            onViewMedia={(node) => setPreviewNodeId(node.id)}
                            onEditText={openTextNodeEditor}
                            onOpenDrawing={openDrawingNode}
                            onGenerateImage={generateImageFromTextNode}
                            onBatchGenerateImages={openTextAssetBatchGeneration}
                            onCopyContent={(node) => {
                                void copyNodeContentToClipboard(node);
                            }}
                            onCopyMediaUrl={(node) => {
                                void copyNodeMediaUrlToClipboard(node);
                            }}
                            onUploadToArkPrivateAsset={confirmUploadNodeImageToArkPrivateAsset}
                            onSetAssetCategory={(nodeId, assetCategory) => handleConfigNodeChange(nodeId, { assetCategory })}
                            onToggleFrame={(node) => handleFrameToggle(node.id)}
                            onSpreadSelection={spreadSelectedNodes}
                            onCopySelection={copySelectedNodes}
                            onDeleteSelection={() => deleteNodes(selectedNodeIds)}
                            onSendToAgent={() => sendSelectionToAgent(contextMenu?.type === "node" && selectedNodeIds.size <= 1 ? contextMenu.nodeId : undefined)}
                        />

                        <CanvasUploadModal open={uploadModalOpen} onClose={closeUploadModal} onUpload={handleUploadFiles} />

                        <input ref={imageInputRef} type="file" accept="image/*,video/*,audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav" className="hidden" onChange={handleImageInputChange} />

                        <CanvasNodeInfoModal key={`${infoNode?.id}:${infoNode?.metadata?.shortDrama?.productionAgent?.runId || "pending"}`} node={infoNode} open={Boolean(infoNode)} onClose={() => setInfoNodeId(null)} onMetadataChange={handleConfigNodeChange}>
                            {infoNode?.type === CanvasNodeType.Frame ? <CanvasGroupTaskDetails key={infoNode.id} node={infoNode} nodes={nodes} submitting={workflowGeneration.submitting} onResume={(id) => void workflowGeneration.resume(id)} onContinueGeneration={(id) => { const target = nodesRef.current.find((entry) => entry.id === id); const targetData = nodeWorkflow(target); if (targetData) { setInfoNodeId(null); setWorkflowGenerator({ step: ShortDramaStep.Body, pipelineId: targetData.pipelineId, anchorId: id, continueGeneration: true }); } }} onRetry={retryCanvasNode} onCancel={cancelCanvasTask} agentState={productionAgentRuns} />
                                : infoNode?.metadata?.shortDrama?.productionAgent && infoNode.metadata.shortDrama.submission !== "planned" ? <CanvasProductionAgentDetails key={infoNode.id} node={infoNode} state={productionAgentRuns} />
                                : infoNode?.metadata?.taskId ? <CanvasGenerationTaskDetails key={infoNode.id} node={infoNode} onRetry={retryCanvasNode} onCancel={cancelCanvasTask} />
                                : infoNode?.metadata?.shortDrama ? <CanvasWorkflowTaskDetails node={infoNode} nodes={nodes} submitting={workflowGeneration.submitting} onResume={(id) => void workflowGeneration.resume(id)} onOpenTask={openCanvasNodeTaskDetails} /> : null}
                        </CanvasNodeInfoModal>

                        {subtitleNode ? (
                            <CanvasSubtitleDialog
                                node={subtitleNode}
                                open={Boolean(subtitleNode)}
                                projectId={projectId}
                                config={effectiveConfig}
                                onClose={() => setSubtitleNodeId(null)}
                                onSave={(nodeId, patch) => {
                                    handleConfigNodeChange(nodeId, patch);
                                    const currentTimeline = currentProject?.timeline;
                                    if (currentTimeline) {
                                        const next = syncNodeSubtitlesToTimeline(currentTimeline, nodeId, patch.subtitleEntries || []);
                                        if (next !== currentTimeline) updateProject(projectId, { timeline: next });
                                    }
                                }}
                            />
                        ) : null}

                        {frameNode ? <CanvasVideoFrameDialog node={frameNode} open={Boolean(frameNode)} onClose={closeFrameDialog} onConfirm={(params) => void extractVideoFrames(frameNode, params)} /> : null}

                        {segmentNode && segmentDialogMode ? (
                            <CanvasVideoSegmentDialog
                                node={segmentNode}
                                nodes={nodes}
                                connections={connections}
                                open={Boolean(segmentNode && segmentDialogMode)}
                                mode={segmentDialogMode}
                                config={effectiveConfig}
                                timeline={currentProject?.timeline || null}
                                onClose={closeSegmentDialog}
                                onConfirm={(params) => void handleSegmentConfirm(segmentNode, params)}
                            />
                        ) : null}

                        {timelineNode ? (
                            <CanvasTimelineDialog
                                node={timelineNode}
                                open={Boolean(timelineNode)}
                                nodes={nodes}
                                timeline={currentProject?.timeline || null}
                                onClose={() => setTimelineNodeId(null)}
                                onOpenSubtitleDialog={(subNodeId) => {
                                    setTimelineNodeId(null);
                                    setSubtitleNodeId(subNodeId);
                                }}
                                onSave={(next) => updateProject(projectId, { timeline: next })}
                                onSaveSubtitles={(subNodeId, entries) =>
                                    handleConfigNodeChange(subNodeId, {
                                        subtitleEntries: entries,
                                        ...(entries.length ? {} : { subtitleHighlights: [] }),
                                        subtitleUpdatedAt: new Date().toISOString(),
                                    })
                                }
                                onOpenAssetLibrary={openTimelineAssetLibrary}
                                onOpenProjectAssets={() => openProjectAssets("all", undefined, "timeline")}
                                onUploadLocalFiles={uploadTimelineMedia}
                                addNodeToTimelineRef={timelineAddNodeRef}
                                addMediaToTimelineRef={timelineMediaAddRef}
                                onCreateAssembledNode={createVideoNodeFromBlob}
                            />
                        ) : null}

                        <CanvasCharacterReferenceModal node={characterReferenceNode} open={Boolean(characterReferenceNode)} onClose={() => setCharacterReferenceNodeId(null)} />

                        {globalSettingsOpen && currentProject ? <CanvasGlobalSettingsDialog key={`global-settings:${projectId}`} editing title={currentProject.title} settings={currentProject.globalSettings} onClose={() => setGlobalSettingsOpen(false)} onSave={async (title, globalSettings) => {
                            if (getActiveUserScope() !== canvasStorageScope) throw new Error("账号已切换，请重新打开设定");
                            const { syncError } = await saveCanvasGlobalSettingsWithRemoteSync(projectId, title, globalSettings);
                            setGlobalSettingsOpen(false);
                            if (!syncError) message.success("全局设定已保存，将用于后续生成");
                            else message.warning("设定已更新到本地，云端保存待重试");
                        }} /> : null}
                        <Modal
                            title={`选择${assetModelDialog?.label.slice(2) || "资产"}生成模型`}
                            open={Boolean(assetModelDialog)}
                            okText="开始生成"
                            cancelText="取消"
                            confirmLoading={Boolean(assetModelDialog && productionAgentRuns.busy[assetModelDialog.targetId])}
                            okButtonProps={{ disabled: !assetModelDialog || !selectableModelsByCapability(effectiveConfig, "text").includes(assetModelDialog.model) }}
                            onCancel={() => { if (!assetModelDialog || !productionAgentRuns.busy[assetModelDialog.targetId]) setAssetModelDialog(null); }}
                            onOk={() => {
                                if (!assetModelDialog) return;
                                const model = modelOptionName(assetModelDialog.model);
                                const selectedConfig = { ...effectiveConfig, model: assetModelDialog.model };
                                const logicalModelId = logicalModelIDForConfig(selectedConfig);
                                const resolved = resolveModelRequestConfig(selectedConfig, assetModelDialog.model);
                                const modelSelection: ProductionAssetModelSelection = {
                                    ...(logicalModelId ? { logicalModelId } : { channelId: resolved.channelId, channelModelKey: model }),
                                    model,
                                    reasoningEffort: assetModelDialog.reasoningEffort,
                                    instruction: assetModelDialog.instruction.trim(),
                                    continueAppend: assetModelDialog.continueAppend,
                                };
                                if (!logicalModelId && !resolved.channelId) {
                                    message.error("请选择后端受管文本模型");
                                    return;
                                }
                                void productionAgentRuns.control(assetModelDialog.targetId, "generate_assets", undefined, undefined, undefined, modelSelection, assetModelDialog.kinds).then(result => {
                                    if (result?.error) message.error(result.error);
                                    else if (result?.success) {
                                        message.success(`已提交${assetModelDialog.label.slice(2)}生成任务，可在对应容器详情查看进度和重试`);
                                        setAssetModelDialog(null);
                                    }
                                });
                            }}
                        >
                            <div className="space-y-2 py-2">
                                <label className="block text-sm">文本模型</label>
                                <ModelPicker config={effectiveConfig} value={assetModelDialog?.model} capability="text" fullWidth placeholder="选择文本模型" onChange={model => setAssetModelDialog(current => current ? { ...current, model } : current)} />
                                <ReasoningEffortSelect value={assetModelDialog?.reasoningEffort} onChange={reasoningEffort => setAssetModelDialog(current => current ? { ...current, reasoningEffort } : current)} />
                                <Checkbox checked={assetModelDialog?.continueAppend || false} onChange={event => setAssetModelDialog(current => current ? { ...current, continueAppend: event.target.checked } : current)}>
                                    继续追加到当前资产生成批次
                                </Checkbox>
                                <label className="block text-sm" htmlFor="production-asset-instruction">补充要求</label>
                                <Input.TextArea id="production-asset-instruction" aria-label="补充要求" value={assetModelDialog?.instruction || ""} maxLength={2000} rows={4} placeholder="填写本次资产生成需要遵守的注意事项" onChange={event => setAssetModelDialog(current => current ? { ...current, instruction: event.target.value } : current)} />
                                <p className="text-xs text-neutral-500">模型、推理强度和补充要求会用于本次所选资产及其后续重试。</p>
                            </div>
                        </Modal>
                        {workflowGenerator ? <CanvasWorkflowGenerator key={`${projectId}:${workflowGenerator.step}:${workflowGenerator.anchorId || ""}:${currentProject?.globalSettings?.revision || 0}`} globalSettings={currentProject?.globalSettings} target={workflowGenerator} nodes={nodes} submitting={workflowGeneration.submitting} onGenerate={workflowGeneration.run} onClose={() => setWorkflowGenerator(null)} /> : null}
                        {screenplayAuditDetailId && nodes.some(node => node.id === screenplayAuditDetailId) ? <CanvasScreenplayAuditDetails node={nodes.find(node => node.id === screenplayAuditDetailId)!} nodes={nodes} settings={currentProject?.globalSettings} onClose={() => setScreenplayAuditDetailId(null)} onRepair={openScreenplayRepair} onRestore={restoreScreenplayBeforeRepair} onReaudit={bodyId => { setScreenplayAuditDetailId(null); openWorkflowGenerator(ShortDramaStep.Audit, bodyId); }} onBody={bodyId => { setScreenplayAuditDetailId(null); const body = nodesRef.current.find(node => node.id === bodyId); if (body) openTextNodeEditor(body); }} /> : null}
                        {assetReviewId && nodes.some((node) => node.id === assetReviewId) ? <CanvasWorkflowAssetReview key={`${projectId}:${assetReviewId}`} node={nodes.find((node) => node.id === assetReviewId)!} nodes={nodes} onClose={() => setAssetReviewId(null)} onEdit={openTextNodeEditor}
                            onSave={async (id, assetProfile, expected) => {
                                const current = nodesRef.current.find((node) => node.id === id);
                                if (!current || workflowSignature(current) !== expected) throw new Error("资产正文或资料已变化，请关闭后重新核对");
                                const variants = [];
                                for (const variant of assetProfile.variants) variants.push(variant.code ? variant : { ...variant, code: (await reserveProductionVariantCode(projectId, id)).code });
                                const latest = nodesRef.current.find(node => node.id === id);
                                if (getActiveUserScope() !== canvasStorageScope || !latest || workflowSignature(latest) !== expected) throw new Error("资产或账号已变化，未覆盖资料");
                                assetProfile = { ...assetProfile, variants };
                                handleConfigNodeChange(id, { shortDrama: { ...nodeWorkflow(current)!, assetProfile } });
                            }} /> : null}
                        {textEditorNode?.metadata?.storyDevelopment?.stage === "topic" ? <CanvasStoryDevelopmentEditor
                            key={`${projectId}:${textEditorNode.id}`}
                            canvasId={projectId}
                            globalSettings={currentProject?.globalSettings}
                            onSaveTopicSettings={async (patch) => {
                                if (getActiveUserScope() !== canvasStorageScope) throw new Error("账号已切换，请重新打开设定");
                                const latest = useCanvasStore.getState().openProject(projectId);
                                if (!latest?.globalSettings) throw new Error("画布或全局设定不存在，请重新打开画布");
                                if (!Object.keys(patch).length) return latest.globalSettings;
                                const settings = { ...latest.globalSettings, ...patch, revision: latest.globalSettings.revision + 1 };
                                const { syncError } = await saveCanvasGlobalSettingsWithRemoteSync(projectId, latest.title, settings);
                                if (syncError) throw new Error("选题设定已存本机，云端同步失败，请恢复网络后重试");
                                return settings;
                            }}
                            node={textEditorNode}
                            nodes={nodes}
                            onClose={() => setTextEditorNodeId(null)}
                            onPrepareBatch={async (start, count, excludedIds) => {
                                const prepared = prepareStoryEpisodeBatch(textEditorNode.id, nodesRef.current, connectionsRef.current, start, count, excludedIds);
                                nodesRef.current = prepared.nodes; connectionsRef.current = prepared.connections;
                                setNodes(prepared.nodes); setConnections(prepared.connections);
                                if (prepared.targets.length && !await saveCanvasProject({ requireRemote: true })) throw new Error("正文节点尚未保存到云端，未提交生成任务，请恢复保存后重试");
                                return prepared;
                            }}
                            onPersistBatch={() => saveCanvasProject({ requireRemote: true })}
                            onOpenEpisode={(nodeId) => {
                                if (!nodesRef.current.some((item) => item.id === nodeId)) { message.info("正文节点已删除"); return; }
                                focusCanvasNode(nodeId); setTextEditorNodeId(nodeId);
                            }}
                            onSave={(original, title, content, data) => {
                                const updated = saveStoryDevelopmentNode(nodesRef.current, original, title, content, data);
                                setNodes(updated);
                                return updated.find((item) => item.id === original.id)!;
                            }}
                            onNextEpisode={(nodeId) => {
                                const source = nodesRef.current.find((item) => item.id === nodeId);
                                if (!source?.metadata?.storyDevelopment) return;
                                try {
                                    const next = createNextStoryEpisode(source, nodesRef.current);
                                    setNodes([...nodesRef.current, next]);
                                    const fromNodeId = next.metadata!.storyDevelopment!.sourceNodeIds.at(-1);
                                    if (fromNodeId) setConnections((current) => [...current, { id: nanoid(), fromNodeId, toNodeId: next.id }]);
                                    focusCanvasNode(next.id);
                                    setTextEditorNodeId(next.id);
                                } catch (error) { message.info(error instanceof Error ? error.message : "无法创建正文节点"); }
                            }}
                            onNextStage={(nodeId) => {
                                openWorkflowGenerator(ShortDramaStep.Plan, nodeId);
                            }}
                        /> : <CanvasTextEditorModal
                            node={textEditorNode}
                            open={Boolean(textEditorNode)}
                            onClose={() => setTextEditorNodeId(null)}
                            onSave={(nodeId, title, content, richText) => {
                                const currentNode = nodesRef.current.find((node) => node.id === nodeId);
                                const original = textEditorOriginalRef.current;
                                if (nodeWorkflow(original || undefined) && (!currentNode || workflowSignature(currentNode) !== workflowSignature(original!))) throw new Error("节点已被其他操作修改，请保留当前文本并重新打开后合并");
                                setNodes((current) => current.map((node) => (node.id === nodeId ? { ...node, title, metadata: { ...node.metadata, content, richText: richText || undefined } } : node)));
                                textEditorOriginalRef.current = nodesRef.current.find((node) => node.id === nodeId) || null;
                            }}
                        />}

                        {drawingNode ? (
                            <Suspense
                                fallback={
                                    <div className="fixed inset-0 z-[var(--z-toast)] grid place-items-center px-5" style={{ background: theme.canvas.background, color: theme.node.text }}>
                                        <WorkspaceState icon="loading" title="正在加载绘图编辑器" description="正在准备绘图画布。" />
                                    </div>
                                }
                            >
                                <CanvasDrawingEditorModal
                                    node={drawingNode}
                                    projectId={projectId}
                                    open={Boolean(drawingNode)}
                                    onClose={() => setDrawingNodeId(null)}
                                    onSaved={(nodeId, summary) => {
                                        setNodes((current) =>
                                            current.map((node) =>
                                                node.id === nodeId
                                                    ? {
                                                          ...node,
                                                          metadata: {
                                                              ...node.metadata,
                                                              drawingEngine: summary.engine,
                                                              drawingRevision: summary.revision,
                                                              drawingUpdatedAt: summary.updatedAt,
                                                              drawingShapeCount: summary.shapeCount,
                                                              drawingPageCount: summary.pageCount,
                                                          },
                                                      }
                                                    : node,
                                            ),
                                        );
                                        message.success("绘图已保存");
                                    }}
                                />
                            </Suspense>
                        ) : null}

                        <AiArtCritiqueModal
                            startRequestId={artCritiqueStartRequest && artCritiqueStartRequest.nodeId === artCritiqueNode?.id ? artCritiqueStartRequest.id : undefined}
                            restartRequested={artCritiqueStartRequest?.nodeId === artCritiqueNode?.id && artCritiqueStartRequest?.restart}
                            onRunningChange={(running) => {
                                artCritiqueRunningRef.current = running;
                            }}
                            node={artCritiqueNode}
                            upstreamNodes={artCritiqueInputs}
                            open={Boolean(artCritiqueNode)}
                            onClose={() => setArtCritiqueNodeId(null)}
                            onUpdateState={(nodeId, state) => handleConfigNodeChange(nodeId, { artCritique: state })}
                        />

                        <CanvasPanoramaConfigModal
                            open={Boolean(panoramaConfigNodeId)}
                            onCancel={() => setPanoramaConfigNodeId(null)}
                            onConfirm={(composedPrompt, config) => {
                                const node = nodes.find((n) => n.id === panoramaConfigNodeId);
                                if (node) {
                                    createPanoramaViewerWithConfig(node, composedPrompt, config);
                                }
                            }}
                            onCopyPrompt={(prompt) => {
                                void navigator.clipboard?.writeText(prompt).then(() => message.success("已复制全景提示词"));
                            }}
                            previewImageUrl={panoramaConfigNodeId ? nodes.find((n) => n.id === panoramaConfigNodeId)?.metadata?.content : undefined}
                            nodes={nodes}
                        />

                        <CanvasScriptEditor
                            node={activeScriptNode}
                            nodes={nodes}
                            open={Boolean(activeScriptNode)}
                            onClose={() => setScriptEditorNodeId(null)}
                            onUpdateRows={(rows) => activeScriptNode && replaceScriptRows(activeScriptNode.id, rows)}
                            onVisibleColumnsChange={(visibleColumns: StoryboardColumn[]) => {
                                if (!activeScriptNode || !visibleColumns.length) return;
                                setNodes((prev) =>
                                    prev.map((node) =>
                                        node.id === activeScriptNode.id
                                            ? { ...node, metadata: { ...node.metadata, storyboard: { rows: node.metadata?.storyboard?.rows || [], visibleColumns, referenceNodeIds: node.metadata?.storyboard?.referenceNodeIds || [] } } }
                                            : node,
                                    ),
                                );
                            }}
                            onGenerateImages={(rowIds) => activeScriptNode && void generateScriptImages(activeScriptNode.id, rowIds)}
                            onGenerateVideos={(rowIds) => {
                                if (!activeScriptNode) return;
                                if (activeScriptNode.metadata?.storyboardVideoInputMode === "keyframe") void generateScriptVideos(activeScriptNode.id, rowIds);
                                else void createAndGenerateScriptVideos(activeScriptNode.id, rowIds);
                            }}
                            onVideoInputModeChange={(storyboardVideoInputMode) => activeScriptNode && handleConfigNodeChange(activeScriptNode.id, { storyboardVideoInputMode })}
                        />

                        {directorNodeId && activeDirectorScene ? (
                            <Suspense
                                fallback={
                                    <div className="fixed inset-0 z-[var(--z-toast)] grid place-items-center px-5" style={{ background: theme.canvas.background, color: theme.node.text }}>
                                        <WorkspaceState icon="loading" title="正在加载 3D 导演台" description="准备场景、镜头与空间控制。" />
                                    </div>
                                }
                            >
                                <CanvasDirectorWorkbench
                                    open
                                    scene={activeDirectorScene}
                                    imageNodes={nodes.filter((node) => node.type === CanvasNodeType.Image && Boolean(node.metadata?.content))}
                                    onClose={() => setDirectorNodeId(null)}
                                    onChange={saveDirectorScene}
                                    onApply={applyDirectorOutput}
                                    onDeleteImageNode={(nodeId) => deleteNodes(new Set([nodeId]))}
                                    onFlush={() => flushCanvasStorePersistence()}
                                    onboardingScope={directorOnboardingScope}
                                />
                            </Suspense>
                        ) : null}

                        <CanvasVersionCompareModal
                            open={Boolean(versionCompareRootId)}
                            versions={versionCompareNodes}
                            onClose={() => setVersionCompareRootId(null)}
                            onSetPrimary={setPrimaryVersion}
                            onFocus={(nodeId) => {
                                setVersionCompareRootId(null);
                                focusCanvasNode(nodeId);
                            }}
                        />

                        <CanvasProjectMediaDialogs
                            cropNode={cropNode}
                            annotationNode={annotationNode}
                            annotationEditNode={annotationEditNodeId ? nodeById.get(annotationEditNodeId) || null : null}
                            maskEditNode={maskEditNode}
                            imageEditNode={imageEditNode}
                            layerDecompositionNode={layerDecompositionNodeId ? nodeById.get(layerDecompositionNodeId) || null : null}
                            textEditNode={textEditNodeId ? nodeById.get(textEditNodeId) || null : null}
                            imageEditPreset={imageEditPreset}
                            upscaleNode={upscaleNode}
                            onCloseCrop={() => setCropNodeId(null)}
                            onCloseAnnotation={() => setAnnotationNodeId(null)}
                            onCloseAnnotationEdit={() => setAnnotationEditNodeId(null)}
                            onCloseMaskEdit={() => setMaskEditNodeId(null)}
                            onCloseImageEdit={() => { setImageEditNodeId(null); setImageEditPreset(null); }}
                            onCloseLayerDecomposition={() => setLayerDecompositionNodeId(null)}
                            onCloseTextEdit={() => setTextEditNodeId(null)}
                            onCloseUpscale={() => setUpscaleNodeId(null)}
                            onCrop={(node, crop) => void cropImageNode(node, crop)}
                            onAnnotate={(node, dataUrl) => void saveAnnotatedImageNode(node, dataUrl)}
                            onAnnotationEdit={(node, payload) => void editAnnotatedImageNode(node, payload)}
                            onMaskEdit={(node, payload) => void maskEditImageNode(node, payload)}
                            onRegeneratePrompt={(node, prompt) => {
                                setMaskEditNodeId(null);
                                void handleRetryNode(node, { editPrompt: true, prompt });
                            }}
                            onAutoAdjustPrompt={(node) => {
                                setMaskEditNodeId(null);
                                void handleRetryNode(node, { editPrompt: true, autoAdjustPrompt: true });
                            }}
                            onImageOperation={(node, payload) => void editImageNode(node, payload)}
                            onLayerDecomposition={(node, payload) => void decomposeImageLayers(node, payload)}
                            onDetectText={() => {
                                const node = textEditNodeId ? nodeById.get(textEditNodeId) : null;
                                return node ? detectImageText(node) : Promise.reject(new Error("图片节点已不存在"));
                            }}
                            onTextEdit={(node, payload) => void editTextImageNode(node, payload)}
                            onUpscale={(node, params) => void upscaleImageNode(node, params)}
                            config={effectiveConfig}
                        />

                        <CanvasProjectStatusDialogs
                            theme={theme}
                            task={taskDetail}
                            taskLogs={taskDetailLogs}
                            taskLoading={taskDetailLoading}
                            onCloseTask={() => setTaskDetail(null)}
                            onCancelTask={cancelCanvasTask}
                            superResolveNode={superResolveNode}
                            nodes={nodes}
                            onCloseSuperResolve={() => setSuperResolveNodeId(null)}
                            previewNode={previewNode}
                            onClosePreview={() => setPreviewNodeId(null)}
                            clearConfirmOpen={clearConfirmOpen}
                            onCancelClear={() => setClearConfirmOpen(false)}
                            onConfirmClear={clearCanvas}
                        />

                        <BatchGenerationSettingsDialog
                            open={batchGenDialogOpen}
                            config={batchGenDialogConfig}
                            rowCount={batchGenDialogRowCount}
                            onClose={closeBatchGenDialog}
                            onConfirm={confirmBatchGenDialog}
                        />

                        <CanvasTextBatchGenerationModal
                            open={Boolean(textBatchSourceNodeId)}
                            sourceNode={textBatchSourceNodeId ? nodeById.get(textBatchSourceNodeId) || null : null}
                            projectId={projectId}
                            config={effectiveConfig}
                            projectStyle={batchProjectStyle}
                            onClose={() => setTextBatchSourceNodeId(null)}
                            onConfirm={confirmTextAssetBatchGeneration}
                        />

                        <AssetPickerModal open={assetPickerOpen} multiple={assetInsertScope === "canvas"} onInsert={handleLibraryAssetsInsert} onClose={closeAssetPicker} />
                        <CanvasProjectAssetModal
                            open={projectAssetOpen}
                            detail={linkedProjectQuery.data}
                            initialCategory={projectAssetInitialCategory}
                            initialFolderId={projectAssetInitialFolderId}
                            onClose={closeProjectAssets}
                            onInsert={handleTimelineProjectAssetsInsert}
                            onInsertFolder={projectAssetScope === "canvas" ? handleProjectFolderInsert : undefined}
                        />
                    </section>
                    {versions.preview ? (
                        <Suspense fallback={<CanvasRefreshShell />}>
                            <CanvasVersionPreview key={versions.preview.key} preview={versions.preview} onReturn={versions.returnToCurrent} onShowVersions={versions.show} />
                        </Suspense>
                    ) : null}
                    </div>
                </CanvasOverlayLayerProvider>
                <CanvasVersionHistory history={versions} />
            </main>
        </>
    );
}
