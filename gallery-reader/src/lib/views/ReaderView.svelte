<script lang="ts">
    import { appState } from '$lib/state.svelte.js';
    import Reader from '$lib/components/Reader.svelte';

    const gallery = $derived(appState.reader.activeGallery);
    const startPage = $derived(appState.reader.currentPageIndex);

    function handleClose() {
        appState.reader.closeReader(appState.ui);
    }
</script>

<Reader {gallery} {startPage} onClose={handleClose} />
