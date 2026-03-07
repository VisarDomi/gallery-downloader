import * as api from '../services/api.js';
import * as db from '../services/db.js';
import type { FavoritesState } from './favorites.svelte.js';
import type { ReaderState } from './reader.svelte.js';
import type { SearchState } from './search.svelte.js';

export class DeleteState {
    private deps: { favorites: FavoritesState; reader: ReaderState; search: SearchState };

    constructor(deps: { favorites: FavoritesState; reader: ReaderState; search: SearchState }) {
        this.deps = deps;
    }

    async deleteGalleries(ids: number[]): Promise<{ deleted: number[]; skipped: { id: number; reason: string }[] }> {
        const result = await api.deleteGalleries(ids);

        if (result.deleted.length > 0) {
            await db.removeGalleries(result.deleted);

            const deletedSet = new Set(result.deleted);
            this.deps.favorites.removeGalleries(deletedSet);
            this.deps.reader.removeProgress(deletedSet);
            this.deps.search.removeGalleries(deletedSet);
        }

        return result;
    }
}
