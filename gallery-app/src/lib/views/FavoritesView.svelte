<script lang="ts">
    import { setContext } from 'svelte';
    import { appState } from '$lib/state/index.svelte.js';
    import GalleryPageView from './GalleryPageView.svelte';

    setContext('viewId', 'favorites');

    const galleries = $derived(appState.favorites.paginatedGalleries);
    const total = $derived(appState.favorites.favoriteGalleries.length);
</script>

<GalleryPageView
    viewId="favorites"
    {galleries}
    {total}
    label="favorites"
    source={appState.favorites}
/>
