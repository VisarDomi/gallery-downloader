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

    function handleClose() {
        appState.reader.closeReader();
    }

    async function handleLookup() {
        if (lookupInFlight) return;
        const root = getReaderRoot();
        if (!root) {
            appState.toast.show('Reader viewport unavailable');
            return;
        }

        lookupInFlight = true;
        try {
            const image = await captureReaderViewport(root);
            const result = await ocrLookup(image);
            openShirabeLookup(result.text);
        } catch (error) {
            appState.toast.show('OCR lookup failed');
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
