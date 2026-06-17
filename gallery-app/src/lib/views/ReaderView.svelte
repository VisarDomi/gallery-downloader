<script lang="ts">
    import { onMount } from 'svelte';
    import { getContext } from 'svelte';
    import { appState } from '$lib/state/index.svelte.js';
    import { tapToggle } from '$lib/actions/tapToggle.js';
    import { swipeBack } from '$lib/actions/swipeBack.js';
    import { swipeLookup } from '$lib/actions/swipeLookup.js';
    import Reader from '$lib/components/Reader.svelte';
    import { buildReaderViewportRequest } from '$lib/services/captureViewport.js';
    import { getOcrStatus, ocrLookup } from '$lib/services/api.js';
    import { openShirabeLookup } from '$lib/services/shirabe.js';

    const session = $derived(appState.reader.session);
    const getReaderRoot = getContext<() => HTMLElement | null>('readerRoot');
    let lookupInFlight = $state(false);
    let ocrAvailable = $state(false);
    let ocrButtonVisible = $state(false);
    let ocrButtonSuppressed = $state(false);
    let lookupPhase = $state<'idle' | 'capturing' | 'ocr' | 'opening' | 'failed'>('idle');
    let buttonViewportRect = $state({
        left: 0,
        top: 0,
        width: 0,
        height: 0,
        scale: 1,
    });
    const VIEWPORT_SETTLE_MS = 220;
    const OCR_BUTTON_MARGIN_PX = 16;
    const OCR_BUTTON_SIZE_PX = 64;
    const OCR_FAILURE_RESET_MS = 2000;
    const OCR_STATUS_POLL_MS = 3_000;

    function handleClose() {
        appState.reader.closeReader();
    }

    function toggleOcrButton() {
        if (!ocrAvailable) return;
        if (lookupInFlight) return;
        ocrButtonVisible = !ocrButtonVisible;
        if (ocrButtonVisible) {
            updateButtonViewportRect();
        }
        appState.log.emit('reader-ocr-button-toggle', { visible: ocrButtonVisible });
    }

    function updateButtonViewportRect() {
        const viewport = window.visualViewport;
        buttonViewportRect = viewport
            ? {
                left: viewport.offsetLeft,
                top: viewport.offsetTop,
                width: viewport.width,
                height: viewport.height,
                scale: viewport.scale || 1,
            }
            : {
                left: 0,
                top: 0,
                width: window.innerWidth,
                height: window.innerHeight,
                scale: 1,
            };
    }

    function buttonOverlayStyle() {
        const inverseScale = buttonViewportRect.scale > 0 ? 1 / buttonViewportRect.scale : 1;
        return [
            `left:${buttonViewportRect.left + buttonViewportRect.width - OCR_BUTTON_MARGIN_PX - OCR_BUTTON_SIZE_PX}px`,
            `top:${buttonViewportRect.top + buttonViewportRect.height - OCR_BUTTON_MARGIN_PX - OCR_BUTTON_SIZE_PX}px`,
            `--reader-ocr-scale:${inverseScale}`,
        ].join(';');
    }

    onMount(() => {
        if (typeof window !== 'undefined') {
            window.localStorage.removeItem('gallery-downloader.ocr-backend');
            window.localStorage.removeItem('gallery-downloader.ocr-compare-backends');
        }
        const viewport = window.visualViewport;
        let settleTimer: ReturnType<typeof setTimeout> | undefined;
        let statusTimer: ReturnType<typeof setInterval> | undefined;
        let statusInFlight = false;

        function clearSuppression() {
            settleTimer = undefined;
            updateButtonViewportRect();
            ocrButtonSuppressed = false;
        }

        function suppressTemporarily() {
            if (!ocrButtonVisible) return;
            ocrButtonSuppressed = true;
            if (settleTimer) clearTimeout(settleTimer);
            settleTimer = setTimeout(clearSuppression, VIEWPORT_SETTLE_MS);
        }

        viewport?.addEventListener('resize', suppressTemporarily, { passive: true });
        viewport?.addEventListener('scroll', suppressTemporarily, { passive: true });
        window.addEventListener('scroll', suppressTemporarily, { passive: true });
        window.addEventListener('resize', suppressTemporarily, { passive: true });

        updateButtonViewportRect();

        async function refreshOcrStatus() {
            if (statusInFlight) return;
            statusInFlight = true;
            try {
                const status = await getOcrStatus();
                ocrAvailable = status.available;
                if (!status.available && lookupInFlight) {
                    lookupPhase = 'failed';
                }
                if (status.available && ocrButtonVisible) {
                    updateButtonViewportRect();
                }
            } catch {
                ocrAvailable = false;
            } finally {
                statusInFlight = false;
            }
        }

        void refreshOcrStatus();
        statusTimer = setInterval(refreshOcrStatus, OCR_STATUS_POLL_MS);
        window.addEventListener('focus', refreshOcrStatus);
        document.addEventListener('visibilitychange', refreshOcrStatus);

        return () => {
            if (settleTimer) clearTimeout(settleTimer);
            if (statusTimer) clearInterval(statusTimer);
            viewport?.removeEventListener('resize', suppressTemporarily);
            viewport?.removeEventListener('scroll', suppressTemporarily);
            window.removeEventListener('scroll', suppressTemporarily);
            window.removeEventListener('resize', suppressTemporarily);
            window.removeEventListener('focus', refreshOcrStatus);
            document.removeEventListener('visibilitychange', refreshOcrStatus);
        };
    });

    async function handleLookup(source: 'swipe' | 'button' = 'swipe') {
        if (!ocrAvailable) return;
        if (lookupInFlight) return;
        const lookupStarted = performance.now();
        ocrButtonVisible = true;
        lookupPhase = 'capturing';
        appState.log.emit('reader-ocr-trigger', { source });
        const root = getReaderRoot();
        if (!root) {
            lookupPhase = 'failed';
            appState.log.emit('reader-ocr-failed', {
                source,
                phase: 'capturing',
                elapsedMs: Number((performance.now() - lookupStarted).toFixed(2)),
                message: 'Reader root is missing',
            });
            setTimeout(() => {
                if (!lookupInFlight) lookupPhase = 'idle';
            }, OCR_FAILURE_RESET_MS);
            return;
        }

        lookupInFlight = true;
        try {
            const gallery = session?.gallery;
            if (!gallery) {
                throw new Error('Reader gallery is not ready');
            }
            const viewport = buildReaderViewportRequest(root, gallery);
            appState.log.emit('reader-ocr-request-built', {
                source,
                elapsedMs: Number((performance.now() - lookupStarted).toFixed(2)),
                imageCount: viewport.images.length,
                viewportWidth: viewport.viewport.width,
                viewportHeight: viewport.viewport.height,
                scale: viewport.viewport.scale,
            });
            lookupPhase = 'ocr';
            const result = await ocrLookup(viewport);
            appState.log.emit('reader-ocr-response', {
                source,
                backend: result.backend,
                runCount: result.runs.length,
                elapsedMs: Number((performance.now() - lookupStarted).toFixed(2)),
                textLength: result.text.length,
                lineCount: result.lines.length,
            });
            lookupPhase = 'opening';
            appState.log.emit('reader-ocr-handoff', {
                source,
                elapsedMs: Number((performance.now() - lookupStarted).toFixed(2)),
            });
            lookupPhase = 'idle';
            openShirabeLookup(result.text);
        } catch (error) {
            lookupPhase = 'failed';
            appState.log.emit('reader-ocr-failed', {
                source,
                phase: lookupPhase,
                elapsedMs: Number((performance.now() - lookupStarted).toFixed(2)),
                message: String((error as Error)?.message ?? error),
            });
            setTimeout(() => {
                if (!lookupInFlight) lookupPhase = 'idle';
            }, OCR_FAILURE_RESET_MS);
            console.error('[OCR lookup]', error);
        } finally {
            lookupInFlight = false;
        }
    }

    function buttonAriaLabel() {
        switch (lookupPhase) {
            case 'capturing':
                return 'Capturing viewport';
            case 'ocr':
                return 'Running OCR';
            case 'opening':
                return 'Opening Shirabe';
            case 'failed':
                return 'OCR failed';
            default:
                return 'Run OCR lookup';
        }
    }
