<script lang="ts">
    import { appState } from '$lib/state/index.svelte.js';
    import { swipeBack } from '$lib/actions/swipeBack.js';
    import Reader from '$lib/components/Reader.svelte';

    const gallery = $derived(appState.reader.activeGallery);
    const startPage = $derived(appState.reader.currentPageIndex);

    function handleClose() {
        appState.reader.closeReader();
    }
</script>

<div use:swipeBack={{ onClose: handleClose, ui: appState.ui }}>
    <Reader {gallery} {startPage} onClose={handleClose} />
</div>
