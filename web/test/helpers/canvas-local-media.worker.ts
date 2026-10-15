import localforage from "localforage";

type Scenario = string;

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

self.onmessage = async (event: MessageEvent<Scenario>) => {
    const scenario = event.data;
    const values = new Map<string, Map<string, unknown>>();
    const created: string[] = [];
    const revoked: string[] = [];
    let reads = 0;
    let uploads = 0;
    let readGate: ReturnType<typeof deferred> | undefined;
    let writeGate: ReturnType<typeof deferred> | undefined;
    let removeGate: ReturnType<typeof deferred> | undefined;
    let uploadGate: ReturnType<typeof deferred> | undefined;
    let readError = false;
    let removeError = false;
    const entered = deferred();
    const operations: string[] = [];
    const store = (name: string) => {
        if (!values.has(name)) values.set(name, new Map());
        return values.get(name)!;
    };
    localforage.createInstance = ((options: { storeName: string }) => ({
        getItem: async (key: string) => {
            reads++;
            const value = store(options.storeName).get(key) ?? null;
            if (readError) throw new Error("Synthetic read failure");
            if (readGate) { entered.resolve(); await readGate.promise; }
            if (scenario.startsWith("parallel-")) await new Promise((resolve) => setTimeout(resolve, 10));
            return value;
        },
        setItem: async (key: string, value: unknown) => {
            if (scenario === "image-storage-failure" && options.storeName === "image_files") throw new Error("Synthetic quota failure");
            if (writeGate) { entered.resolve(); await writeGate.promise; }
            operations.push("write");
            store(options.storeName).set(key, value);
            return value;
        },
        removeItem: async (key: string) => {
            if (removeError) throw new Error("Synthetic delete failure");
            if (removeGate) { entered.resolve(); await removeGate.promise; }
            operations.push("delete");
            store(options.storeName).delete(key);
        },
        iterate: async (iterator: (value: unknown, key: string) => unknown) => { for (const [key, value] of store(options.storeName)) iterator(value, key); },
        length: async () => store(options.storeName).size,
    })) as typeof localforage.createInstance;
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: { getItem: () => "cache-test" }, addEventListener: () => {}, removeEventListener: () => {} } });
    Object.defineProperty(globalThis, "Image", { configurable: true, value: class {
        naturalWidth = 12; naturalHeight = 8;
        onload: (() => void) | null = null; onerror: (() => void) | null = null;
        constructor() { if (scenario === "image-metadata-failure") throw new Error("Synthetic decoder allocation failure"); }
        set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    } });
    URL.createObjectURL = () => { const url = `blob:synthetic-${created.length}`; created.push(url); return url; };
    URL.revokeObjectURL = (url) => { revoked.push(url); };
    try {
        const image = await import("../../src/services/image-storage");
        const media = await import("../../src/services/file-storage");
        const { apiClient } = await import("../../src/services/api/request");
        apiClient.defaults.adapter = async (config) => {
            uploads++;
            if (uploadGate) { entered.resolve(); await uploadGate.promise; }
            const status = scenario === "image-permanent-failure" ? 413 : 503;
            return { config, status, statusText: "Synthetic failure", headers: {}, data: { code: status, msg: "Synthetic upload rejection", data: null } };
        };
        let result: unknown;
        if (scenario.startsWith("parallel-")) {
            const isImage = scenario === "parallel-image";
            const key = `${isImage ? "image" : "video"}:cache-test:parallel`;
            store(isImage ? "image_files" : "media_files").set(key, new Blob(["synthetic media"]));
            const urls = await Promise.all(Array.from({ length: 8 }, () => isImage ? image.resolveImageUrl(key) : media.resolveMediaUrl(key)));
            result = { distinctUrls: new Set(urls).size, reads };
        } else if (scenario.endsWith("replace-delete")) {
            const isImage = scenario.startsWith("image");
            const key = `${isImage ? "image" : "video"}:cache-test:replacement`;
            const set = isImage ? image.setImageBlob : media.setMediaBlob;
            const oldUrl = await set(key, new Blob(["old"]));
            const newUrl = await set(key, new Blob(["new"]));
            const beforeDelete = [...revoked];
            await (isImage ? image.deleteStoredImages([key]) : media.deleteStoredMedia([key]));
            result = { oldUrl, newUrl, beforeDelete };
        } else if (scenario === "media-cleanup") {
            const key = "video:cache-test:unused";
            const url = await media.setMediaBlob(key, new Blob(["video"]));
            await media.cleanupUnusedMedia({}, "cache-test");
            result = { url, afterCleanup: await media.resolveMediaUrl(key, "missing"), stored: store("media_files").has(key) };
        } else if (/-(read-delete|read-clear|read-replace|write-clear|upload-clear|delete-write|delete-failure|read-retry|ten-cycles)$/.test(scenario)) {
            const isImage = scenario.startsWith("image-");
            const key = `${isImage ? "image" : "file"}:cache-test:race`;
            const files = store(isImage ? "image_files" : "media_files");
            const set = isImage ? image.setImageBlob : media.setMediaBlob;
            const resolve = isImage ? image.resolveImageUrl : media.resolveMediaUrl;
            const remove = isImage ? image.deleteStoredImages : media.deleteStoredMedia;
            const clear = isImage ? image.clearImageObjectUrls : media.clearMediaObjectUrls;
            const upload = isImage ? image.uploadImage : media.uploadMediaFile;
            const old = new Blob(["old"]);
            files.set(key, old);
            if (/-(read-delete|read-clear|read-replace)$/.test(scenario)) {
                readGate = deferred();
                const pending = resolve(key, "missing");
                await entered.promise;
                let latest: string | undefined;
                if (scenario.endsWith("read-delete")) await remove([key]);
                else if (scenario.endsWith("read-clear")) clear();
                else latest = await set(key, new Blob(["new"]));
                readGate.resolve();
                result = { resolved: await pending, latest };
            } else if (/-(write-clear|upload-clear)$/.test(scenario)) {
                const gate = deferred();
                if (scenario.endsWith("write-clear")) writeGate = gate;
                else uploadGate = gate;
                const pending = (writeGate ? set(key, old) : upload(old)).then(() => "success", (error) => error.name);
                await entered.promise;
                clear();
                gate.resolve();
                result = { outcome: await pending, operations };
            } else if (scenario.endsWith("delete-write")) {
                await set(key, old);
                operations.length = 0;
                removeGate = deferred();
                const removing = remove([key]);
                await entered.promise;
                const writing = set(key, new Blob(["new"]));
                await new Promise((done) => setTimeout(done, 10));
                const beforeRelease = [...operations];
                removeGate.resolve();
                await removing;
                const latest = await writing;
                result = { beforeRelease, operations, latest, resolved: await resolve(key), stored: await (files.get(key) as Blob | undefined)?.text() };
            } else if (scenario.endsWith("delete-failure")) {
                const url = await set(key, old);
                removeError = true;
                const error = await remove([key]).then(() => "", (error) => error.message);
                result = { error, url, resolved: await resolve(key), stored: files.has(key) };
            } else if (scenario.endsWith("read-retry")) {
                readError = true;
                const error = await resolve(key).then(() => "", (error) => error.message);
                readError = false;
                files.delete(key);
                const missing = await Promise.all([resolve(key, "fallback-A"), resolve(key, "fallback-B")]);
                files.set(key, old);
                result = { error, missing, resolved: await resolve(key) };
            } else {
                const retained: number[] = [];
                for (let i = 0; i < 10; i++) {
                    await set(key, old);
                    await resolve(key);
                    await set(key, new Blob(["new"]));
                    await remove([key]);
                    retained.push(created.filter((url) => !revoked.includes(url)).length);
                }
                result = { retained, stored: files.size };
            }
        } else {
            if (scenario === "image-fetch-failure") globalThis.fetch = (async () => new Response("not an image", { status: 404 })) as typeof fetch;
            try { result = { image: await image.uploadImage(scenario === "image-fetch-failure" ? "blob:unavailable" : new Blob(["image"], { type: "image/png" })) }; }
            catch (error) { result = { error: error instanceof Error ? error.message : String(error) }; }
        }
        self.postMessage({ ok: true, result: { ...result as object, created, revoked, uploads } });
    } catch (error) {
        self.postMessage({ ok: false, error: error instanceof Error ? error.stack : String(error) });
    }
};
