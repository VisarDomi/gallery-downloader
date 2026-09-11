import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Router, json } from 'express';
import cors from 'cors';
import { durableAtomicWriteFileSync } from './durable-file.js';
import { ManualMangaState } from './manual-manga-state.js';

const providers: Record<string, string[]> = {
    'gallery-reader': ['hitomi', 'imhentai'],
    'manga-reader': ['ezmanga', 'qimanga', 'yakshacomics', 'asurascans', 'scythescans', 'luacomic'],
    'km-explorer': ['ytboob'],
};
interface Snapshot { revision: string; savedAt: string; data: unknown }
interface Backup { id: string; label: string; current: Snapshot; previous: Snapshot | null }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function privateDirectory(directory: string): void {
    if (fs.existsSync(directory)) return;
    const parent = path.dirname(directory);
    privateDirectory(parent);
    fs.mkdirSync(directory, { mode: 0o700 });
    const descriptor = fs.openSync(parent, 'r');
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function contentCount(app: string, data: unknown): number {
    const value = data as { version: number; indexedDB?: Record<string, unknown> };
    if (value?.version !== 1) throw new Error('Invalid snapshot version');
    if (app === 'km-explorer') {
        const state = value.indexedDB;
        if (!state || !['videos', 'details', 'channels'].every(name => Array.isArray(state[name]))) throw new Error('Missing KM cache stores');
        const preferences = state.preferences as { favorites: unknown; highlight: unknown; scroll: unknown };
        if (!preferences || !Array.isArray(preferences.favorites) || !preferences.favorites.every(id => typeof id === 'string' && id.length > 0)) throw new Error('Invalid KM favorites');
        if (!preferences.scroll || typeof preferences.scroll !== 'object' || Array.isArray(preferences.scroll) || !Object.values(preferences.scroll).every(y => Number.isFinite(y) && y >= 0)) throw new Error('Invalid KM scroll positions');
        if (preferences.highlight !== null && (!preferences.highlight || typeof preferences.highlight !== 'object' || typeof (preferences.highlight as { id?: unknown }).id !== 'string' || typeof (preferences.highlight as { pageUrl?: unknown }).pageUrl !== 'string')) throw new Error('Invalid KM highlight');
        return preferences.favorites.length;
    }
    if (app === 'gallery-reader') {
        const state = value.indexedDB;
        if (!state) throw new Error('Missing gallery IndexedDB snapshot');
        const ids = state.favorites;
        const searches = state.searches;
        if (!Array.isArray(ids) || !ids.every(id => Number.isSafeInteger(id) && id > 0) || !Array.isArray(searches)) throw new Error('Invalid favorites/searches');
        if (!Number.isInteger(state.page) || Number(state.page) < 1 || !state.scroll || typeof state.scroll !== 'object') throw new Error('Invalid page/scroll positions');
        return ids.length + searches.length;
    }
    if (!value.indexedDB || !['progress', 'tokens', 'metadata'].every(name => Array.isArray(value.indexedDB![name]))) throw new Error('Missing IndexedDB stores');
    return (value.indexedDB.progress as unknown[]).length;
}

export class BackupStore {
    constructor(readonly root: string) { privateDirectory(root); }
    directory(app: string, provider: string): string {
        if (!providers[app]?.includes(provider)) throw new Error('Unknown reader/provider');
        return path.join(this.root, app, provider);
    }
    file(app: string, provider: string, id: string): string {
        if (!uuid.test(id)) throw new Error('Invalid backup ID');
        return path.join(this.directory(app, provider), `${id}.json`);
    }
    read(app: string, provider: string, id: string): Backup | null {
        const file = this.file(app, provider, id);
        try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    }
    list(app: string, provider: string): Backup[] {
        const directory = this.directory(app, provider);
        if (!fs.existsSync(directory)) return [];
        return fs.readdirSync(directory).filter(name => name.endsWith('.json'))
            .map(name => this.read(app, provider, name.slice(0, -5))!)
            .sort((a, b) => b.current.savedAt.localeCompare(a.current.savedAt));
    }
    put(app: string, provider: string, id: string, body: { label: string; baseRevision: string | null; data: unknown }): Backup {
        const file = this.file(app, provider, id);
        if (typeof body.label !== 'string' || !body.label.trim() || body.label.length > 80) throw new Error('Invalid backup name');
        const count = contentCount(app, body.data);
        const old = this.read(app, provider, id);
        // Idempotent retry after a lost acknowledgement must not rotate history.
        if (old && JSON.stringify(old.current.data) === JSON.stringify(body.data)) return old;
        if ((old?.current.revision ?? null) !== body.baseRevision) throw new Error('CONFLICT: backup changed; reload home before retrying');
        if (old && count === 0 && contentCount(app, old.current.data) > 0) throw new Error('CONFLICT: local data is now empty; revisit home to choose Backup or Restore. Existing backup preserved.');
        const backup: Backup = {
            id, label: body.label.trim(),
            current: { revision: randomUUID(), savedAt: new Date().toISOString(), data: body.data },
            previous: old?.current ?? null,
        };
        // Both generations live in ONE atomic file; a power loss cannot split rotation and publication.
        privateDirectory(path.dirname(file));
        durableAtomicWriteFileSync(file, JSON.stringify(backup), 0o600);
        return backup;
    }
}

export function readerBackups(root: string): Router {
    const store = new BackupStore(root);
    const keyFile = path.join(root, 'access-key');
    if (!fs.existsSync(keyFile)) durableAtomicWriteFileSync(keyFile, randomBytes(32).toString('hex'), 0o600);
    const key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim());
    const router = Router();
    const origins = new Set(['hitomi.la', 'imhentai.xxx', 'ezmanga.org', 'qimanga.com', 'yakshacomics.com', 'asurascans.com', 'scythescans.com', 'luacomic.org', 'ytboob.com'].map(host => 'https://' + host));
    router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
    // Worker fetch is allowed only from the reader origins; every data request still requires the private key.
    router.use(cors({ origin: (origin, done) => done(null, origins.has(origin ?? '')), methods: ['GET', 'PUT'], allowedHeaders: ['Content-Type', 'X-Reader-Backup-Key'] }));
    router.use((req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        const supplied = Buffer.from(req.get('X-Reader-Backup-Key') ?? '');
        if (key.length !== supplied.length || !timingSafeEqual(key, supplied)) {
            res.status(401).json({ error: 'Backup access key required' }); return;
        }
        next();
    });
    const readerJSON = json({ limit: '5mb' });
    const kmJSON = json({ limit: '50mb' }); // Includes URL/catalog caches, never video media.
    router.use((req, res, next) => (req.path.startsWith('/km-explorer/') ? kmJSON : readerJSON)(req, res, next));
    const manual = new ManualMangaState(root);
    router.get('/manual/manga-reader/:provider/status', (req, res) => {
        if (!providers['manga-reader'].includes(req.params.provider)) { res.sendStatus(400); return; }
        res.json({ available: true }); // No reading snapshot is touched by discovery.
    });
    router.get('/manual/manga-reader/:provider', (req, res) => {
        try { const data = manual.read(req.params.provider); if (data === null) { res.sendStatus(404); return; } res.json(data); }
        catch { res.status(400).json({ error: 'Reading state unavailable' }); }
    });
    router.put('/manual/manga-reader/:provider', (req, res) => {
        try { manual.save(req.params.provider, req.body); res.json({ saved: true }); }
        catch { res.status(400).json({ error: 'Invalid reading state' }); }
    });
    // Retire the automatic publisher. Old clients cannot alter the manual save.
    router.all('/library/asurascans', (_req, res) => { res.sendStatus(410); });
    router.get('/:app/:provider', (req, res) => {
        try { res.json(store.list(req.params.app, req.params.provider)); }
        catch (error) { res.status(400).json({ error: String(error) }); }
    });
    router.put('/:app/:provider/:id', (req, res) => {
        try { res.json(store.put(req.params.app, req.params.provider, req.params.id, req.body)); }
        catch (error) { res.status(String(error).includes('CONFLICT:') ? 409 : 400).json({ error: String(error) }); }
    });
    return router;
}
