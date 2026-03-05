<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { appState } from '$lib/state.svelte.js';
    import { API, SPRITE_THUMB_WIDTH, SPRITE_THUMB_HEIGHT, MAX_THUMBS_PER_STRIP } from '$lib/config.js';
    import type { GalleryListItem } from '$lib/types.js';
    import InfoModal from './InfoModal.svelte';

    let {
        gallery,
        allowReplay = false,
    }: {
        gallery: GalleryListItem;
        allowReplay?: boolean;
    } = $props();

    let stripContainer: HTMLDivElement | undefined = $state();
    let showInfoModal = $state(false);

    // Blob URL memory management
    let blobUrls: string[] = [];
    let abortController: AbortController | undefined;

    const id = $derived(gallery.gallery_id);
    const thumbCount = $derived(gallery.thumb_count || 0);
    const stripCount = $derived(Math.ceil(thumbCount / MAX_THUMBS_PER_STRIP));

    const isFav = $derived(appState.favorites.favoriteIds.has(id));
    const progress = $derived(appState.reader.getProgress(id));
    const savedQuery = $derived(appState.favorites.favoriteQueries[id]);

    async function fetchSprite(img: HTMLImageElement, stripIdx: number, signal: AbortSignal) {
        let delay = 1000;
        while (!signal.aborted) {
            try {
                const res = await fetch(API.SPRITE(id, stripIdx), { signal });
                if (res.status === 202) {
                    // Still generating — wait and retry, but respect abort
                    await new Promise<void>((resolve, reject) => {
                        const timer = setTimeout(resolve, delay);
                        signal.addEventListener('abort', () => { clearTimeout(timer); reject(); }, { once: true });
                    });
                    delay = Math.min(delay * 1.5, 5000);
                    continue;
                }
                if (!res.ok) return;
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                blobUrls.push(url);
                img.src = url;
                return;
            } catch {
                return; // aborted or network error
            }
        }
    }

    function fetchSprites() {
        if (abortController) {
            appState.ui.unregisterSpriteController(abortController);
            abortController.abort();
        }
        abortController = new AbortController();
        appState.ui.registerSpriteController(abortController);
        const imgs = stripContainer?.querySelectorAll<HTMLImageElement>('img');
        if (!imgs) return;

        for (let i = 0; i < stripCount; i++) {
            const img = imgs[i];
            if (!img || img.src) continue; // skip already-loaded strips
            fetchSprite(img, i, abortController.signal);
        }
    }

    // Restore strip scroll position on mount
    onMount(() => {
        const rawTarget = appState.ui.stripScrolls[id];
        if (rawTarget && stripContainer) {
            requestAnimationFrame(() => {
                if (stripContainer) {
                    const centered = rawTarget - (stripContainer.clientWidth / 2) + (SPRITE_THUMB_WIDTH / 2);
                    stripContainer.scrollLeft = Math.max(0, centered);
                }
            });
        }
    });

    // Abort sprite fetches when reader opens (frees HTTP connections for images),
    // re-fetch missing strips when reader closes
    $effect(() => {
        if (appState.ui.viewMode === 'reader') {
            abortController?.abort();
        } else if (stripContainer) {
            fetchSprites();
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
        const pageIndex = Math.floor(clickX / SPRITE_THUMB_WIDTH);
        appState.reader.openReader(gallery, pageIndex, appState.ui);
    }

    function handleResume() {
        appState.reader.openReader(gallery, progress, appState.ui);
    }

    function handleReplay() {
        appState.favorites.replaySearch(id);
    }

    function handleInfo() {
        showInfoModal = true;
    }

    function handleFav() {
        appState.favorites.toggle(id, appState.searchState.fullQuery);
    }

    // Revoke blob URLs and abort in-flight fetches when this row leaves the DOM
    onDestroy(() => {
        if (abortController) {
            appState.ui.unregisterSpriteController(abortController);
            abortController.abort();
        }
        for (const url of blobUrls) URL.revokeObjectURL(url);
        blobUrls.length = 0;
    });

    function handleSearchFilter(opts: { artist?: string; group?: string; language?: string }) {
        showInfoModal = false;
        appState.ui.pushView('list');
        appState.searchState.searchByFilter(opts);
    }

</script>

<div class="manga-row" id="gallery-{id}">
    <div class="row-strip" role="button" tabindex="0" bind:this={stripContainer} onclick={handleStripClick} onkeydown={(e) => { if (e.key === 'Enter') appState.reader.openReader(gallery, 0, appState.ui); }} onscroll={handleStripScroll}>
        {#each Array(stripCount) as _, i}
            {@const thumbsInStrip = Math.min(MAX_THUMBS_PER_STRIP, thumbCount - i * MAX_THUMBS_PER_STRIP)}
            <img
                alt=""
                decoding="async"
                width={thumbsInStrip * SPRITE_THUMB_WIDTH}
                height={SPRITE_THUMB_HEIGHT}
            />
        {/each}
    </div>

    <div class="row-title-overlay">
        <div class="row-actions">
            {#if progress > 0}
                <button class="row-action-btn" onclick={handleResume} title="Resume pg {progress + 1}">&#9654;</button>
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
