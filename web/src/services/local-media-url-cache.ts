/** Local file URLs stay valid for callers holding an earlier revision of the same key. */
export class LocalMediaUrlCache {
    private entries = new Map<string, { current: string; urls: Set<string> }>();
    private reads = new Map<string, Promise<string>>();
    private mutations = new Map<string, Promise<unknown>>();
    private epoch = 0;

    get generation() { return this.epoch; }

    assertCurrent(generation: number) {
        if (generation !== this.epoch) throw new DOMException("Media session changed", "AbortError");
    }

    adopt(key: string, url: string) {
        const entry = this.entries.get(key) ?? { current: url, urls: new Set<string>() };
        entry.current = url;
        entry.urls.add(url);
        this.entries.set(key, entry);
        return url;
    }

    async resolve(key: string, read: () => Promise<Blob | null>) {
        const generation = this.epoch;
        while (this.mutations.has(key)) {
            await this.mutations.get(key)!.catch(() => undefined);
            if (generation !== this.epoch) return "";
        }
        const cached = this.entries.get(key)?.current;
        if (cached) return cached;
        const pending = this.reads.get(key);
        if (pending) return pending;
        let task: Promise<string>;
        task = read().then((blob) => {
            // Deletion/logout invalidates the read without recreating an already released URL.
            if (this.reads.get(key) !== task) return "";
            const current = this.entries.get(key)?.current;
            if (current) return current;
            return blob ? this.adopt(key, URL.createObjectURL(blob)) : "";
        }).finally(() => {
            if (this.reads.get(key) === task) this.reads.delete(key);
        });
        this.reads.set(key, task);
        return task;
    }

    delete(key: string) {
        this.reads.delete(key);
        const entry = this.entries.get(key);
        this.entries.delete(key);
        entry?.urls.forEach((url) => URL.revokeObjectURL(url));
    }

    write(key: string, blob: Blob, persist: () => Promise<unknown>) {
        return this.mutate(key, async (generation) => {
            await persist();
            this.assertCurrent(generation);
            return this.adopt(key, URL.createObjectURL(blob));
        });
    }

    remove(key: string, persist: () => Promise<unknown>) {
        return this.mutate(key, async (generation) => {
            await persist();
            this.assertCurrent(generation);
            this.delete(key);
        });
    }

    private mutate<T>(key: string, operation: (generation: number) => Promise<T>) {
        const generation = this.epoch;
        const previous = this.mutations.get(key) ?? Promise.resolve();
        const task = previous.catch(() => undefined).then(() => {
            this.assertCurrent(generation);
            return operation(generation);
        }).finally(() => {
            if (this.mutations.get(key) === task) this.mutations.delete(key);
        });
        this.mutations.set(key, task);
        return task;
    }

    clear() {
        this.epoch++;
        this.reads.clear();
        // Keep storage operations ordered across sessions; queued old work fails its epoch check.
        for (const key of this.entries.keys()) this.delete(key);
    }
}
