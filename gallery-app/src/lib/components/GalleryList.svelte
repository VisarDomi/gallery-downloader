<script lang="ts">
    import type { GalleryListItem } from '$lib/types.js';
    import GalleryRow from './GalleryRow.svelte';

    let {
        galleries,
    }: {
        galleries: GalleryListItem[];
    } = $props();
</script>

{#each galleries as gallery (gallery.gallery_id)}
    <GalleryRow {gallery} />
{/each}
