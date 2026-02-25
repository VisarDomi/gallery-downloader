<script lang="ts">
    import type { Gallery } from '$lib/types.js';
    import GalleryRow from './GalleryRow.svelte';

    let {
        galleries,
        allowReplay = false,
    }: {
        galleries: Gallery[];
        allowReplay?: boolean;
    } = $props();
</script>

{#each galleries as gallery (gallery.gallery_id)}
    <GalleryRow {gallery} {allowReplay} />
{/each}
