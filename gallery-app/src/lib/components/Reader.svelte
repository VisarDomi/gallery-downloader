<script lang="ts">
    import { untrack, getContext } from 'svelte';
    import { appState } from '$lib/state/index.svelte.js';
    import { API } from '$lib/config.js';
    import type { ReaderSession } from '$lib/state/reader.svelte.js';

    const getReaderRoot = getContext<() => HTMLElement | null>('readerRoot');
    const scheduleIdle = globalThis.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 0));

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
                const blobUrl = URL.createObjectURL(blob);
                s.addBlobUrl(pageIndex, blobUrl);
                if (s.isDropped) return;
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

    function setupSession(s: ReaderSession, initialPosition: import('$lib/types.js').PagePosition) {
        suppressSave = true;
        const g = s.gallery;
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
            { rootMargin: '500% 0px', root: viewReader }
        );
        s.setObserver(preObs);

        for (const el of pageElements) {
            if (el) preObs.observe(el);
        }

        // Eagerly load start page (don't wait for observer)
        loadPage(s, initialPosition.pageIndex);

        // Eagerly load ALL pages via idle callbacks so nothing is black on scroll.
        // Start from the pages nearest to the initial position, fanning outward.
        const total = g.count;
        const start = initialPosition.pageIndex;
        const order: number[] = [];
        for (let d = 1; d < total; d++) {
            if (start + d < total) order.push(start + d);
            if (start - d >= 0) order.push(start - d);
        }
        let idx = 0;
        function scheduleNext() {
            if (s.isDropped || idx >= order.length) return;
            scheduleIdle(() => {
                if (s.isDropped) return;
                // Load a batch of 3 per idle frame to saturate network without blocking UI
                const end = Math.min(idx + 3, order.length);
                for (; idx < end; idx++) {
                    loadPage(s, order[idx]);
                }
                scheduleNext();
            });
        }
        scheduleNext();

        // Scroll handler for progress tracking — throttle via rAF
        let scrollTimer: ReturnType<typeof setTimeout> | undefined;
        const onScroll = () => {
            clearTimeout(scrollTimer);
            scrollTimer = setTimeout(() => {
                handleReaderScroll(viewReader!, s);
            }, 500);
        };
        viewReader?.addEventListener('scroll', onScroll, { passive: true });
        s.setScrollCleanup(() => {
            viewReader?.removeEventListener('scroll', onScroll);
            clearTimeout(scrollTimer);
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
    }

    // Reactive: when session changes, set up observers and scroll to start position
    $effect(() => {
        const s = session;
        if (!s) return;

        setupSession(s, untrack(() => startPosition));

        return () => {
            if (!s.isDropped) s.drop();
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
