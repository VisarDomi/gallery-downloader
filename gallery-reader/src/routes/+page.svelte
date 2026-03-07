<script lang="ts">
    import { onMount, setContext } from 'svelte';
    import { appState } from '$lib/state/index.svelte.js';
    import ListView from '$lib/views/ListView.svelte';
    import ReaderView from '$lib/views/ReaderView.svelte';
    import SavedSearchesView from '$lib/views/SavedSearchesView.svelte';
    import FavoritesView from '$lib/views/FavoritesView.svelte';
    import Toast from '$lib/components/Toast.svelte';

    onMount(() => {
        appState.init();
    });

    let readerRoot = $state<HTMLElement | null>(null);
    setContext('readerRoot', () => readerRoot);

    const viewMode = $derived(appState.ui.viewMode);
    const isSwiping = $derived(appState.ui.isSwiping);
    const swipeAnimating = $derived(appState.ui.swipeAnimating);
    const swipeProgress = $derived(appState.ui.swipeProgress);
    const backView = $derived(isSwiping ? appState.ui.peekBack() : null);
</script>

<!-- All 4 views always mounted as fixed scroll containers. Only visibility toggles. -->
<div
    id="view-list"
    class="view-layer"
    class:view-hidden={viewMode !== 'list' && backView !== 'list'}
    class:swipe-back={backView === 'list'}
    class:swipe-animating={backView === 'list' && swipeAnimating}
>
    <ListView />
</div>

<div
    id="view-favorites"
    class="view-layer"
    class:view-hidden={viewMode !== 'favorites' && backView !== 'favorites'}
    class:swipe-back={backView === 'favorites'}
    class:swipe-active={viewMode === 'favorites' && isSwiping}
    class:swipe-animating={backView === 'favorites' && swipeAnimating}
    style="{viewMode === 'favorites' && isSwiping ? `transform:translateX(${swipeProgress * 100}%)` : ''}"
>
    <FavoritesView />
</div>

<div
    id="view-saved"
    class="view-layer"
    class:view-hidden={viewMode !== 'saved' && backView !== 'saved'}
    class:swipe-back={backView === 'saved'}
    class:swipe-active={viewMode === 'saved' && isSwiping}
    class:swipe-animating={backView === 'saved' && swipeAnimating}
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
    bind:this={readerRoot}
>
    <ReaderView />
</div>

<!-- Toast outside all view-layers so it's always visible -->
<Toast />
