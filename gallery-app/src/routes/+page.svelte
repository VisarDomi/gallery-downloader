<script lang="ts">
    import { onMount, onDestroy, setContext } from 'svelte';
    import { appState } from '$lib/state/index.svelte.js';
    import { initAppDimensions } from '$lib/state/appDimensions.js';
    import ListView from '$lib/views/ListView.svelte';
    import ReaderView from '$lib/views/ReaderView.svelte';
    import FavoritesView from '$lib/views/FavoritesView.svelte';
    import Toast from '$lib/components/Toast.svelte';

    onMount(() => {
        initAppDimensions();
        appState.init();
    });

    onDestroy(() => appState.destroy());

    let readerRoot = $state<HTMLElement | null>(null);
    setContext('readerRoot', () => readerRoot);

    const viewMode = $derived(appState.ui.viewMode);
</script>

<!-- Root is either search results or favorites; reader is the only second layer. -->
<div id="view-list" class="view-layer" class:view-hidden={viewMode !== 'list'}>
    <ListView />
</div>

<div id="view-favorites" class="view-layer" class:view-hidden={viewMode !== 'favorites'}>
    <FavoritesView />
</div>

<div id="view-reader" class="view-layer" class:view-hidden={viewMode !== 'reader'} bind:this={readerRoot}>
    <ReaderView />
</div>

<!-- Toast outside all view-layers so it's always visible -->
<Toast />
