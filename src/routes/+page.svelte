<script lang="ts">
    import { onMount } from 'svelte';
    import { appState } from '$lib/state.svelte.js';
    import ListView from '$lib/views/ListView.svelte';
    import ReaderView from '$lib/views/ReaderView.svelte';
    import SavedSearchesView from '$lib/views/SavedSearchesView.svelte';
    import FavoritesView from '$lib/views/FavoritesView.svelte';
    import Toast from '$lib/components/Toast.svelte';

    onMount(() => {
        appState.init();
    });

    const viewMode = $derived(appState.ui.viewMode);
    const prevMode = $derived(appState.ui.previousViewMode);
    const inReader = $derived(viewMode === 'reader');
    const isSwiping = $derived(appState.ui.isSwiping);
    const swipeAnimating = $derived(appState.ui.swipeAnimating);
    const swipeProgress = $derived(appState.ui.swipeProgress);

    // Which non-reader view is the swipe-back target?
    const listIsBack = $derived(inReader && prevMode === 'list' && isSwiping);
    const favIsBack = $derived(inReader && prevMode === 'favorites' && isSwiping);
    const savedIsBack = $derived(inReader && prevMode === 'saved' && isSwiping);
</script>

<!-- All 4 views always mounted as fixed scroll containers. Only visibility toggles. -->
<div
    id="view-list"
    class="view-layer"
    class:view-hidden={viewMode !== 'list' && !listIsBack}
    class:swipe-back={listIsBack}
    class:swipe-animating={listIsBack && swipeAnimating}
>
    <ListView />
</div>

<div
    id="view-favorites"
    class="view-layer"
    class:view-hidden={viewMode !== 'favorites' && !favIsBack}
    class:swipe-back={favIsBack}
    class:swipe-animating={favIsBack && swipeAnimating}
>
    <FavoritesView />
</div>

<div
    id="view-saved"
    class="view-layer"
    class:view-hidden={viewMode !== 'saved' && !savedIsBack}
    class:swipe-back={savedIsBack}
    class:swipe-animating={savedIsBack && swipeAnimating}
>
    <SavedSearchesView />
</div>

<div
    id="view-reader"
    class="view-layer"
    class:view-hidden={!inReader}
    class:swipe-active={isSwiping}
    class:swipe-animating={swipeAnimating}
    style="{isSwiping ? `transform:translateX(${swipeProgress * 100}%)` : ''}"
>
    <ReaderView />
</div>

<!-- Toast outside all view-layers so it's always visible -->
<Toast />
