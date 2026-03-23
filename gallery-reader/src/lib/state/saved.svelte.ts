import * as db from '../services/db.js';
import * as api from '../services/api.js';

export class SavedState {
    savedSearches = $state<string[]>([]);
    /** Queries from queries.txt — always shown, not deletable by user */
    defaultQueries = $state<string[]>([]);

    async init() {
        const [userSearches, defaults] = await Promise.all([
            db.getAllSavedSearches(),
            api.fetchDefaultQueries().catch(() => []),
        ]);
        this.defaultQueries = defaults;
        this.savedSearches = userSearches;
    }

    /** All searches: defaults first, then user-added */
    get allSearches(): { query: string; isDefault: boolean }[] {
        const defaultSet = new Set(this.defaultQueries);
        const result: { query: string; isDefault: boolean }[] = [];

        for (const q of this.defaultQueries) {
            result.push({ query: q, isDefault: true });
        }
        for (const q of this.savedSearches) {
            if (!defaultSet.has(q)) {
                result.push({ query: q, isDefault: false });
            }
        }

        return result;
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
