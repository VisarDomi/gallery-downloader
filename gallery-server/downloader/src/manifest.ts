/**
 * Manifest parser: reads filters.txt, artists.txt, and queries.txt.
 *
 * Owns parsing of all three files. Never writes to them.
 *
 * filters.txt — base filter policy (language + exclusions)
 * artists.txt — tracked creators (namespace:name)
 * queries.txt — specific positive tag searches
 */

import fs from 'fs';

export interface Filters {
    language: string;
    negatives: string[];  // e.g. ['tag:anthology', 'female:scat']
}

export interface ArtistEntry {
    namespace: string;   // 'artist' | 'group'
    value: string;       // e.g. 'mizuryu_kei'
}

export interface QueryEntry {
    raw: string;         // just positive tokens, e.g. 'female:cheating'
}

export interface Manifest {
    filters: Filters;
    artists: ArtistEntry[];
    queries: QueryEntry[];
}

function parseFiltersFile(filePath: string): Filters {
    let content: string;
    try {
        content = fs.readFileSync(filePath, 'utf-8');
    } catch {
        return { language: 'japanese', negatives: [] };
    }

    let language = 'japanese';
    const negatives: string[] = [];

    for (const raw of content.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;

        if (line.startsWith('language:')) {
            language = line.slice('language:'.length).replace(/_/g, ' ');
            continue;
        }

        if (line.startsWith('-')) {
            const token = line.slice(1);
            if (token.includes(':')) {
                negatives.push(token);
            }
        }
    }

    return { language, negatives };
}

function parseArtistsFile(filePath: string): ArtistEntry[] {
    let content: string;
    try {
        content = fs.readFileSync(filePath, 'utf-8');
    } catch {
        return [];
    }

    const entries: ArtistEntry[] = [];

    for (const raw of content.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;

        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) continue;

        const namespace = line.slice(0, colonIdx);
        const value = line.slice(colonIdx + 1);

        if (namespace === 'artist' || namespace === 'group') {
            entries.push({ namespace, value });
        }
    }

    return entries;
}

function parseQueriesFile(filePath: string): QueryEntry[] {
    let content: string;
    try {
        content = fs.readFileSync(filePath, 'utf-8');
    } catch {
        return [];
    }

    const entries: QueryEntry[] = [];

    for (const raw of content.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        entries.push({ raw: line });
    }

    return entries;
}

export function loadManifest(filtersPath: string, artistsPath: string, queriesPath: string): Manifest {
    return {
        filters: parseFiltersFile(filtersPath),
        artists: parseArtistsFile(artistsPath),
        queries: parseQueriesFile(queriesPath),
    };
}
