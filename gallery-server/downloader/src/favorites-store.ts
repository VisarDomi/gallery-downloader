import fs from 'fs';

import type { SourceId } from 'gallery-sources';
import { durableAtomicWriteFileSync } from './durable-file.js';

export interface FavoritesSnapshot {
    provider: SourceId;
    ids: number[];
    updatedAt: string | null;
}

export function normalizeFavoriteIds(value: unknown): number[] {
    if (!Array.isArray(value)) {
        throw new Error('ids must be an array');
    }

    const ids: number[] = [];
    const seen = new Set<number>();
    for (const item of value) {
        if (!Number.isSafeInteger(item) || (item as number) <= 0) {
            throw new Error('every favorite ID must be a positive safe integer');
        }
        const id = item as number;
        if (seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
    }
    return ids;
}

export function readFavorites(filePath: string, provider: SourceId): FavoritesSnapshot {
    if (!fs.existsSync(filePath)) {
        return { provider, ids: [], updatedAt: null };
    }

    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<FavoritesSnapshot>;
    if (raw.provider !== provider) {
        throw new Error(`favorites snapshot provider must be ${provider}`);
    }
    return {
        provider,
        ids: normalizeFavoriteIds(raw.ids),
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    };
}

export function writeFavorites(filePath: string, provider: SourceId, idsValue: unknown): FavoritesSnapshot {
    const snapshot: FavoritesSnapshot = {
        provider,
        ids: normalizeFavoriteIds(idsValue),
        updatedAt: new Date().toISOString(),
    };

    durableAtomicWriteFileSync(filePath, `${JSON.stringify(snapshot, null, 2)}\n`);
    return snapshot;
}
