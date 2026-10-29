import { create } from "zustand";

import { DEFAULT_DRAWING_ENGINE, type CanvasDrawingEngineSetting } from "@/lib/canvas/canvas-drawing-engine";

export type LocalUser = {
    id: string;
    username: string;
    email?: string;
    displayName: string;
    avatarUrl?: string;
    identityProvider?: string;
    identityId?: string;
    identityUsername?: string;
    role: "admin" | "user";
    status: "active" | "disabled";
    lastLoginAt?: string;
    createdAt?: string;
    updatedAt?: string;
};

export type RuntimeLimits = {
    activeTaskLimit: number;
    resourceUploadMB: number;
    recycleBinRetentionDays?: number;
    concurrency?: RuntimeConcurrency;
    canvas?: {
        connectionLineStyle: "solid" | "dashed";
        connectionArrowStyle: "arrow" | "dot" | "none";
        connectionEffect: "none" | "highlight";
        taskEventHeartbeatSeconds?: number;
        taskEventMaxConnectionsPerUser?: number;
        taskEventMaxReplayEvents?: number;
        taskEventRetentionHours?: number;
        taskFallbackPollMinSeconds?: number;
        taskFallbackPollMaxSeconds?: number;
    };
};

const defaultRuntimeCanvas = {
    connectionLineStyle: "solid" as const,
    connectionArrowStyle: "arrow" as const,
    connectionEffect: "highlight" as const,
    taskEventHeartbeatSeconds: 15,
    taskEventMaxConnectionsPerUser: 8,
    taskEventMaxReplayEvents: 200,
    taskEventRetentionHours: 168,
    taskFallbackPollMinSeconds: 3,
    taskFallbackPollMaxSeconds: 60,
};
const defaultRuntimeLimits: RuntimeLimits = { activeTaskLimit: 5, resourceUploadMB: 50, recycleBinRetentionDays: 30, canvas: defaultRuntimeCanvas };

export type RuntimeConcurrency = Record<"image" | "text" | "agent" | "video" | "audio" | "other" | "channel" | "customRelay" | "imagePreparation" | "resourceDownload" | "upload" | "mediaRecovery" | "agentSessions", number>;

export type FeatureAvailability = {
    welcomeEnabled: boolean;
    shortDramaEnabled: boolean;
    taskCenterEnabled: boolean;
    creditsEnabled: boolean;
    customChannelsEnabled: boolean;
    frontendModelsEnabled: boolean;
    pluginCenterEnabled: boolean;
    systemPluginsVisibleToUsers: boolean;
    configured?: boolean;
    updatedBy?: string;
    updatedAt?: string;
};

export const defaultFeatureAvailability: FeatureAvailability = {
    welcomeEnabled: true,
    shortDramaEnabled: true,
    taskCenterEnabled: true,
    creditsEnabled: true,
    customChannelsEnabled: true,
    frontendModelsEnabled: false,
    pluginCenterEnabled: true,
    systemPluginsVisibleToUsers: true,
};

type UserStore = {
    hydrated: boolean;
    user: LocalUser | null;
    runtimeLimits: RuntimeLimits;
    runtimeLimitsUpdatedAt: number;
    runtimeLimitsError: string;
    drawingEngine: CanvasDrawingEngineSetting;
    features: FeatureAvailability;
    setUser: (user: LocalUser | null) => void;
    setRuntimeLimits: (limits?: RuntimeLimits) => void;
    setDrawingEngine: (setting?: CanvasDrawingEngineSetting) => void;
    setFeatures: (features?: FeatureAvailability) => void;
    setHydrated: (hydrated: boolean) => void;
    clearSession: () => void;
};

export const useUserStore = create<UserStore>()((set) => ({
    hydrated: false,
    user: null,
    runtimeLimits: defaultRuntimeLimits,
    runtimeLimitsUpdatedAt: 0,
    runtimeLimitsError: "",
    drawingEngine: { defaultEngine: DEFAULT_DRAWING_ENGINE },
    features: defaultFeatureAvailability,
    setUser: (user) => set({ user }),
    setRuntimeLimits: (runtimeLimits) => set({ runtimeLimits: runtimeLimits ? { ...runtimeLimits, canvas: { ...defaultRuntimeCanvas, ...runtimeLimits.canvas } } : defaultRuntimeLimits, runtimeLimitsUpdatedAt: runtimeLimits ? Date.now() : 0, runtimeLimitsError: "" }),
    setDrawingEngine: (drawingEngine) => set({ drawingEngine: drawingEngine || { defaultEngine: DEFAULT_DRAWING_ENGINE } }),
    setFeatures: (features) => set({ features: features ? { ...defaultFeatureAvailability, ...features } : defaultFeatureAvailability }),
    setHydrated: (hydrated) => set({ hydrated }),
    clearSession: () => set({ user: null, runtimeLimits: defaultRuntimeLimits, runtimeLimitsUpdatedAt: 0, runtimeLimitsError: "", drawingEngine: { defaultEngine: DEFAULT_DRAWING_ENGINE }, features: defaultFeatureAvailability }),
}));
