export type ExecutionDiagnostic = {
    severity?: "warning" | "error";
    errorSource?: string;
    phase?: string;
    outcome?: string;
    code?: string;
    safeMessage?: string;
};

export function executionWarning(value: unknown): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const diagnostic = value as ExecutionDiagnostic;
    if (diagnostic.severity) return diagnostic.severity === "warning";
    return diagnostic.errorSource === "content" ||
        (diagnostic.errorSource === "application" && ["validation", "postprocess"].includes(diagnostic.phase || ""));
}

export function executionTaskWarning(status: string, diagnostic: unknown) {
    return status === "failed" && executionWarning(diagnostic);
}

/** Current execution state wins over a warning retained in older metadata. */
export function canvasNodeWarning<T extends ExecutionDiagnostic & { message: string }>(metadata?: { status?: string; generationWarning?: T }): T | undefined {
    return metadata?.status === "idle" && executionWarning(metadata.generationWarning) ? metadata.generationWarning : undefined;
}
