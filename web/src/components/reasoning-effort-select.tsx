import { REASONING_EFFORTS, REASONING_EFFORT_LABELS, normalizeReasoningEffort, type ReasoningEffort } from "@/lib/reasoning-effort";
import { useConfigStore } from "@/stores/use-config-store";

export function ReasoningEffortSelect({ value, onChange, disabled = false }: { value?: ReasoningEffort; onChange?: (value: ReasoningEffort) => void; disabled?: boolean }) {
    const stored = useConfigStore((state) => state.config.textReasoningEffort);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    return <label className="reasoning-effort-select" data-canvas-no-zoom onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
        <span>推理强度</span>
        <select aria-label="推理强度" value={normalizeReasoningEffort(value ?? stored)} disabled={disabled} onChange={(event) => {
            const effort = normalizeReasoningEffort(event.target.value);
            updateConfig("textReasoningEffort", effort);
            onChange?.(effort);
        }}>
            {REASONING_EFFORTS.map((effort) => <option key={effort} value={effort}>{REASONING_EFFORT_LABELS[effort]}</option>)}
        </select>
    </label>;
}
