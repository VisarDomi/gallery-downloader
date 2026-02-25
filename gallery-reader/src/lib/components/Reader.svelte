<script lang="ts">
    import { untrack } from 'svelte';
    import { appState } from '$lib/state.svelte.js';
    import { API } from '$lib/config.js';
    import type { Gallery } from '$lib/types.js';

    let {
        gallery,
        startPage,
        onClose,
    }: {
        gallery: Gallery | null;
        startPage: number;
        onClose: () => void;
    } = $props();

    const pageCount = $derived(gallery?.count ?? 0);
    let pageElements: HTMLElement[] = [];
    let progressObserver: IntersectionObserver | undefined;
    let preloadObserver: IntersectionObserver | undefined;
    let suppressSave = true;
    let suppressTimer: ReturnType<typeof setTimeout>;

    // Blob URL memory management
    let blobUrls = new Map<number, string>();
    let loadingPages = new Set<number>();
    let abortController: AbortController | undefined;

    function registerPage(node: HTMLElement, index: () => number) {
        const idx = index();
        pageElements[idx] = node;
        progressObserver?.observe(node);
        preloadObserver?.observe(node);
    }

    // Swipe-to-go-back action — attaches touch listeners imperatively
    // (passive: false required for preventDefault in touchmove)
    function swipeBack(node: HTMLElement) {
        const EDGE_ZONE = 30;
        const SWIPE_THRESHOLD = 0.3;
        let tracking = false;
        let startX = 0;
        let startY = 0;
        let locked = false;
        let rejected = false;

        function onStart(e: TouchEvent) {
            const touch = e.touches[0];
            if (touch.clientX <= EDGE_ZONE) {
                tracking = true;
                locked = false;
                rejected = false;
                startX = touch.clientX;
                startY = touch.clientY;
            }
        }

        function onMove(e: TouchEvent) {
            if (!tracking || rejected) return;

            const touch = e.touches[0];
            const dx = touch.clientX - startX;
            const dy = touch.clientY - startY;

            if (!locked) {
                const absDx = Math.abs(dx);
                const absDy = Math.abs(dy);
                if (absDx < 10 && absDy < 10) return;
                if (absDy > absDx) {
                    rejected = true;
                    tracking = false;
                    return;
                }
                locked = true;
                appState.ui.isSwiping = true;
            }

            e.preventDefault();

            const progress = Math.max(0, Math.min(1, dx / window.innerWidth));
            appState.ui.swipeProgress = progress;
        }

        function onEnd() {
            if (!tracking || !locked) {
                tracking = false;
                return;
            }

            tracking = false;
            const progress = appState.ui.swipeProgress;

            appState.ui.swipeAnimating = true;

            if (progress > SWIPE_THRESHOLD) {
                appState.ui.swipeProgress = 1;
                setTimeout(() => {
                    appState.ui.isSwiping = false;
                    appState.ui.swipeAnimating = false;
                    appState.ui.swipeProgress = 0;
                    onClose();
                }, 250);
            } else {
                appState.ui.swipeProgress = 0;
                setTimeout(() => {
                    appState.ui.isSwiping = false;
                    appState.ui.swipeAnimating = false;
                }, 250);
            }
        }

        node.addEventListener('touchstart', onStart, { passive: true });
        node.addEventListener('touchmove', onMove, { passive: false });
        node.addEventListener('touchend', onEnd, { passive: true });

        return {
            destroy() {
                node.removeEventListener('touchstart', onStart);
                node.removeEventListener('touchmove', onMove);
                node.removeEventListener('touchend', onEnd);
            }
        };
    }

    function revokeAll() {
        abortController?.abort();
        for (const url of blobUrls.values()) URL.revokeObjectURL(url);
        blobUrls.clear();
        loadingPages.clear();
    }

    function loadPage(g: Gallery, pageIndex: number, signal: AbortSignal) {
        if (blobUrls.has(pageIndex) || loadingPages.has(pageIndex)) return;
        loadingPages.add(pageIndex);

        const url = API.MEDIA(`${g.path}/${g.fullFiles[pageIndex]}`);
        fetch(url, { signal })
            .then((r) => r.blob())
            .then((blob) => {
                const blobUrl = URL.createObjectURL(blob);
                blobUrls.set(pageIndex, blobUrl);
                const img = pageElements[pageIndex]?.querySelector('img');
                if (img) img.src = blobUrl;
            })
            .catch(() => {})
            .finally(() => loadingPages.delete(pageIndex));
    }

    // Reactive: when gallery changes, set up observers and scroll to start page
    $effect(() => {
        const g = gallery;
        if (!g) return;

        const initialPage = untrack(() => startPage);

        // Clean up previous gallery's resources
        revokeAll();
        abortController = new AbortController();
        const signal = abortController.signal;

        suppressSave = true;
        clearTimeout(suppressTimer);
        pageElements.length = g.count;

        const viewReader = document.getElementById('view-reader');

        // Progress tracking observer (unchanged behavior)
        progressObserver?.disconnect();
        const progObs = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
                        const idx = pageElements.indexOf(entry.target as HTMLElement);
                        if (idx >= 0 && !suppressSave) {
                            appState.reader.saveProgress(g.gallery_id, idx);
                        }
                    }
                }
            },
            { threshold: 0.5, root: viewReader }
        );
        progressObserver = progObs;

        // Preload observer — triggers fetch when pages are within 1 viewport of visible area
        preloadObserver?.disconnect();
        const preObs = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        const idx = pageElements.indexOf(entry.target as HTMLElement);
                        if (idx >= 0) loadPage(g, idx, signal);
                    }
                }
            },
            { rootMargin: '100% 0px', root: viewReader }
        );
        preloadObserver = preObs;

        for (const el of pageElements) {
            if (el) {
                progObs.observe(el);
                preObs.observe(el);
            }
        }

        // Eagerly load start page (don't wait for observer)
        loadPage(g, initialPage, signal);

        // Scroll to start page within the reader's own scroll container
        requestAnimationFrame(() => {
            if (viewReader) viewReader.scrollTop = 0;
            if (initialPage > 0) {
                pageElements[initialPage]?.scrollIntoView();
            }
            suppressTimer = setTimeout(() => { suppressSave = false; }, 500);
        });

        return () => {
            revokeAll();
            progObs.disconnect();
            preObs.disconnect();
            clearTimeout(suppressTimer);
        };
    });

</script>

{#if gallery}
    <div
        class="reader-wrapper"
        role="application"
        use:swipeBack
    >
        {#each Array(pageCount) as _, i}
            {@const dim = gallery.dimensions[i]}
            {@const aspectRatio = dim && dim.width && dim.height ? `${dim.width}/${dim.height}` : '2/3'}
            <div class="reader-page" use:registerPage={() => i} style="aspect-ratio:{aspectRatio}">
                <img alt="Page {i + 1}" decoding="async" style="width:100%;display:block" />
            </div>
        {/each}
    </div>
{/if}
