import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { FloatingDock } from "@/components/ui/aceternity/floating-dock";

const wait = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runFloatingDockChecks({ label, motionEnabled, showLabels = false }: { label: string; motionEnabled: boolean; showLabels?: boolean }) {
    const results: string[] = [];
    const check = (value: unknown, message: string) => {
        if (!value) throw new Error(`dock ${label}: ${message}`);
        results.push(`dock ${label}: ${message}`);
    };
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:20px;top:20px;display:flex";
    document.body.append(host);
    const root = createRoot(host);
    const original = Element.prototype.getBoundingClientRect;
    let reads = 0;
    let clicks = 0;
    // Count only the production dock's item wrappers, excluding our own measurements.
    Element.prototype.getBoundingClientRect = function () {
        if (host.contains(this) && this.matches("span") && this.firstElementChild?.matches(".aceternity-dock-command")) reads++;
        return original.call(this);
    };
    const render = (active: boolean) => flushSync(() => root.render(<FloatingDock showLabels={showLabels} items={[
        { id: "command", label: "Dock command", icon: <span>+</span>, active, onClick: () => { clicks++; } },
        { id: "disabled", label: "Disabled command", icon: <span>-</span>, disabled: true, onClick: () => { clicks++; } },
    ]} />));
    try {
        render(false);
        await wait();
        reads = 0;
        for (let i = 0; i < 5; i++) { render(i % 2 === 0); await wait(); }
        check(reads === 0, `rerenders outside dock avoid layout reads (received ${reads})`);
        const button = host.querySelector<HTMLButtonElement>("button")!;
        const wrapper = button.parentElement!;
        const rect = original.call(wrapper);
        const baseWidth = rect.width;
        const move = () => flushSync(() => button.dispatchEvent(new PointerEvent("pointermove", {
            bubbles: true, pointerType: "mouse", clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
        })));
        move();
        await wait(1000);
        if (motionEnabled) {
            check(reads > 0, "hover measures the active dock");
            check(original.call(wrapper).width > baseWidth + 3, "hover still magnifies the command");
        } else {
            check(reads === 0, "disabled magnification avoids layout reads even with pointer inside");
            check(Math.abs(original.call(wrapper).width - baseWidth) < 0.1, "disabled magnification preserves dimensions");
        }
        flushSync(() => button.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body })));
        await wait(1000);
        check(Math.abs(original.call(wrapper).width - baseWidth) < 0.1, "pointer leave restores original size");
        reads = 0;
        render(false);
        await wait();
        check(reads === 0, "rerender after pointer leave avoids layout reads");
        flushSync(() => button.click());
        host.querySelector<HTMLButtonElement>("button[disabled]")!.click();
        check(clicks === 1, "enabled command executes once and disabled command does not execute");
        flushSync(() => button.focus());
        await wait();
        check(document.activeElement === button, "command remains focusable");
        if (motionEnabled && !showLabels) check(Boolean(host.querySelector(".aceternity-dock-tooltip")), "visible focus retains command tooltip");
    } finally {
        flushSync(() => root.unmount());
        Element.prototype.getBoundingClientRect = original;
        host.remove();
    }
    return results;
}
