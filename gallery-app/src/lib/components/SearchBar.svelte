<script lang="ts">
    import { appState } from '$lib/state/index.svelte.js';

    let inputValue = $state(appState.searchState.fullQuery);

    function freeText() {
        return inputValue.replace(/\b(language|artist|group):\S+/g, '').trim();
    }

    async function handleSubmit(e: Event) {
        e.preventDefault();
        await appState.searchAndPersist(() => appState.searchState.restoreFromQuery(inputValue));
    }

    function handleFilterChange() {
        appState.searchAndPersist(() => appState.searchState.search(freeText()));
    }

    function handleSave() {
        appState.saved.save(appState.searchState.fullQuery);
        appState.toast.show('Search saved');
    }

    function handleSavedView() {
        if (appState.ui.viewMode === 'saved') {
            appState.ui.popView();
        } else {
            appState.ui.pushView('saved');
        }
    }

    function handleFavoritesView() {
        if (appState.ui.viewMode === 'favorites') {
            appState.ui.popView();
        } else {
            appState.openFavorites();
        }
    }

    $effect(() => {
        if (!appState.searchState.isLoading) {
            inputValue = appState.searchState.fullQuery;
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

    <div class="filter-row">
        <select
            bind:value={appState.searchState.selectedLanguage}
            onchange={handleFilterChange}
        >
            <option value="">Any Language</option>
            {#each appState.searchState.availableLanguages as [lang, count]}
                <option value={lang}>{lang} ({count})</option>
            {/each}
        </select>
        <select
            bind:value={appState.searchState.selectedArtist}
            onchange={() => { appState.searchState.selectedGroup = ''; handleFilterChange(); }}
        >
            <option value="">Any Artist</option>
            {#each appState.searchState.availableArtists as [artist, count]}
                <option value={artist}>{artist} ({count})</option>
            {/each}
        </select>
        <select
            bind:value={appState.searchState.selectedGroup}
            onchange={() => { appState.searchState.selectedArtist = ''; handleFilterChange(); }}
        >
            <option value="">Any Group</option>
            {#each appState.searchState.availableGroups as [group, count]}
                <option value={group}>{group} ({count})</option>
            {/each}
        </select>
    </div>

    <div class="action-row">
        <button class="action-btn" onclick={handleSave}>Save</button>
        <button
            class="action-btn"
            class:active={appState.ui.viewMode === 'saved'}
            onclick={handleSavedView}
        >Saved</button>
        <button
            class="action-btn"
            class:active={appState.ui.viewMode === 'favorites'}
            onclick={handleFavoritesView}
        >Favs</button>
    </div>
</div>
