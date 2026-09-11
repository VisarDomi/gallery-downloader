import fs from 'node:fs';
import path from 'node:path';
import { durableAtomicWriteFileSync } from './durable-file.js';
export function validateMangaState(data: any, provider: string): void {
    const db = data?.indexedDB;
    if (data?.version !== 1 || !db || !['progress', 'tokens', 'metadata'].every(k => Array.isArray(db[k]))
        || !db.metadata.some((r: any) => r?.key === 'progress-schema-version' && r.value === 3)) throw new Error('Invalid reading state');
    const ids = new Set();
    for (const p of db.progress) {
        if (!p || p.provider !== provider || typeof p.seriesSlug !== 'string' || !p.seriesSlug || typeof p.chapterId !== 'string' || !p.chapterId
            || p.id !== provider + '\0' + p.seriesSlug || ids.has(p.id) || !Number.isFinite(p.updatedAt)
            || !Number.isInteger(p.imageIndex) || !Number.isInteger(p.totalImages) || p.imageIndex < 0 || p.totalImages <= p.imageIndex) throw new Error('Invalid reading position');
        ids.add(p.id);
    }
    for (const kind of ['tokens', 'metadata']) {
        const keys = new Set();
        for (const r of db[kind]) {
            if (!r || typeof r.key !== 'string' || keys.has(r.key) || !Object.hasOwn(r, 'value')) throw new Error('Invalid reading metadata');
            keys.add(r.key);
        }
    }
}
export class ManualMangaState {
    constructor(private root: string) {}
    private file(provider: string): string {
        if (!['asurascans','ezmanga','qimanga','yakshacomics','scythescans','luacomic'].includes(provider)) throw new Error('Unknown provider');
        return path.join(this.root, 'manual-manga-' + provider + '.json');
    }
    read(provider: string): any | null {
        try { return JSON.parse(fs.readFileSync(this.file(provider), 'utf8')).current; }
        catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
    }
    save(provider: string, data: unknown): void {
        validateMangaState(data, provider);
        // A deliberate Save replaces, including older/backward/empty progress.
        // Keep the prior complete snapshot for recovery without merging it.
        const previous = this.read(provider);
        durableAtomicWriteFileSync(this.file(provider), JSON.stringify({ current: data, previous, savedAt: new Date().toISOString() }), 0o600);
    }
}
