<script lang="ts">
    import { appState } from '$lib/state/index.svelte.js';

    async function handleClick(query: string) {
        appState.saved.hide();
        await appState.searchAndPersist(() => appState.searchState.search(query));
    }
</script>

{#if appState.saved.visible}
<div class="saved-list">
    {#if !appState.saved.hasEntries}
        <div class="result-count">No saved entries</div>
    {:else}
        {#if appState.saved.queries.length > 0}
            <div class="saved-section">
                <div class="saved-section-title">Queries</div>
                <div class="saved-grid">
                    {#each appState.saved.queries as query}
                        <button class="saved-item" onclick={() => handleClick(query)}>{query}</button>
                    {/each}
                </div>
            </div>
        {/if}

        {#if appState.saved.artists.length > 0}
            <div class="saved-section">
                <div class="saved-section-title">Artists / Groups</div>
                <div class="saved-grid">
                    {#each appState.saved.artists as query}
                        <button class="saved-item" onclick={() => handleClick(query)}>{query}</button>
                    {/each}
                </div>
            </div>
        {/if}
    {/if}
</div>
{/if}
