import * as api from '../services/api.js';
import type { LogEmit } from '../services/LogService.js';

export class SavedState {
    private emit: LogEmit;
    queries = $state<string[]>([]);
    artists = $state<string[]>([]);
    visible = $state(false);

    constructor(emit: LogEmit) {
        this.emit = emit;
    }

    async init() {
        const [queries, artists] = await Promise.all([
            api.fetchDefaultQueries().catch((e) => {
                this.emit('queries-load-failed', { error: String(e) });
                return [];
            }),
            api.getTrackedArtists().catch((e) => {
                this.emit('artists-load-failed', { error: String(e) });
                return [];
            }),
        ]);
        this.queries = queries;
        this.artists = artists;
    }

    get hasEntries(): boolean {
        return this.queries.length > 0 || this.artists.length > 0;
    }

    toggleVisible() {
        this.visible = !this.visible;
    }

    hide() {
        this.visible = false;
    }
}
