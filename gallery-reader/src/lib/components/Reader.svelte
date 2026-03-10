<script lang="ts">
    import { untrack, getContext } from 'svelte';
    import { appState } from '$lib/state/index.svelte.js';
    import { API } from '$lib/config.js';
    import type { ReaderSession } from '$lib/state/reader.svelte.js';

    const getReaderRoot = getContext<() => HTMLElement | null>('readerRoot');

    let {
        session,
        startPosition,
        onClose,
    }: {
        session: ReaderSession | null;
        startPosition: import('$lib/types.js').PagePosition;
        onClose: () => void;
    } = $props();

    const gallery = $derived(session?.gallery ?? null);
    const pageCount = $derived(gallery?.count ?? 0);
    let pageElements: HTMLElement[] = [];
    let suppressSave = true;

    function registerPage(node: HTMLElement, index: () => number) {
        const idx = index();
        pageElements[idx] = node;
        // Observer is set up in $effect; observe existing elements
        if (session && !session.isDropped) {
            // The observer may not be set yet on first render, but pages will be
            // observed in the $effect below once the observer is created
        }
    }

    function loadPage(s: ReaderSession, pageIndex: number) {
        if (s.hasPage(pageIndex) || s.isLoading(pageIndex)) return;
        s.markLoading(pageIndex);

        const g = s.gallery;
        const url = API.MEDIA(`${g.path}/${g.fullFiles[pageIndex]}`);
        fetch(url, { signal: s.signal })
            .then((r) => r.blob())
            .then((blob) => {
                if (s.isDropped) return;
                const blobUrl = URL.createObjectURL(blob);
                s.addBlobUrl(pageIndex, blobUrl);
                const img = pageElements[pageIndex]?.querySelector('img');
                if (img) img.src = blobUrl;
            })
            .catch(() => {})
            .finally(() => s.unmarkLoading(pageIndex));
    }

    function handleReaderScroll(viewReader: HTMLElement, s: ReaderSession) {
        if (s.isDropped || suppressSave) return;

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
        appState.reader.saveProgress(s.gallery.gallery_id, { pageIndex: idx, fraction });
    }

    // Reactive: when session changes, set up observers and scroll to start position
    $effect(() => {
        const s = session;
        if (!s) return;
        const g = s.gallery;

        const initialPosition = untrack(() => startPosition);

        suppressSave = true;
        pageElements.length = g.count;

        const viewReader = getReaderRoot();

        // Preload observer — triggers fetch when pages are within 1 viewport of visible area
        const preObs = new IntersectionObserver(
            (entries) => {
                if (s.isDropped) return;
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        const idx = pageElements.indexOf(entry.target as HTMLElement);
                        if (idx >= 0) loadPage(s, idx);
                    }
                }
            },
            { rootMargin: '100% 0px', root: viewReader }
        );
        s.setObserver(preObs);

        for (const el of pageElements) {
            if (el) preObs.observe(el);
        }

        // Eagerly load start page (don't wait for observer)
        loadPage(s, initialPosition.pageIndex);

        // Scroll handler for progress tracking — throttle via rAF
        let scrollRafId: number | undefined;
        const onScroll = () => {
            if (scrollRafId != null) return;
            scrollRafId = requestAnimationFrame(() => {
                scrollRafId = undefined;
                handleReaderScroll(viewReader!, s);
            });
        };
        viewReader?.addEventListener('scroll', onScroll, { passive: true });
        s.setScrollCleanup(() => {
            viewReader?.removeEventListener('scroll', onScroll);
            if (scrollRafId != null) {
                cancelAnimationFrame(scrollRafId);
                scrollRafId = undefined;
            }
        });

        // Scroll to start position within the reader's own scroll container
        const rafId = requestAnimationFrame(() => {
            if (s.isDropped) return;
            if (viewReader && initialPosition.pageIndex > 0) {
                const el = pageElements[initialPosition.pageIndex];
                if (el) {
                    viewReader.scrollTop = el.offsetTop + initialPosition.fraction * el.offsetHeight;
                }
            } else if (viewReader) {
                viewReader.scrollTop = 0;
            }
            const timerId = setTimeout(() => { suppressSave = false; }, 500);
            s.addTimer(timerId);
        });
        s.addRaf(rafId);

        // Minimal cleanup — session.drop() handles the rest
        return () => {
            // Nothing here — session owns all resources.
            // drop() is called by ReaderState.closeReader() or openReader().
        };
    });


</script>

{#if session}
    {@const g = session.gallery}
    <div
        class="reader-wrapper"
        role="application"
    >
        {#each Array(pageCount) as _, i}
            {@const dim = g.dimensions[i]}
            {@const aspectRatio = dim && dim.width && dim.height ? `${dim.width}/${dim.height}` : '2/3'}
            <div class="reader-page" use:registerPage={() => i} style="aspect-ratio:{aspectRatio}">
                <img alt="Page {i + 1}" decoding="async" style="width:100%;display:block" />
            </div>
        {/each}
    </div>
{/if}
