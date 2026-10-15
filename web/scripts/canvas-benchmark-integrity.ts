export type BenchmarkWheelInput = {
    deltaX: number;
    deltaY: number;
    deltaMode: number;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    clientX: number;
    clientY: number;
    timeStamp: number;
    target: "canvas" | "frame" | "node" | "overlay";
};

type Camera = { x: number; y: number; k: number };
export type BenchmarkInputAudit = {
    sent: Array<{ deltaX: number; deltaY: number; clientX: number; clientY: number; target: "canvas" | "frame" }>;
    received: BenchmarkWheelInput[];
    totalReceived: number;
    foreground: { startVisible: boolean; startFocused: boolean; endVisible: boolean; endFocused: boolean; interruptions: number };
    initialCamera: Camera;
    finalCamera: Camera;
};

/** Reject interference rather than silently filtering it out of a performance run. */
export function canvasBenchmarkInputIssues(audit: BenchmarkInputAudit): string[] {
    const issues: string[] = [];
    const close = (left: number, right: number, tolerance = 0.1) => Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance;
    if (audit.sent.length !== 12 || audit.totalReceived !== audit.sent.length || audit.received.length !== audit.totalReceived) issues.push("wheel-count");
    if (audit.received.some((event, index) => {
        const sent = audit.sent[index];
        return !sent || !close(event.deltaX, sent.deltaX) || !close(event.deltaY, sent.deltaY)
            || !close(event.clientX, sent.clientX, 1) || !close(event.clientY, sent.clientY, 1)
            || event.deltaMode !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey
            || (sent.target !== "canvas" && sent.target !== "frame") || event.target !== sent.target;
    })) issues.push("wheel-sequence");
    const foreground = audit.foreground;
    if (!foreground.startVisible || !foreground.startFocused || !foreground.endVisible || !foreground.endFocused || foreground.interruptions) issues.push("foreground-interrupted");
    if (!close(audit.initialCamera.k, audit.finalCamera.k, 0.00001)
        || !close(audit.initialCamera.x, audit.finalCamera.x)
        || !close(audit.initialCamera.y, audit.finalCamera.y)) issues.push("camera-not-restored");
    return issues;
}

export type BenchmarkAcceptanceEnvironment = {
    headless?: boolean;
    gpu?: {
        auxAttributes?: { glRenderer?: string };
        featureStatus?: Record<string, string>;
    };
    emptyPageCadence?: { count: number; visible: boolean; focused: boolean };
};

/** A listed physical GPU does not prove that Chrome used it for rendering. */
export function canvasBenchmarkEnvironmentIssues(environment: BenchmarkAcceptanceEnvironment): string[] {
    const issues: string[] = [];
    if (environment.headless !== false) issues.push("headed-browser-required");
    const renderer = environment.gpu?.auxAttributes?.glRenderer;
    if (!renderer || /swiftshader|llvmpipe|softpipe|software|basic render|warp\b/i.test(renderer)) issues.push("hardware-renderer-required");
    for (const feature of ["gpu_compositing", "rasterization"]) {
        if (!/^enabled(?:_on)?$/.test(environment.gpu?.featureStatus?.[feature] || "")) issues.push(`${feature}-not-enabled`);
    }
    const cadence = environment.emptyPageCadence;
    if (!cadence || cadence.count !== 120 || !cadence.visible || !cadence.focused) issues.push("foreground-cadence-required");
    return issues;
}

export function canvasBenchmarkHasThreeRepeats(rows: Array<{ repeat: number }>): boolean {
    return rows.length === 3 && [1, 2, 3].every((repeat) => rows.some((row) => row.repeat === repeat));
}
