<script lang="ts">
    import { onMount } from 'svelte';
    import { getContext } from 'svelte';
    import { appState } from '$lib/state/index.svelte.js';
    import { tapToggle } from '$lib/actions/tapToggle.js';
    import { swipeBack } from '$lib/actions/swipeBack.js';
    import { swipeLookup } from '$lib/actions/swipeLookup.js';
    import Reader from '$lib/components/Reader.svelte';
    import { captureReaderViewport } from '$lib/services/captureViewport.js';
    import { ocrLookup } from '$lib/services/api.js';
    import { openShirabeLookup } from '$lib/services/shirabe.js';

    const session = $derived(appState.reader.session);
    const getReaderRoot = getContext<() => HTMLElement | null>('readerRoot');
    let lookupInFlight = $state(false);
    let ocrButtonVisible = $state(false);
    let ocrButtonSuppressed = $state(false);
    let buttonViewportRect = $state({
        left: 0,
        top: 0,
        width: 0,
        height: 0,
        scale: 1,
    });

    type LookupPhase = 'capturing' | 'ocr' | 'opening' | 'failed';
    const VIEWPORT_SETTLE_MS = 220;
    const OCR_BUTTON_MARGIN_PX = 16;

    function phaseMessage(phase: LookupPhase) {
        switch (phase) {
            case 'capturing':
                return 'OCR: capturing viewport';
            case 'ocr':
                return 'OCR: running PaddleOCR';
            case 'opening':
                return 'OCR: opening Shirabe';
            case 'failed':
                return 'OCR lookup failed';
        }
    }

    function handleClose() {
        appState.reader.closeReader();
    }

    function toggleOcrButton() {
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
        return [
            `left:${buttonViewportRect.left + buttonViewportRect.width - OCR_BUTTON_MARGIN_PX}px`,
            `top:${buttonViewportRect.top + buttonViewportRect.height - OCR_BUTTON_MARGIN_PX}px`,
            `--reader-ocr-scale:${buttonViewportRect.scale > 0 ? 1 / buttonViewportRect.scale : 1}`,
        ].join(';');
    }

    onMount(() => {
        const viewport = window.visualViewport;
        let settleTimer: ReturnType<typeof setTimeout> | undefined;

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

        return () => {
            if (settleTimer) clearTimeout(settleTimer);
            viewport?.removeEventListener('resize', suppressTemporarily);
            viewport?.removeEventListener('scroll', suppressTemporarily);
            window.removeEventListener('scroll', suppressTemporarily);
            window.removeEventListener('resize', suppressTemporarily);
        };
    });

    async function handleLookup(source: 'swipe' | 'button' = 'swipe') {
        if (lookupInFlight) return;
        ocrButtonVisible = false;
        appState.log.emit('reader-ocr-trigger', { source });
        const toastId = appState.toast.showPersistent(phaseMessage('capturing'));
        const root = getReaderRoot();
        if (!root) {
            appState.toast.update(toastId, 'Reader viewport unavailable');
            appState.toast.dismissLater(toastId, 3000);
            return;
        }

        lookupInFlight = true;
        try {
            const image = await captureReaderViewport(root);
            appState.toast.update(toastId, phaseMessage('ocr'));
            const result = await ocrLookup(image);
            appState.toast.update(toastId, phaseMessage('opening'));
            openShirabeLookup(result.text);
            appState.toast.dismiss(toastId);
        } catch (error) {
            appState.toast.update(toastId, phaseMessage('failed'));
            appState.toast.dismissLater(toastId, 3000);
            console.error('[OCR lookup]', error);
        } finally {
            lookupInFlight = false;
        }
    }
</script>

<div
    use:tapToggle={{ onTap: toggleOcrButton }}
    use:swipeBack={{ onClose: handleClose, peekBack: () => appState.ui.peekBack() }}
    use:swipeLookup={{ onLookup: handleLookup }}
>
    <Reader {session} onClose={handleClose} />
    {#if ocrButtonVisible && !ocrButtonSuppressed}
        <div class="reader-ocr-overlay" style={buttonOverlayStyle()}>
            <button
                class="reader-ocr-fab"
                type="button"
                aria-label="Run OCR lookup"
                disabled={lookupInFlight}
                onclick={(event) => {
                    event.stopPropagation();
                    void handleLookup('button');
                }}
            >
                <svg
                    class="reader-ocr-icon"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                >
                    <path
                        d="M4 8V5h3M20 8V5h-3M4 16v3h3M20 16v3h-3M8 9h8M8 12h8M8 15h5"
                        fill="none"
                        stroke="currentColor"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="1.8"
                    />
                </svg>
            </button>
        </div>
    {/if}
</div>
