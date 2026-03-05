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
                        if (idx >= 0 && !signal.aborted) loadPage(g, idx, signal);
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
