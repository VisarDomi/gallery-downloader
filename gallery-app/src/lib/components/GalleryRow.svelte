<script lang="ts">
    import { onMount, onDestroy, getContext } from 'svelte';
    import { appState } from '$lib/state/index.svelte.js';
    import { THUMB_WIDTH, THUMB_HEIGHT, thumbUrl } from '$lib/config.js';
    import type { GalleryListItem } from '$lib/types.js';
    import type { SearchNamespace } from 'gallery-sources';
    import InfoModal from './InfoModal.svelte';

    const emit = appState.log.emit;

    let {
        gallery,
        allowReplay = false,
    }: {
        gallery: GalleryListItem;
        allowReplay?: boolean;
    } = $props();

    let rowElement: HTMLDivElement | undefined = $state();
    let stripContainer: HTMLDivElement | undefined = $state();
    let showInfoModal = $state(false);

    const id = $derived(gallery.gallery_id);

    const viewId = getContext<string>('viewId');
    const tier = $derived(appState.ui.getViewTier(viewId));

    const thumbCount = $derived(gallery.thumb_count || 0);

    const isFav = $derived(appState.favorites.favoriteIds.has(id));
    const progressIndex = $derived(appState.reader.getProgressIndex(id));
    const activeReaderGalleryId = $derived(appState.reader.activeGallery?.gallery_id ?? null);
    const savedQuery = $derived(appState.favorites.favoriteQueries[id]);

    // Track which thumbnails have been loaded (src set)
    let loadedThumbs = new Set<number>();
    let stripObserver: IntersectionObserver | null = null;

    function loadThumb(img: HTMLImageElement, thumbIdx: number) {
        if (loadedThumbs.has(thumbIdx) || img.src) return;
        loadedThumbs.add(thumbIdx);
        img.src = thumbUrl(id, thumbIdx);
    }

    function unloadAllThumbs() {
        if (loadedThumbs.size === 0) return;
        const imgs = stripContainer?.querySelectorAll<HTMLImageElement>('img');
        if (imgs) for (const img of imgs) img.removeAttribute('src');
        loadedThumbs.clear();
    }

    function prewarmThumbWindow(centerIdx: number) {
        if (!stripContainer || thumbCount === 0) return;
        const imgs = stripContainer.querySelectorAll<HTMLImageElement>('img');
        const start = Math.max(0, centerIdx - 2);
        const end = Math.min(thumbCount - 1, centerIdx + 2);
        for (let i = start; i <= end; i++) {
            const img = imgs[i];
            if (img) loadThumb(img, i);
        }
    }

    function setupStripObserver() {
        stripObserver?.disconnect();
        if (!stripContainer) return;

        stripObserver = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        const img = entry.target as HTMLImageElement;
                        const idx = Number(img.dataset.idx);
                        if (!isNaN(idx)) loadThumb(img, idx);
                    }
                }
            },
            { rootMargin: '0px 200% 0px 200%', root: stripContainer },
        );

        const imgs = stripContainer.querySelectorAll<HTMLImageElement>('img');
        for (const img of imgs) stripObserver.observe(img);
    }

    function teardownStripObserver() {
        stripObserver?.disconnect();
        stripObserver = null;
    }

    $effect(() => {
        const t = tier;
        if (!rowElement || !stripContainer) return;

        // Deep views: unload everything
        if (t === 'deep') {
            teardownStripObserver();
            unloadAllThumbs();
            return;
        }

        // Back view: keep current state for swipe preview.
        // Exception: fresh mount (restore) has no thumbnails — fall through to
        // set up observer and prewarm visible rows. IntersectionObserver works
        // on visibility:hidden elements (spec §3.2.7 is purely geometric).
        if (t === 'back' && loadedThumbs.size > 0) {
            teardownStripObserver();
            return;
        }

        // Active view: row-level observer gates strip observer setup
        const viewLayer = rowElement.closest('.view-layer') as HTMLElement | null;
        const rowObs = new IntersectionObserver(
            ([entry]) => {
                if (entry.isIntersecting) {
                    setupStripObserver();
                } else {
                    teardownStripObserver();
                    unloadAllThumbs();
                }
            },
            { rootMargin: '100% 0px', root: viewLayer },
        );
        rowObs.observe(rowElement);

        return () => {
            rowObs.disconnect();
            teardownStripObserver();
        };
    });

    $effect(() => {
        if (tier !== 'back' || activeReaderGalleryId !== id) return;
        prewarmThumbWindow(progressIndex);
    });

    // Restore strip scroll position on mount
    onMount(() => {
        const rawTarget = appState.ui.stripScrolls[id];
        if (rawTarget && stripContainer) {
            requestAnimationFrame(() => {
                if (stripContainer) {
                    const centered = rawTarget - (stripContainer.clientWidth / 2);
                    stripContainer.scrollLeft = Math.max(0, centered);
                }
            });
        }
    });

    function handleStripScroll() {
        if (stripContainer) {
            appState.ui.stripScrolls[id] = stripContainer.scrollLeft;
        }
    }

    function handleStripClick(e: MouseEvent) {
        if (!stripContainer) return;
        const rect = stripContainer.getBoundingClientRect();
        const clickX = e.clientX - rect.left + stripContainer.scrollLeft;
        const pageIndex = Math.floor(clickX / THUMB_WIDTH);
        appState.reader.openReader(gallery, pageIndex);
    }

    function handleResume() {
        appState.reader.openReader(gallery, progressIndex);
    }

    function handleReplay() {
        appState.replaySearch(id);
    }

    function handleInfo() {
        showInfoModal = true;
    }

    function handleFav() {
        appState.favorites.toggle(id, appState.searchState.currentQuery, appState.ui.viewMode === 'favorites');
    }

    onDestroy(() => {
        teardownStripObserver();
    });

    function handleSearchFilter(token: { namespace: SearchNamespace; value: string }) {
        showInfoModal = false;
        appState.ui.pushView('list');
        appState.searchState.searchToken(token.namespace, token.value);
    }

</script>

<div class="manga-row" id="gallery-{id}" bind:this={rowElement}>
    <div class="row-strip" role="button" tabindex="0" bind:this={stripContainer} onclick={handleStripClick} onkeydown={(e) => { if (e.key === 'Enter') appState.reader.openReader(gallery, 0); }} onscroll={handleStripScroll}>
        {#each Array(thumbCount) as _, i}
            <img
                alt=""
                decoding="async"
                data-idx={i}
                width={THUMB_WIDTH}
                height={THUMB_HEIGHT}
            />
        {/each}
    </div>

    <div class="row-title-overlay">
        <div class="row-actions">
            {#if progressIndex > 0}
                <button class="row-action-btn" onclick={handleResume} title="Resume pg {progressIndex + 1}">&#9654;</button>
            {/if}
            {#if allowReplay && savedQuery}
                <button class="row-action-btn" onclick={handleReplay} title="Replay: {savedQuery}">&#10227;</button>
            {/if}
            <button class="row-action-btn info-btn" onclick={handleInfo}>i</button>
            <button class="row-action-btn" onclick={handleFav}>{isFav ? '\u2764\uFE0F' : '\u{1F90D}'}</button>
        </div>
    </div>
</div>

{#if showInfoModal}
    <InfoModal galleryId={id} onClose={() => showInfoModal = false} onSearchFilter={handleSearchFilter} />
{/if}
