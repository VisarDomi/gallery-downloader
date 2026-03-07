<script lang="ts">
    import { appState } from '$lib/state/index.svelte.js';

    const searches = $derived(appState.saved.savedSearches);

    function handleClick(query: string) {
        appState.searchState.restoreFromQuery(query);
        appState.ui.pushView('list');
    }

    function handleDelete(e: Event, query: string) {
        e.stopPropagation();
        appState.saved.remove(query);
    }
</script>

<div class="saved-list">
    {#if searches.length === 0}
        <div class="result-count">No saved searches</div>
    {:else}
        {#each searches as query}
            <button class="saved-item" onclick={() => handleClick(query)}>
                <span class="saved-item-query">{query}</span>
                <span class="saved-item-delete" role="button" tabindex="0" onclick={(e) => handleDelete(e, query)} onkeydown={(e) => { if (e.key === 'Enter') handleDelete(e, query); }}>&#x2715;</span>
            </button>
        {/each}
    {/if}
</div>
