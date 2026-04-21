<script lang="ts">
    import { getContext } from 'svelte';
    import { appState } from '$lib/state/index.svelte.js';
    import { swipeBack } from '$lib/actions/swipeBack.js';
    import { swipeLookup } from '$lib/actions/swipeLookup.js';
    import Reader from '$lib/components/Reader.svelte';
    import { captureReaderViewport } from '$lib/services/captureViewport.js';
    import { ocrLookup } from '$lib/services/api.js';
    import { openShirabeLookup } from '$lib/services/shirabe.js';

    const session = $derived(appState.reader.session);
    const getReaderRoot = getContext<() => HTMLElement | null>('readerRoot');
    let lookupInFlight = false;

    type LookupPhase = 'capturing' | 'ocr' | 'opening' | 'failed';

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

    async function handleLookup() {
        if (lookupInFlight) return;
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
    use:swipeBack={{ onClose: handleClose, peekBack: () => appState.ui.peekBack() }}
    use:swipeLookup={{ onLookup: handleLookup }}
>
    <Reader {session} onClose={handleClose} />
</div>
