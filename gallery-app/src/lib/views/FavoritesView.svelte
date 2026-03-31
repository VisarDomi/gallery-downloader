<script lang="ts">
    import { appState } from '$lib/state/index.svelte.js';
    import { swipeBack } from '$lib/actions/swipeBack.js';
    import GalleryPageView from './GalleryPageView.svelte';

    const galleries = $derived(appState.favorites.paginatedGalleries);
    const total = $derived(appState.favorites.favoriteGalleries.length);

    function handleSwipeBack() {
        appState.ui.popView();
    }
</script>

<div use:swipeBack={{ onClose: handleSwipeBack, peekBack: () => appState.ui.peekBack() }}>
    <GalleryPageView
        viewId="favorites"
        {galleries}
        {total}
        label="favorites"
        source={appState.favorites}
        allowReplay={true}
    />
</div>
