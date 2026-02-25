<script lang="ts">
    import { appState } from '$lib/state.svelte.js';
    import SearchBar from '$lib/components/SearchBar.svelte';
    import GalleryList from '$lib/components/GalleryList.svelte';
    import Pagination from '$lib/components/Pagination.svelte';

    const galleries = $derived(appState.searchState.paginatedGalleries);
    const total = $derived(appState.searchState.allGalleries.length);
    const query = $derived(appState.searchState.currentQuery);

    function scrollToTop() {
        document.getElementById('view-list')?.scrollTo(0, 0);
    }
</script>

<SearchBar />

<div class="content-wrapper">
    <div class="results-info">
        <span class="count">{total}</span> results
        {#if query}
            <span class="query">{query}</span>
        {/if}
    </div>

    <div class="gallery-list-container">
        <GalleryList {galleries} />
    </div>

    <Pagination
        currentPage={appState.searchState.currentPage}
        totalPages={appState.searchState.totalPages}
        onPage={(p) => { appState.searchState.currentPage = p; scrollToTop(); }}
    />
</div>
