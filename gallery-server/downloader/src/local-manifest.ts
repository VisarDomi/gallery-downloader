import Database from 'better-sqlite3';
import fs from 'fs';
import { type Filters, type Manifest } from './manifest.js';

const DIRECT_NAMESPACES = new Set(['type', 'language']);

interface Token {
    namespace: string;
    value: string;
}

export interface LocalRemovePlan {
    localCount: number;
    candidateIds: number[];
    retainedIds: number[];
    orphanIds: number[];
}

function normalizeValue(value: string): string {
    return value.trim().replace(/_/g, ' ').toLowerCase();
}

function parseToken(raw: string): Token | null {
    const colonIdx = raw.indexOf(':');
    if (colonIdx === -1) return null;

    const namespace = raw.slice(0, colonIdx).trim();
    const value = normalizeValue(raw.slice(colonIdx + 1));
    if (!namespace || !value) return null;

    return { namespace, value };
}

function parseQuery(raw: string): { positive: Token[]; negative: Token[] } {
    const positive: Token[] = [];
    const negative: Token[] = [];

    for (const part of raw.trim().split(/\s+/).filter(Boolean)) {
        const negated = part.startsWith('-');
        const token = parseToken(negated ? part.slice(1) : part);
        if (!token) continue;
        if (negated) {
            negative.push(token);
        } else {
            positive.push(token);
        }
    }

    return { positive, negative };
}

function filterNegativeTokens(filters: Filters): Token[] {
    return filters.negatives
        .map(parseToken)
        .filter((token): token is Token => token !== null);
}

function getAllLocalIds(db: Database.Database): Set<number> {
    const rows = db.prepare('SELECT gallery_id FROM galleries').all() as { gallery_id: number }[];
    return new Set(rows.map((row) => row.gallery_id));
}

function idsForToken(db: Database.Database, token: Token): Set<number> {
    if (DIRECT_NAMESPACES.has(token.namespace)) {
        const rows = db.prepare(`
            SELECT gallery_id
            FROM galleries
            WHERE LOWER(${token.namespace}) = ?
        `).all(token.value) as { gallery_id: number }[];
        return new Set(rows.map((row) => row.gallery_id));
    }

    const rows = db.prepare(`
        SELECT gallery_id
        FROM tags
        WHERE namespace = ? AND LOWER(value) = ?
    `).all(token.namespace, token.value) as { gallery_id: number }[];
    return new Set(rows.map((row) => row.gallery_id));
}

function intersect(left: Set<number>, right: Set<number>): Set<number> {
    const out = new Set<number>();
    for (const id of left) {
        if (right.has(id)) out.add(id);
    }
    return out;
}

function unionInto(target: Set<number>, source: Set<number>) {
    for (const id of source) target.add(id);
}

function subtractInPlace(target: Set<number>, source: Set<number>) {
    for (const id of source) target.delete(id);
}

function idsForPositiveTokens(db: Database.Database, tokens: Token[]): Set<number> {
    if (tokens.length === 0) return new Set();

    let ids = idsForToken(db, tokens[0]);
    for (const token of tokens.slice(1)) {
        ids = intersect(ids, idsForToken(db, token));
    }
    return ids;
}

function applyFilterPolicy(db: Database.Database, ids: Set<number>, filters: Filters): Set<number> {
    let result = intersect(ids, idsForToken(db, { namespace: 'language', value: normalizeValue(filters.language) }));
    for (const token of filterNegativeTokens(filters)) {
        subtractInPlace(result, idsForToken(db, token));
    }
    return result;
}

function idsForArtistLine(db: Database.Database, line: string, filters: Filters): Set<number> {
    const token = parseToken(line);
    if (!token || (token.namespace !== 'artist' && token.namespace !== 'group')) return new Set();
    return applyFilterPolicy(db, idsForToken(db, token), filters);
}

function idsForQueryLine(db: Database.Database, line: string, filters: Filters): Set<number> {
    const parsed = parseQuery(line);
    let ids = idsForToken(db, { namespace: 'language', value: normalizeValue(filters.language) });

    const positive = parsed.positive.filter((token) => token.namespace !== 'language');
    if (positive.length > 0) {
        ids = intersect(ids, idsForPositiveTokens(db, positive));
    }

    for (const token of [...parsed.negative, ...filterNegativeTokens(filters)]) {
        subtractInPlace(ids, idsForToken(db, token));
    }

    return ids;
}

function idsForEntry(db: Database.Database, file: 'artists' | 'queries', line: string, filters: Filters): Set<number> {
    return file === 'artists'
        ? idsForArtistLine(db, line, filters)
        : idsForQueryLine(db, line, filters);
}

function retainedCandidateIdsForManifest(db: Database.Database, manifest: Manifest, candidateIds: Set<number>): Set<number> {
    const ids = new Set<number>();

    for (const artist of manifest.artists) {
        unionInto(ids, intersect(candidateIds, idsForToken(db, {
            namespace: artist.namespace,
            value: normalizeValue(artist.value),
        })));
    }

    for (const query of manifest.queries) {
        unionInto(ids, intersect(candidateIds, idsForQueryLine(db, query.raw, manifest.filters)));
    }

    return ids;
}

export function planLocalRemove(
    indexDbPath: string,
    manifestAfterRemoval: Manifest,
    removedFile: 'artists' | 'queries',
    removedLine: string,
): LocalRemovePlan {
    if (!fs.existsSync(indexDbPath)) {
        return { localCount: 0, candidateIds: [], retainedIds: [], orphanIds: [] };
    }

    const db = new Database(indexDbPath, { readonly: true });
    try {
        db.pragma('journal_mode = WAL');

        const localIds = getAllLocalIds(db);
        const candidateIds = intersect(
            idsForEntry(db, removedFile, removedLine, manifestAfterRemoval.filters),
            localIds,
        );
        const retainedIds = retainedCandidateIdsForManifest(db, manifestAfterRemoval, candidateIds);

        const orphanIds: number[] = [];
        for (const id of candidateIds) {
            if (!retainedIds.has(id)) orphanIds.push(id);
        }

        return {
            localCount: localIds.size,
            candidateIds: [...candidateIds].sort((a, b) => a - b),
            retainedIds: [...retainedIds].sort((a, b) => a - b),
            orphanIds: orphanIds.sort((a, b) => a - b),
        };
    } finally {
        db.close();
    }
}
