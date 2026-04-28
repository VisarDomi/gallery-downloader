import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { Gallery, ImageDimension } from './types.js';
import { normalizeSearchValue, parseTaggedQuery, serializeTaggedQuery } from 'gallery-sources';

export interface GalleryListItem {
    gallery_id: number;
    title: string;
    title_jpn: string;
    type: string;
    language: string;
    date: string;
    count: number;
    thumb_count: number;
}

const MEDIA_ROOT = '/home/visar/Pictures';
const DB_PATH = path.join(MEDIA_ROOT, 'gallery-dl', 'gallery-index.db');

let db: Database.Database;

export function getDb(): Database.Database {
    if (!db) {
        db = new Database(DB_PATH, { readonly: true });
        db.pragma('journal_mode = WAL');
    }
    return db;
}

export function reopenDb(): void {
    if (db) {
        db.close();
        db = undefined as unknown as Database.Database;
    }
    getDb();
}

// -- Search --

// Gallery table columns that map directly to a namespace filter
const GALLERY_COLUMN_NS: Record<string, string> = {
    type: 'type',
    language: 'language',
};

export interface SearchResult {
    total: number;
    normalized: string;
    items: GalleryListItem[];
}

export function searchGalleries(rawQuery: string, limit: number, offset: number): SearchResult {
    const tokens = parseTaggedQuery(rawQuery);
    const d = getDb();

    const whereClauses: string[] = [];
    const params: unknown[] = [];

    for (const token of tokens) {
        const col = GALLERY_COLUMN_NS[token.namespace];
        if (col) {
            // Direct column match
            if (token.negated) {
                whereClauses.push(`LOWER(g.${col}) != ?`);
            } else {
                whereClauses.push(`LOWER(g.${col}) = ?`);
            }
            params.push(token.value.toLowerCase());
        } else {
            // Tag table match via EXISTS
            const op = token.negated ? 'NOT EXISTS' : 'EXISTS';
            whereClauses.push(`${op} (SELECT 1 FROM tags t WHERE t.gallery_id = g.gallery_id AND t.namespace = ? AND LOWER(t.value) = ?)`);
            params.push(token.namespace, token.value.toLowerCase());
        }
    }

    const whereSQL = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

    // Count total
    const countRow = d.prepare(`SELECT COUNT(*) as cnt FROM galleries g ${whereSQL}`).get(...params) as { cnt: number };
    const total = countRow.cnt;

    // Fetch paginated items
    const items = d.prepare(`
        SELECT g.gallery_id, g.title, g.title_jpn, g.type, g.language, g.date, g.count, g.thumb_count
        FROM galleries g ${whereSQL}
        ORDER BY g.date DESC
        LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as GalleryListItem[];

    return { total, normalized: serializeTaggedQuery(tokens), items };
}

// -- Gallery Detail --

export function getGalleryDetail(galleryId: number): Gallery | null {
    const d = getDb();

    const row = d.prepare(`SELECT * FROM galleries WHERE gallery_id = ?`).get(galleryId) as {
        gallery_id: number; title: string; title_jpn: string; type: string;
        language: string; lang: string; date: string; count: number;
        category: string; subcategory: string; path: string; thumb_count: number;
    } | undefined;

    if (!row) return null;

    // Get tags grouped by namespace
    const tagRows = d.prepare(`SELECT namespace, value FROM tags WHERE gallery_id = ? ORDER BY namespace, value`).all(galleryId) as { namespace: string; value: string }[];

    const artist: string[] = [];
    const group: string[] = [];
    const parody: string[] = [];
    const characters: string[] = [];
    const tags: string[] = [];

    for (const t of tagRows) {
        switch (t.namespace) {
            case 'artist': artist.push(t.value); break;
            case 'group': group.push(t.value); break;
            case 'series': parody.push(t.value); break;
            case 'character': characters.push(t.value); break;
            case 'female': tags.push(`female:${t.value}`); break;
            case 'male': tags.push(`male:${t.value}`); break;
            case 'tag': tags.push(t.value); break;
        }
    }

    // Get files
    const fileRows = d.prepare(`SELECT filename, width, height FROM files WHERE gallery_id = ? ORDER BY sort_order`).all(galleryId) as { filename: string; width: number; height: number }[];

    const fullFiles = fileRows.map(f => f.filename);
    const dimensions: ImageDimension[] = fileRows.map(f => ({ width: f.width, height: f.height }));

    // Derive thumbnail files from full files
    const thumbnailFiles = fullFiles.map(name => {
        const dotIdx = name.lastIndexOf('.');
        if (dotIdx === -1) return name;
        return name.substring(0, dotIdx) + '_thumb_' + name.substring(dotIdx);
    });

    // All files = sorted(fullFiles + thumbnailFiles)
    const files = [...fullFiles, ...thumbnailFiles].sort();

    return {
        gallery_id: row.gallery_id,
        title: row.title,
        title_jpn: row.title_jpn,
        type: row.type,
        language: row.language,
        lang: row.lang,
        date: row.date,
        count: row.count,
        category: row.category,
        subcategory: row.subcategory,
        path: row.path,
        artist,
        group,
        parody,
        characters,
        tags,
        files,
        fullFiles,
        thumbnailFiles,
        dimensions,
    };
}

// -- Bulk Fetch (for favorites) --

export function getGalleryListItems(ids: number[]): GalleryListItem[] {
    if (ids.length === 0) return [];
    const d = getDb();
    const placeholders = ids.map(() => '?').join(',');
    return d.prepare(`
        SELECT gallery_id, title, title_jpn, type, language, date, count, thumb_count
        FROM galleries WHERE gallery_id IN (${placeholders})
    `).all(...ids) as GalleryListItem[];
}

// -- Artists.txt parsing & caching --

interface ParsedArtists {
    artists: Set<string>;
    groups: Set<string>;
    languages: Set<string>;
}

let artistsFilePath: string | null = null;
let cachedArtists: ParsedArtists | null = null;

export function setArtistsFilePath(filePath: string): void {
    artistsFilePath = filePath;
    cachedArtists = null;
}

export function invalidateArtistsCache(): void {
    cachedArtists = null;
}

function parseArtistsFile(filePath: string): ParsedArtists {
    const artists = new Set<string>();
    const groups = new Set<string>();
    const languages = new Set<string>();

    const content = fs.readFileSync(filePath, 'utf-8');
    let currentLanguage = 'japanese';

    for (const raw of content.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;

        if (line.startsWith('language:')) {
            const tokens = parseTaggedQuery(line);
            if (tokens.length === 1 && tokens[0].namespace === 'language' && !tokens[0].negated) {
                currentLanguage = tokens[0].value;
            }
            continue;
        }

        languages.add(currentLanguage);

        if (line.startsWith('artist:')) {
            artists.add(normalizeSearchValue(line.slice('artist:'.length)));
        } else if (line.startsWith('group:')) {
            groups.add(normalizeSearchValue(line.slice('group:'.length)));
        }
    }

    return { artists, groups, languages };
}

function getTrackedArtists(): ParsedArtists | null {
    if (!artistsFilePath) return null;
    if (!cachedArtists) {
        cachedArtists = parseArtistsFile(artistsFilePath);
    }
    return cachedArtists;
}

// -- Facets --

export interface FacetsResult {
    languages: [string, number][];
    artists: [string, number][];
    groups: [string, number][];
}

export function getFacets(): FacetsResult {
    const d = getDb();
    const tracked = getTrackedArtists();

    let languages: { language: string; cnt: number }[];
    let artists: { value: string; cnt: number }[];
    let groups: { value: string; cnt: number }[];

    if (tracked) {
        const langList = [...tracked.languages];
        const langPlaceholders = langList.map(() => '?').join(',');
        languages = d.prepare(`
            SELECT language, COUNT(*) as cnt FROM galleries
            WHERE language IN (${langPlaceholders})
            GROUP BY language ORDER BY cnt DESC
        `).all(...langList) as { language: string; cnt: number }[];

        const artistList = [...tracked.artists];
        const artistPlaceholders = artistList.map(() => '?').join(',');
        artists = d.prepare(`
            SELECT value, COUNT(*) as cnt FROM tags
            WHERE namespace = 'artist' AND value IN (${artistPlaceholders})
            GROUP BY value ORDER BY cnt DESC
        `).all(...artistList) as { value: string; cnt: number }[];

        const groupList = [...tracked.groups];
        const groupPlaceholders = groupList.map(() => '?').join(',');
        groups = d.prepare(`
            SELECT value, COUNT(*) as cnt FROM tags
            WHERE namespace = 'group' AND value IN (${groupPlaceholders})
            GROUP BY value ORDER BY cnt DESC
        `).all(...groupList) as { value: string; cnt: number }[];
    } else {
        languages = d.prepare(`
            SELECT language, COUNT(*) as cnt FROM galleries WHERE language != '' GROUP BY language ORDER BY cnt DESC
        `).all() as { language: string; cnt: number }[];

        artists = d.prepare(`
            SELECT value, COUNT(*) as cnt FROM tags WHERE namespace = 'artist' GROUP BY value ORDER BY cnt DESC
        `).all() as { value: string; cnt: number }[];

        groups = d.prepare(`
            SELECT value, COUNT(*) as cnt FROM tags WHERE namespace = 'group' GROUP BY value ORDER BY cnt DESC
        `).all() as { value: string; cnt: number }[];
    }

    return {
        languages: languages.map(r => [r.language, r.cnt]),
        artists: artists.map(r => [r.value, r.cnt]),
        groups: groups.map(r => [r.value, r.cnt]),
    };
}
