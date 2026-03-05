<script lang="ts">
    import type { Gallery } from '$lib/types.js';
    import * as api from '$lib/services/api.js';
    import { appState } from '$lib/state.svelte.js';

    let { galleryId, onClose, onSearchFilter }: {
        galleryId: number;
        onClose: () => void;
        onSearchFilter?: (opts: { artist?: string; group?: string; language?: string }) => void;
    } = $props();

    let gallery = $state<Gallery | null>(null);
    let deleting = $state(false);

    $effect(() => {
        api.getGallery(galleryId).then(g => gallery = g);
    });

    const title = $derived(gallery?.title || 'No Title');

    function handleBackdropClick(e: MouseEvent) {
        if (e.target === e.currentTarget) onClose();
    }

    async function handleDelete() {
        if (deleting) return;
        deleting = true;
        try {
            const result = await appState.delete_.deleteGalleries([galleryId]);
            if (result.deleted.length > 0) {
                appState.toast.show('Deleted');
                onClose();
            } else if (result.skipped.length > 0) {
                appState.toast.show(`Skipped: ${result.skipped[0].reason}`, 3000);
            }
        } catch (e) {
            appState.toast.show(`Delete failed: ${e}`, 3000);
        } finally {
            deleting = false;
        }
    }

    $effect(() => {
        document.body.style.overflow = 'hidden';
        return () => {
            document.body.style.overflow = '';
        };
    });
</script>

<div class="modal-backdrop" role="button" tabindex="-1" onclick={handleBackdropClick} onkeydown={(e) => { if (e.key === 'Escape') onClose(); }}>
    <div class="modal-content">
        {#if gallery}
            <div class="modal-header">
                {#if gallery.title_jpn}
                    <h2>{gallery.title_jpn}</h2>
                {/if}
                <h2>{title}</h2>
            </div>
            <div class="modal-body">
                {#if gallery.artist?.length}
                    <div class="modal-row">
                        <span class="modal-label">Artist</span>
                        <span class="modal-value">
                            {#each gallery.artist as artist, i}
                                {#if i > 0}, {/if}
                                {#if onSearchFilter}
                                    <button class="modal-value-link" onclick={() => onSearchFilter({ artist, language: gallery!.language })}>{artist}</button>
                                {:else}
                                    {artist}
                                {/if}
                            {/each}
                        </span>
                    </div>
                {/if}
                {#if gallery.group?.length}
                    <div class="modal-row">
                        <span class="modal-label">Group</span>
                        <span class="modal-value">
                            {#each gallery.group as group, i}
                                {#if i > 0}, {/if}
                                {#if onSearchFilter}
                                    <button class="modal-value-link" onclick={() => onSearchFilter({ group, language: gallery!.language })}>{group}</button>
                                {:else}
                                    {group}
                                {/if}
                            {/each}
                        </span>
                    </div>
                {/if}
                {#if gallery.parody?.length}
                    <div class="modal-row">
                        <span class="modal-label">Series</span>
                        <span class="modal-value">{gallery.parody.join(', ')}</span>
                    </div>
                {/if}
                {#if gallery.type}
                    <div class="modal-row">
                        <span class="modal-label">Type</span>
                        <span class="modal-value">{gallery.type}</span>
                    </div>
                {/if}
                {#if gallery.language}
                    <div class="modal-row">
                        <span class="modal-label">Language</span>
                        <span class="modal-value">{gallery.language}</span>
                    </div>
                {/if}
                {#if gallery.date}
                    <div class="modal-row">
                        <span class="modal-label">Date</span>
                        <span class="modal-value">{gallery.date}</span>
                    </div>
                {/if}
                {#if gallery.tags?.length}
                    <div class="modal-row" style="display:block; border:none;">
                        <div class="modal-label" style="margin-bottom:6px">Tags</div>
                        <div class="tag-cloud">
                            {#each gallery.tags as tag}
                                <span class="tag-chip">{tag}</span>
                            {/each}
                        </div>
                    </div>
                {/if}
            </div>
        {:else}
            <div class="modal-body" style="text-align:center; padding:2rem;">
                Loading...
            </div>
        {/if}
        <div class="modal-footer">
            <button class="modal-delete-btn" onclick={handleDelete} disabled={deleting}>
                {deleting ? 'Deleting...' : 'Delete'}
            </button>
            <button class="modal-ok-btn" onclick={onClose}>OK</button>
        </div>
    </div>
</div>
