<script lang="ts">
    import { appState } from '$lib/state.svelte.js';
    import { swipeBack } from '$lib/actions/swipeBack.js';
    import SearchBar from '$lib/components/SearchBar.svelte';
    import SavedSearches from '$lib/components/SavedSearches.svelte';

    function handleSwipeBack() {
        appState.ui.popView();
    }
</script>

<div use:swipeBack={{ onClose: handleSwipeBack, ui: appState.ui }}>
    <SearchBar />
    <SavedSearches />
</div>
