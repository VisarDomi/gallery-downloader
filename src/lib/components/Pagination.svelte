<script lang="ts">
    let {
        currentPage,
        totalPages,
        onPage,
    }: {
        currentPage: number;
        totalPages: number;
        onPage: (page: number) => void;
    } = $props();
</script>

{#if totalPages > 1}
    <div class="pagination">
        {#each Array(totalPages) as _, i}
            <button
                class="page-btn"
                class:active={i === currentPage}
                onclick={() => onPage(i)}
            >{i + 1}</button>
        {/each}
    </div>
{/if}
