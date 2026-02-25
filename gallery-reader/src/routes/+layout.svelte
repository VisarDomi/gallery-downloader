<script lang="ts">
    import '$lib/styles.css';
    import { onMount } from 'svelte';

    let { children } = $props();

    onMount(() => {
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/sw.js');
        }
    });
</script>

<svelte:head>
    <title>Hitomi Reader</title>
</svelte:head>

<div class="safe-area">
    {@render children()}
</div>

<style>
    .safe-area {
        padding-top: env(safe-area-inset-top, 0px);
    }
</style>
