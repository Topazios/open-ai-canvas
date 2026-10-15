// Preserve unchanged derived props without hiding changed data behind a memo comparator.
export function sameCanvasShallowValue<T extends object>(previous: T, next: T) {
    if (previous === next) return true;
    const keys = Object.keys(next) as (keyof T)[];
    return keys.length === Object.keys(previous).length && keys.every((key) => Object.hasOwn(previous, key) && Object.is(previous[key], next[key]));
}

export function reconcileCanvasArray<T>(previous: T[] | undefined, next: T[], equal: (left: T, right: T) => boolean = Object.is): T[] {
    if (!previous || previous === next) return next;
    if (previous.length === next.length && next.every((item, index) => equal(previous[index], item))) return previous;
    return next.map((item, index) => {
        if (index < previous.length && equal(previous[index], item)) return previous[index];
        return item;
    });
}

export function reconcileCanvasArrayMap<T>(previous: Map<string, T[]> | undefined, next: Map<string, T[]>, equal: (left: T, right: T) => boolean = Object.is): Map<string, T[]> {
    if (!previous) return next;
    let unchanged = previous.size === next.size;
    const result = new Map<string, T[]>();
    for (const [key, items] of next) {
        const prior = previous.get(key);
        const reconciled = reconcileCanvasArray(prior, items, equal);
        result.set(key, reconciled);
        if (prior !== reconciled) unchanged = false;
    }
    return unchanged ? previous : result;
}
