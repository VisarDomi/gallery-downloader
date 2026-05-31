<script lang="ts">
    import { appState } from '$lib/state/index.svelte.js';
    import type { GalleryListItem, ViewMode, PaginatedGallerySource } from '$lib/types.js';
    import SearchBar from '$lib/components/SearchBar.svelte';
    import SavedSearches from '$lib/components/SavedSearches.svelte';
    import GalleryList from '$lib/components/GalleryList.svelte';
    import Pagination from '$lib/components/Pagination.svelte';

    let {
        viewId,
        galleries,
        total,
        label,
        source,
        query = '',
    }: {
        viewId: ViewMode;
        galleries: GalleryListItem[];
        total: number;
        label: string;
        source: PaginatedGallerySource;
        query?: string;
    } = $props();

</script>

<SearchBar />
<SavedSearches />

<div class="content-wrapper">
    <div class="results-info">
        <span class="count">{total}</span> {label}
        {#if query}
            <span class="query">{query}</span>
        {/if}
    </div>
    <Pagination
            currentPage={source.currentPage}
            totalPages={source.totalPages}
            onPage={(p) => appState.changePage(viewId, source, p)}
    />
    <div class="gallery-list-container">
        <GalleryList {galleries} />
    </div>

    <Pagination
        currentPage={source.currentPage}
        totalPages={source.totalPages}
        onPage={(p) => appState.changePage(viewId, source, p)}
    />
</div>
