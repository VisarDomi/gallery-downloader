import * as db from '../services/db.js';

export class SavedState {
    savedSearches = $state<string[]>([]);

    async init() {
        this.savedSearches = await db.getAllSavedSearches();
    }

    async save(query: string) {
        if (!query || this.savedSearches.includes(query)) return;
        await db.addSavedSearch(query);
        this.savedSearches = [...this.savedSearches, query];
    }

    async remove(query: string) {
        await db.removeSavedSearch(query);
        this.savedSearches = this.savedSearches.filter(q => q !== query);
    }
}
