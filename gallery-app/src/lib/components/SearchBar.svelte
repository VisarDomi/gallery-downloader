<script lang="ts">
    import { appState } from '$lib/state/index.svelte.js';
    import { parseTaggedQuery, tokenToQuery } from 'gallery-sources';

    let inputValue = $state(appState.searchState.currentQuery);
    let selectedLanguage = $state('japanese');
    let selectedArtist = $state('');
    let selectedGroup = $state('');

    async function handleSubmit(e: Event) {
        e.preventDefault();
        await appState.searchAndPersist(() => appState.searchState.search(inputValue));
    }

    function handleFilterChange() {
        const parts: string[] = [];
        if (selectedLanguage) parts.push(tokenToQuery('language', selectedLanguage));
        if (selectedArtist) parts.push(tokenToQuery('artist', selectedArtist));
        if (selectedGroup) parts.push(tokenToQuery('group', selectedGroup));
        appState.searchAndPersist(() => appState.searchState.search(parts.join(' ')));
    }

    function syncDropdownsFromQuery(query: string) {
        try {
            const tokens = parseTaggedQuery(query).filter((token) => !token.negated);
            selectedLanguage = tokens.find((token) => token.namespace === 'language')?.value ?? '';
            selectedArtist = tokens.find((token) => token.namespace === 'artist')?.value ?? '';
            selectedGroup = tokens.find((token) => token.namespace === 'group')?.value ?? '';
        } catch {
            selectedLanguage = '';
            selectedArtist = '';
            selectedGroup = '';
        }
    }

    function handleSave() {
        appState.saved.save(appState.searchState.currentQuery);
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
            inputValue = appState.searchState.currentQuery;
            syncDropdownsFromQuery(appState.searchState.currentQuery);
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
            bind:value={selectedLanguage}
            onchange={handleFilterChange}
        >
            <option value="">Any Language</option>
            {#each appState.searchState.availableLanguages as [lang, count]}
                <option value={lang}>{lang} ({count})</option>
            {/each}
        </select>
        <select
            bind:value={selectedArtist}
            onchange={() => { selectedGroup = ''; handleFilterChange(); }}
        >
            <option value="">Any Artist</option>
            {#each appState.searchState.availableArtists as [artist, count]}
                <option value={artist}>{artist} ({count})</option>
            {/each}
        </select>
        <select
            bind:value={selectedGroup}
            onchange={() => { selectedArtist = ''; handleFilterChange(); }}
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
