<script lang="ts">
    import { appState } from '$lib/state/index.svelte.js';
    import { swipeBack } from '$lib/actions/swipeBack.js';
    import Reader from '$lib/components/Reader.svelte';

    const session = $derived(appState.reader.session);

    function handleClose() {
        appState.reader.closeReader();
    }
</script>

<div use:swipeBack={{ onClose: handleClose, peekBack: () => appState.ui.peekBack() }}>
    <Reader {session} getStartPosition={() => appState.reader.currentPosition} onClose={handleClose} />
</div>
