<script lang="ts">
    import { appState } from '$lib/state/index.svelte.js';

    let inputValue = $state(appState.searchState.currentQuery);

    async function handleSubmit(e: Event) {
        e.preventDefault();
        await appState.searchAndPersist(() => appState.searchState.search(inputValue));
    }

    function handleSavedView() {
        appState.saved.toggleVisible();
    }

    function handleFavoritesView() {
        appState.saved.hide();
        if (appState.ui.rootView === 'favorites' && appState.ui.viewMode !== 'reader') {
            appState.openList();
        } else {
            appState.openFavorites();
        }
    }

    $effect(() => {
        if (!appState.searchState.isLoading) {
            inputValue = appState.searchState.currentQuery;
        }
    });

</script>

<div class="search-bar-wrapper">
    <form class="input-container" onsubmit={handleSubmit}>
        <input
            type="text"
            placeholder="Search..."
            bind:value={inputValue}
            disabled={appState.searchState.isLoading}
        />
        {#if appState.searchState.isLoading}
            <div class="search-spinner"></div>
        {/if}
    </form>

    <div class="action-row">
        <button
            class="action-btn"
            class:active={appState.saved.visible}
            onclick={handleSavedView}
        >Saved</button>
        <button
            class="action-btn"
            class:active={appState.ui.viewMode === 'favorites'}
            onclick={handleFavoritesView}
        >Favs</button>
    </div>
</div>