</script>

<div
    use:tapToggle={{ onTap: toggleOcrButton }}
    use:swipeBack={{ onClose: handleClose, peekBack: () => appState.ui.peekBack() }}
    use:swipeLookup={{ onLookup: ocrAvailable ? handleLookup : () => undefined }}
>
    <Reader {session} onClose={handleClose} />
    {#if ocrAvailable && ocrButtonVisible && !ocrButtonSuppressed}
        <div class="reader-ocr-overlay" style={buttonOverlayStyle()}>
            <button
                class="reader-ocr-fab"
                class:reader-ocr-fab--busy={lookupPhase !== 'idle' && lookupPhase !== 'failed'}
                class:reader-ocr-fab--failed={lookupPhase === 'failed'}
                type="button"
                aria-label={buttonAriaLabel()}
                disabled={lookupInFlight}
                onclick={(event) => {
                    event.stopPropagation();
                    void handleLookup('button');
                }}
            >
                {#if lookupPhase === 'capturing'}
                    <svg class="reader-ocr-icon" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M5 7h3M16 7h3M5 17h3M16 17h3M7 5v3M17 5v3M7 16v3M17 16v3" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" />
                    </svg>
                {:else if lookupPhase === 'ocr'}
                    <svg class="reader-ocr-icon reader-ocr-icon--spin" viewBox="0 0 24 24" aria-hidden="true">
                        <circle cx="12" cy="12" r="8" fill="none" opacity="0.3" stroke="currentColor" stroke-width="2" />
                        <path d="M12 4a8 8 0 0 1 8 8" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2.4" />
                    </svg>
                {:else if lookupPhase === 'opening'}
                    <svg class="reader-ocr-icon" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M7 17 17 7M9 7h8v8" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.9" />
                    </svg>
                {:else if lookupPhase === 'failed'}
                    <svg class="reader-ocr-icon" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M12 7v6M12 17h.01M10.3 3.9 2.9 16.5A1 1 0 0 0 3.8 18h16.4a1 1 0 0 0 .9-1.5L13.7 3.9a1 1 0 0 0-1.7 0Z" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" />
                    </svg>
                {:else}
                    <svg class="reader-ocr-icon" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M4 8V5h3M20 8V5h-3M4 16v3h3M20 16v3h-3M8 9h8M8 12h8M8 15h5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" />
                    </svg>
                {/if}
            </button>
        </div>
    {/if}
</div>
