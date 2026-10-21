const RECOVERY_QUERY = "__chunk_recovery";
const RECOVERY_KEY = "canvas:chunk-recovery";
let recovering = false;

export function installChunkRecovery() {
    window.addEventListener("vite:preloadError", handlePreloadError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);
    window.addEventListener("error", handleWindowError);
}

export function markChunkRecoverySucceeded() {
    recovering = false;
    try {
        sessionStorage.removeItem(RECOVERY_KEY);
    } catch {
        // The URL marker is still cleaned below when history is available.
    }
    const url = new URL(window.location.href);
    if (!url.searchParams.has(RECOVERY_QUERY)) return;
    url.searchParams.delete(RECOVERY_QUERY);
    window.history.replaceState({}, document.title, url.toString());
}

/** Explicit user retry is allowed even after the automatic recovery was used. */
export function reloadAfterChunkFailure() {
    navigateToFreshEntry();
}

export function tryRecoverChunkFailure() {
    if (recovering) return true;
    const url = new URL(window.location.href);
    if (url.searchParams.has(RECOVERY_QUERY)) return false;
    try {
        if (sessionStorage.getItem(RECOVERY_KEY) === "1") return false;
        sessionStorage.setItem(RECOVERY_KEY, "1");
    } catch {
        // The query marker survives the reload when session storage is denied.
    }
    recovering = true;
    navigateToFreshEntry();
    return true;
}

function navigateToFreshEntry() {
    const url = new URL(window.location.href);
    url.searchParams.set(RECOVERY_QUERY, String(Date.now()));
    window.location.replace(url.toString());
}

function handlePreloadError(event: Event) {
    handleChunkFailure(event);
}

function handleUnhandledRejection(event: PromiseRejectionEvent) {
    if (!isChunkFailure(event.reason)) return;
    handleChunkFailure(event);
}

function handleWindowError(event: ErrorEvent) {
    if (!isChunkFailure(event.error || event.message)) return;
    handleChunkFailure(event);
}

function handleChunkFailure(event: Event) {
    // On the second failure let the route or entry fallback render a useful error.
    if (tryRecoverChunkFailure()) event.preventDefault();
}

function isChunkFailure(value: unknown) {
    const message = value instanceof Error ? value.message : String(value || "");
    return /(?:failed to fetch dynamically imported module|importing a module script failed|loading chunk|chunkloaderror|failed to fetch module|module script)/i.test(message);
}

export function renderEntryLoadFailure(error: unknown) {
    const root = document.getElementById("root");
    if (!root) return;
    const message = error instanceof Error ? error.message : "页面模块加载失败";
    root.replaceChildren();

    const main = document.createElement("main");
    main.setAttribute("role", "alert");
    main.style.cssText = "min-height:100vh;display:grid;place-items:center;padding:24px;background:#101114;color:#f5f5f5;font-family:system-ui,sans-serif";
    const section = document.createElement("section");
    section.style.cssText = "width:min(520px,100%);text-align:center";
    const title = document.createElement("h1");
    title.textContent = "当前页面没有正常加载";
    title.style.cssText = "margin:0 0 12px;font-size:22px";
    const detail = document.createElement("p");
    detail.textContent = message;
    detail.style.cssText = "margin:0 0 20px;line-height:1.6;color:#b7bac5;overflow-wrap:anywhere";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "重新加载";
    retry.style.cssText = "padding:9px 16px;border:0;border-radius:7px;background:#f5f5f5;color:#101114;cursor:pointer";
    retry.addEventListener("click", reloadAfterChunkFailure);
    section.append(title, detail, retry);
    main.append(section);
    root.append(main);
}
