/**
 * Manifest resolver: single owner of "what gallery IDs are wanted."
 *
 * Loads all three manifest files, resolves IDs from hitomi, applies
 * the filter policy (language + exclusions) from filters.txt.
 *
 * Consumers (sync, remove) call this — they own execution flow and
 * error policy, but NOT resolution logic.
 */

import { loadManifest, type Manifest } from './manifest.js';
import { resolveArtistEntry, resolveQuery, resolveTag } from './resolver.js';

function delay(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

/** Build a full query string: language + positive tokens + filter negatives. */
function buildMergedQuery(queryPositives: string, language: string, negatives: string[]): string {
    const parts = [`language:${language}`, queryPositives.trim()];
    for (const neg of negatives) {
        parts.push(`-${neg}`);
    }
    return parts.join(' ');
}

/** Subtract all filter negatives from an ID set. */
async function subtractNegatives(
    ids: Set<number>,
    negatives: string[],
    language: string,
    onExcluded?: (tag: string, removed: number, remaining: number) => void,
): Promise<string[]> {
    const errors: string[] = [];
    for (const tag of negatives) {
        const result = await resolveTag(tag, language);
        if (result.errors.length > 0) {
            errors.push(...result.errors);
        } else {
            const before = ids.size;
            for (const id of result.ids) ids.delete(id);
            onExcluded?.(tag, before - ids.size, ids.size);
        }
        await delay(100);
    }
    return errors;
}

export interface ResolutionResult {
    wantedIds: Set<number>;
    artistCount: number;
    queryCount: number;
    errors: string[];
}

export interface ResolutionCallbacks {
    onArtistResolved?: (resolved: number, total: number, idsSoFar: number) => void;
    onTagExcluded?: (tag: string, removed: number, remaining: number) => void;
    onQueryResolved?: (resolved: number, total: number, queryIds: number, totalIds: number) => void;
}

/**
 * Resolve the complete wanted ID set from all three manifest files.
 *
 * 1. Resolve all artist/group entries in the filter language
 * 2. Subtract ALL filter negatives from artist IDs
 * 3. Resolve all query entries with filter language + negatives merged in
 *
 * The caller decides error policy (sync continues, remove aborts).
 */
export async function resolveManifest(
    filtersPath: string,
    artistsPath: string,
    queriesPath: string,
    callbacks?: ResolutionCallbacks,
): Promise<ResolutionResult> {
    const manifest = loadManifest(filtersPath, artistsPath, queriesPath);
    const { language, negatives } = manifest.filters;
    const wantedIds = new Set<number>();
    const errors: string[] = [];

    // Phase 1: Resolve artist entries
    for (let i = 0; i < manifest.artists.length; i++) {
        const entry = manifest.artists[i];
        const result = await resolveArtistEntry(entry.namespace, entry.value, language);
        for (const id of result.ids) wantedIds.add(id);
        errors.push(...result.errors);
        callbacks?.onArtistResolved?.(i + 1, manifest.artists.length, wantedIds.size);
    }

    // Phase 2: Subtract all filter negatives from artist IDs
    const tagErrors = await subtractNegatives(
        wantedIds, negatives, language, callbacks?.onTagExcluded,
    );
    errors.push(...tagErrors);

    // Phase 3: Resolve query entries with filters merged in
    for (let i = 0; i < manifest.queries.length; i++) {
        const entry = manifest.queries[i];
        const mergedQuery = buildMergedQuery(entry.raw, language, negatives);
        const result = await resolveQuery(mergedQuery);
        for (const id of result.ids) wantedIds.add(id);
        errors.push(...result.errors);
        callbacks?.onQueryResolved?.(i + 1, manifest.queries.length, result.ids.size, wantedIds.size);
    }

    return {
        wantedIds,
        artistCount: manifest.artists.length,
        queryCount: manifest.queries.length,
        errors,
    };
}

/**
 * Resolve a single entry's IDs with filter policy applied.
 * Used by the remove endpoint to compute what a removed entry contributed.
 */
export async function resolveEntryWithFilters(
    manifest: Manifest,
    file: 'artists' | 'queries',
    line: string,
): Promise<{ ids: Set<number>; errors: string[] }> {
    const { language, negatives } = manifest.filters;
    const errors: string[] = [];

    if (file === 'artists') {
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) return { ids: new Set(), errors };

        const ns = line.slice(0, colonIdx);
        const val = line.slice(colonIdx + 1);
        const entry = manifest.artists.find(a => a.namespace === ns && a.value === val);
        if (!entry) return { ids: new Set(), errors };

        const result = await resolveArtistEntry(entry.namespace, entry.value, language);
        errors.push(...result.errors);

        const tagErrors = await subtractNegatives(result.ids, negatives, language);
        errors.push(...tagErrors);

        return { ids: result.ids, errors };
    } else {
        const mergedQuery = buildMergedQuery(line, language, negatives);
        const result = await resolveQuery(mergedQuery);
        return { ids: result.ids, errors: result.errors };
    }
}
