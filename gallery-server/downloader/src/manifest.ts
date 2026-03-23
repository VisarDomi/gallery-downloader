/**
 * Manifest parser: reads artists.txt and queries.txt.
 *
 * These files are the declarative source of truth for what should exist.
 * This module only parses — it never writes to these files.
 */

import fs from 'fs';

export interface ArtistEntry {
    namespace: string;   // 'artist' | 'group'
    value: string;       // e.g. 'mizuryu_kei'
    language: string;    // default 'japanese'
}

export interface QueryEntry {
    raw: string;         // the full query line as written
}

export interface Manifest {
    artists: ArtistEntry[];
    queries: QueryEntry[];
}

function parseArtistsFile(filePath: string): ArtistEntry[] {
    let content: string;
    try {
        content = fs.readFileSync(filePath, 'utf-8');
    } catch {
        return [];
    }

    const entries: ArtistEntry[] = [];
    let currentLanguage = 'japanese';

    for (const raw of content.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;

        if (line.startsWith('language:')) {
            currentLanguage = line.slice('language:'.length).replace(/_/g, ' ');
            continue;
        }

        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) continue;

        const namespace = line.slice(0, colonIdx);
        const value = line.slice(colonIdx + 1);

        if (namespace === 'artist' || namespace === 'group') {
            entries.push({ namespace, value, language: currentLanguage });
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

export function loadManifest(artistsPath: string, queriesPath: string): Manifest {
    return {
        artists: parseArtistsFile(artistsPath),
        queries: parseQueriesFile(queriesPath),
    };
}
