export const REASONING_EFFORTS = ["low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";
export const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = { low: "低", medium: "中", high: "高" };

export function normalizeReasoningEffort(value: unknown): ReasoningEffort {
    return REASONING_EFFORTS.includes(value as ReasoningEffort) ? value as ReasoningEffort : DEFAULT_REASONING_EFFORT;
}
