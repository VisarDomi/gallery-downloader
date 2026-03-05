<script lang="ts">
    import { appState } from '$lib/state.svelte.js';
    import { swipeBack } from '$lib/actions/swipeBack.js';
    import Reader from '$lib/components/Reader.svelte';

    const gallery = $derived(appState.reader.activeGallery);
    const startPage = $derived(appState.reader.currentPageIndex);

    function handleClose() {
        appState.reader.closeReader(appState.ui);
    }
</script>

<div use:swipeBack={handleClose}>
    <Reader {gallery} {startPage} onClose={handleClose} />
</div>
