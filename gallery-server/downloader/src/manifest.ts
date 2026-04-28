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
import { parseTaggedQuery, serializeTaggedQuery } from 'gallery-sources';

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
            const tokens = parseTaggedQuery(line);
            if (tokens.length === 1 && tokens[0].namespace === 'language' && !tokens[0].negated) {
                language = tokens[0].value;
            }
            continue;
        }

        if (line.startsWith('-')) {
            const tokens = parseTaggedQuery(line);
            if (tokens.length === 1 && tokens[0].negated) {
                negatives.push(`${tokens[0].namespace}:${tokens[0].value}`);
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

        const tokens = parseTaggedQuery(line);
        if (tokens.length !== 1 || tokens[0].negated) continue;
        const [{ namespace, value }] = tokens;

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
        const tokens = parseTaggedQuery(line);
        if (tokens.length === 0 || tokens.some(token => token.negated)) continue;
        entries.push({ raw: serializeTaggedQuery(tokens) });
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
