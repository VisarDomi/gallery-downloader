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
    const backTarget = $derived(appState.ui.backTarget);
    const isSwiping = $derived(appState.ui.isSwiping);
    const swipeAnimating = $derived(appState.ui.swipeAnimating);
    const swipeProgress = $derived(appState.ui.swipeProgress);
</script>

<!-- All 4 views always mounted as fixed scroll containers. Only visibility toggles. -->
<div
    id="view-list"
    class="view-layer"
    class:view-hidden={viewMode !== 'list' && !(backTarget === 'list' && isSwiping)}
    class:swipe-back={backTarget === 'list' && isSwiping}
    class:swipe-animating={backTarget === 'list' && swipeAnimating}
>
    <ListView />
</div>

<div
    id="view-favorites"
    class="view-layer"
    class:view-hidden={viewMode !== 'favorites' && !(backTarget === 'favorites' && isSwiping)}
    class:swipe-back={backTarget === 'favorites' && isSwiping}
    class:swipe-active={viewMode === 'favorites' && isSwiping}
    class:swipe-animating={(backTarget === 'favorites' || viewMode === 'favorites') && swipeAnimating}
    style="{viewMode === 'favorites' && isSwiping ? `transform:translateX(${swipeProgress * 100}%)` : ''}"
>
    <FavoritesView />
</div>

<div
    id="view-saved"
    class="view-layer"
    class:view-hidden={viewMode !== 'saved' && !(backTarget === 'saved' && isSwiping)}
    class:swipe-back={backTarget === 'saved' && isSwiping}
    class:swipe-active={viewMode === 'saved' && isSwiping}
    class:swipe-animating={(backTarget === 'saved' || viewMode === 'saved') && swipeAnimating}
    style="{viewMode === 'saved' && isSwiping ? `transform:translateX(${swipeProgress * 100}%)` : ''}"
>
    <SavedSearchesView />
</div>

<div
    id="view-reader"
    class="view-layer"
    class:view-hidden={viewMode !== 'reader'}
    class:swipe-active={viewMode === 'reader' && isSwiping}
    class:swipe-animating={viewMode === 'reader' && swipeAnimating}
    style="{viewMode === 'reader' && isSwiping ? `transform:translateX(${swipeProgress * 100}%)` : ''}"
>
    <ReaderView />
</div>

<!-- Toast outside all view-layers so it's always visible -->
<Toast />
