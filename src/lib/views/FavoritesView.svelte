<script lang="ts">
    import { appState } from '$lib/state.svelte.js';
    import SearchBar from '$lib/components/SearchBar.svelte';
    import GalleryList from '$lib/components/GalleryList.svelte';
    import Pagination from '$lib/components/Pagination.svelte';

    const galleries = $derived(appState.favorites.paginatedGalleries);
    const total = $derived(appState.favorites.favoriteGalleries.length);

    function scrollToTop() {
        document.getElementById('view-favorites')?.scrollTo(0, 0);
    }
</script>

<SearchBar />

<div class="content-wrapper">
    <div class="results-info">
        <span class="count">{total}</span> favorites
    </div>

    <div class="gallery-list-container">
        <GalleryList {galleries} allowReplay={true} />
    </div>

    <Pagination
        currentPage={appState.favorites.currentPage}
        totalPages={appState.favorites.totalPages}
        onPage={(p) => { appState.favorites.currentPage = p; scrollToTop(); }}
    />
</div>
