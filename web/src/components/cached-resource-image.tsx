import { useEffect, useRef, useState, type ImgHTMLAttributes, type ReactNode } from "react";

import { getResourceAccess, resolveResourceAccessURL, resourceIdFromStorageKey, type ResourceAccessVariant } from "@/services/api/resources";
import { getActiveUserScope } from "@/lib/user-scope";
import { resolveImageUrl } from "@/services/image-storage";
import { prepareCanvasImage } from "@/services/canvas-image-loader";

type CachedResourceImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
    storageKey?: string;
    src?: string;
    fallback?: ReactNode;
    loadingFallback?: ReactNode;
    eager?: boolean;
    variant?: ResourceAccessVariant;
};

/**
 * 远程资源图片统一使用 OSS/CDN 授权地址。
 * Blob 缓存仍可用于导出、抽帧等字节处理，但不作为媒体展示 src，避免把
 * `blob:http(s)://...` 泄露到节点、素材库和浏览器媒体链路中。
 */
export function CachedResourceImage({ storageKey, src = "", fallback = null, loadingFallback = fallback, eager = false, variant = "original", onError, ...props }: CachedResourceImageProps) {
    const resourceId = resourceIdFromStorageKey(storageKey);
    const remoteResource = Boolean(resourceId);
    const localImageResource = Boolean(storageKey && (storageKey.startsWith("image:") || storageKey.startsWith("generation-image:")));
    const scope = getActiveUserScope();
    const identity = `${scope}:${resourceId || storageKey || src}`;
    const targetRef = useRef<HTMLSpanElement>(null);
    const [nearIdentity, setNearIdentity] = useState(eager || !remoteResource ? identity : "");
    const nearViewport = eager || !remoteResource || nearIdentity === identity;
    const retryControllerRef = useRef<AbortController | null>(null);
    const requestKey = `${identity}:${variant}:${src}`;
    const requestKeyRef = useRef(requestKey);
    requestKeyRef.current = requestKey;
    const [displayed, setDisplayed] = useState<{ identity: string; src: string } | null>(null);
    const displayedRef = useRef(displayed);
    displayedRef.current = displayed;
    const [failedIdentity, setFailedIdentity] = useState("");
    const cachedSrc = displayed?.identity === identity ? displayed.src : "";

    useEffect(() => () => {
        retryControllerRef.current?.abort();
        retryControllerRef.current = null;
    }, [requestKey]);

    useEffect(() => {
        if (!remoteResource || eager) {
            setNearIdentity(identity);
            return;
        }
        const image = targetRef.current;
        if (!image || typeof IntersectionObserver === "undefined") {
            setNearIdentity(identity);
            return;
        }
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    setNearIdentity(identity);
                    observer.disconnect();
                }
            },
            { rootMargin: "240px" },
        );
        observer.observe(image);
        return () => observer.disconnect();
    }, [eager, identity, remoteResource]);

    useEffect(() => {
        if (remoteResource && !nearViewport) return;
        const controller = new AbortController();
        let cancelled = false;
        const isCurrent = () => !cancelled && !controller.signal.aborted && requestKeyRef.current === requestKey && getActiveUserScope() === scope;
        const load = async () => {
            let candidate = src;
            if (remoteResource && resourceId) {
                try {
                    const access = await getResourceAccess(storageKey, "display", variant);
                    candidate = resolveResourceAccessURL(access.url);
                } catch (error) {
                    if (!isCurrent() || variant !== "thumbnail") throw error;
                    const access = await getResourceAccess(storageKey, "display", "original");
                    candidate = resolveResourceAccessURL(access.url);
                }
            } else if (localImageResource && storageKey) {
                candidate = (await resolveImageUrl(storageKey, src)) || src;
            }
            if (!isCurrent()) return;
            if (!candidate) throw new Error("图片地址为空");
            try {
                await prepareCanvasImage(candidate, controller.signal);
            } catch (error) {
                if (!isCurrent()) throw error;
                if (!remoteResource || variant !== "thumbnail") {
                    if (candidate !== src && src) {
                        await prepareCanvasImage(src, controller.signal);
                        candidate = src;
                    }
                    else throw error;
                } else {
                    const access = await getResourceAccess(storageKey, "display", "original");
                    const originalURL = resolveResourceAccessURL(access.url);
                    if (!originalURL || originalURL === candidate) throw error;
                    await prepareCanvasImage(originalURL, controller.signal);
                    candidate = originalURL;
                }
            }
            if (isCurrent()) {
                setDisplayed({ identity, src: candidate });
                setFailedIdentity("");
            }
        };
        void load().catch(() => {
            if (isCurrent() && displayedRef.current?.identity !== identity) setFailedIdentity(identity);
        });
        return () => {
            cancelled = true;
            controller.abort();
        };
    }, [identity, localImageResource, nearViewport, remoteResource, requestKey, resourceId, scope, src, storageKey, variant]);

    const handleImgError = (e: React.SyntheticEvent<HTMLImageElement, Event>) => {
        if (localImageResource && storageKey && cachedSrc.startsWith("blob:")) {
            retryControllerRef.current?.abort();
            const controller = new AbortController();
            retryControllerRef.current = controller;
            const isCurrent = () => !controller.signal.aborted && retryControllerRef.current === controller && requestKeyRef.current === requestKey && getActiveUserScope() === scope;
            void resolveImageUrl(storageKey)
                .then(async (url) => {
                    if (!isCurrent()) return;
                    if (url && url !== cachedSrc) {
                        await prepareCanvasImage(url, controller.signal);
                        if (isCurrent()) {
                            setDisplayed({ identity, src: url });
                            setFailedIdentity("");
                        }
                        return;
                    }
                    setFailedIdentity(identity);
                    onError?.(e);
                })
                .catch(() => {
                    if (!isCurrent()) return;
                    setFailedIdentity(identity);
                    onError?.(e);
                });
            return;
        }
        setFailedIdentity(identity);
        onError?.(e);
    };

    if (failedIdentity === identity && fallback) return <>{fallback}</>;
    if (!remoteResource) return <img {...props} src={cachedSrc || undefined} onError={handleImgError} />;
    return (
        <span ref={targetRef} className="cached-resource-image-shell">
            {cachedSrc ? <img {...props} src={cachedSrc} onError={handleImgError} /> : failedIdentity === identity ? fallback : loadingFallback}
        </span>
    );
}
