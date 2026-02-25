<script lang="ts">
    import { appState } from '$lib/state.svelte.js';
</script>

{#if appState.toast.items.length > 0}
    <div class="toast-container">
        {#each appState.toast.items as toast (toast.id)}
            <div class="toast">{toast.message}</div>
        {/each}
    </div>
{/if}
