import * as db from '../services/db.js';
import * as api from '../services/api.js';
import type { LogEmit } from '../services/LogService.js';

export class SavedState {
    private emit: LogEmit;
    savedSearches = $state<string[]>([]);
    /** Queries from queries.txt — always shown, not deletable by user */
    defaultQueries = $state<string[]>([]);

    constructor(emit: LogEmit) {
        this.emit = emit;
    }

    async init() {
        const [userSearches, defaults] = await Promise.all([
            db.getAllSavedSearches(),
            api.fetchDefaultQueries().catch((e) => {
                this.emit('queries-load-failed', { error: String(e) });
                return [];
            }),
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
