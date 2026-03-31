<script lang="ts">
    import { setContext } from 'svelte';
    import { appState } from '$lib/state/index.svelte.js';
    import GalleryPageView from './GalleryPageView.svelte';

    setContext('viewId', 'list');

    const galleries = $derived(appState.searchState.paginatedGalleries);
    const total = $derived(appState.searchState.allGalleries.length);
    const query = $derived(appState.searchState.currentQuery);
</script>

<GalleryPageView
    viewId="list"
    {galleries}
    {total}
    label="results"
    source={appState.searchState}
    {query}
/>
