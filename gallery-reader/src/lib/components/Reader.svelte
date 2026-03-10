<script lang="ts">
    import { untrack, getContext } from 'svelte';
    import { appState } from '$lib/state/index.svelte.js';
    import { API } from '$lib/config.js';
    import type { Gallery, PagePosition } from '$lib/types.js';

    const getReaderRoot = getContext<() => HTMLElement | null>('readerRoot');

    let {
        gallery,
        startPosition,
        onClose,
    }: {
        gallery: Gallery | null;
        startPosition: PagePosition;
        onClose: () => void;
    } = $props();

    const pageCount = $derived(gallery?.count ?? 0);
    let pageElements: HTMLElement[] = [];
    let preloadObserver: IntersectionObserver | undefined;
    let suppressSave = true;
    let suppressTimer: ReturnType<typeof setTimeout>;
    let scrollRafId: number | undefined;

    // Blob URL memory management
    let blobUrls = new Map<number, string>();
    let loadingPages = new Set<number>();
    let abortController: AbortController | undefined;

    function registerPage(node: HTMLElement, index: () => number) {
        const idx = index();
        pageElements[idx] = node;
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

    function handleReaderScroll(viewReader: HTMLElement, g: Gallery) {
        if (scrollRafId != null) return;
        scrollRafId = requestAnimationFrame(() => {
            scrollRafId = undefined;
            if (suppressSave || !g) return;
            const scrollTop = viewReader.scrollTop;
            let idx = 0;
            for (let i = 0; i < pageElements.length; i++) {
                const el = pageElements[i];
                if (!el) continue;
                if (el.offsetTop + el.offsetHeight > scrollTop) { idx = i; break; }
            }
            const el = pageElements[idx];
            const fraction = el
                ? Math.max(0, Math.min(1, (scrollTop - el.offsetTop) / el.offsetHeight))
                : 0;
            appState.reader.saveProgress(g.gallery_id, { pageIndex: idx, fraction });
        });
    }

    // Reactive: when gallery changes, set up observers and scroll to start position
    $effect(() => {
        const g = gallery;
        if (!g) return;

        const initialPosition = untrack(() => startPosition);

        // Clean up previous gallery's resources
        revokeAll();
        abortController = new AbortController();
        const signal = abortController.signal;

        suppressSave = true;
        clearTimeout(suppressTimer);
        pageElements.length = g.count;

        const viewReader = getReaderRoot();

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
                preObs.observe(el);
            }
        }

        // Eagerly load start page (don't wait for observer)
        loadPage(g, initialPosition.pageIndex, signal);

        // Scroll handler for progress tracking
        const onScroll = () => handleReaderScroll(viewReader!, g);
        viewReader?.addEventListener('scroll', onScroll, { passive: true });

        // Scroll to start position within the reader's own scroll container
        requestAnimationFrame(() => {
            if (viewReader && initialPosition.pageIndex > 0) {
                const el = pageElements[initialPosition.pageIndex];
                if (el) {
                    viewReader.scrollTop = el.offsetTop + initialPosition.fraction * el.offsetHeight;
                }
            } else if (viewReader) {
                viewReader.scrollTop = 0;
            }
            suppressTimer = setTimeout(() => { suppressSave = false; }, 500);
        });

        return () => {
            revokeAll();
            preObs.disconnect();
            viewReader?.removeEventListener('scroll', onScroll);
            if (scrollRafId != null) {
                cancelAnimationFrame(scrollRafId);
                scrollRafId = undefined;
            }
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
