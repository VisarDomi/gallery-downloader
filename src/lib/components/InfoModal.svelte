<script lang="ts">
    import type { Gallery } from '$lib/types.js';

    let { gallery, onClose, onSearchFilter }: {
        gallery: Gallery;
        onClose: () => void;
        onSearchFilter?: (opts: { artist?: string; group?: string; language?: string }) => void;
    } = $props();

    const title = $derived(gallery.title || 'No Title');

    function handleBackdropClick(e: MouseEvent) {
        if (e.target === e.currentTarget) onClose();
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
                                <button class="modal-value-link" onclick={() => onSearchFilter({ artist, language: gallery.language })}>{artist}</button>
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
                                <button class="modal-value-link" onclick={() => onSearchFilter({ group, language: gallery.language })}>{group}</button>
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
        <div class="modal-footer">
            <button class="modal-ok-btn" onclick={onClose}>OK</button>
        </div>
    </div>
</div>
