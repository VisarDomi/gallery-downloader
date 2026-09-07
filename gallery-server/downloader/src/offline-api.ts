import { Router } from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { imageSizeFromFile, setConcurrency } from 'image-size-next/fromFile';

setConcurrency(4);

const providers = ['hitomi', 'imhentai'] as const;
const validId = (id: string) => /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id));
const pagePattern = (provider: string, id: string) => new RegExp(`^${provider}_${id}_\\d+\\.(?:avif|gif|jpe?g|png|webp)$`, 'i');
const thumbPattern = (provider: string, id: string) => new RegExp(`^${provider}_${id}_thumb_\\d+\\.(?:avif|gif|jpe?g|png|webp)$`, 'i');
const numberOf = (name: string) => Number(name.match(/_(\d+)\.[^.]+$/)?.[1]);

export function offlineApi(downloadRoot: string, favoritesRoot: string) {
    const router = Router();
    // Metadata changes; image bytes are explicitly saved in OPFS, not HTTP cache.
    router.use((_req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        // Unlike the userscript favorites API, private page bytes do not need CORS.
        res.removeHeader('Access-Control-Allow-Origin');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        next();
    });
    let catalog: { at: number; data: unknown } | undefined;
    let loading: Promise<unknown> | undefined;

    async function gallery(provider: string, id: string) {
        if (!providers.includes(provider as typeof providers[number]) || !validId(id)) throw new Error('Invalid gallery');
        const dir = path.join(downloadRoot, provider, id);
        await fs.access(path.join(downloadRoot, provider, `.downloading-${id}`)).then(() => {
            throw new Error('Gallery is still downloading on the PC');
        }, (error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
        const [info, names] = await Promise.all([
            fs.readFile(path.join(dir, 'info.json'), 'utf8').then(JSON.parse), fs.readdir(dir),
        ]);
        const pages = names.filter(name => pagePattern(provider, id).test(name))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        // The local Hitomi extractor counts both full pages and legacy thumbnails
        // in info.count, even when thumbnails are filtered out during acquisition.
        const count = Number(info.count);
        const matchesCount = !count || pages.length === count || (provider === 'hitomi' && pages.length * 2 === count);
        if (!pages.length || !matchesCount) {
            throw new Error('Full-size pages are incomplete on the PC');
        }
        const thumbnails = new Map(names.filter(name => thumbPattern(provider, id).test(name)).map(name => [numberOf(name), name]));
        return { dir, pages, thumbnails, info, title: String(info.title_jpn?.trim() || info.title || `${provider} ${id}`) };
    }

    async function loadCatalog() {
        const items = [];
        for (const provider of providers) {
            const snapshot = await fs.readFile(path.join(favoritesRoot, `${provider}.json`), 'utf8')
                .then(JSON.parse).catch((error: NodeJS.ErrnoException) => {
                    if (error.code === 'ENOENT') return { ids: [] };
                    throw error;
                });
            for (const id of snapshot.ids) {
                if (!validId(String(id))) throw new Error('Invalid favorite ID');
                const item = { key: `${provider}-${id}`, provider, id: String(id), title: `${provider} ${id}`, pages: 0, ready: false };
                try {
                    const g = await gallery(provider, String(id));
                    Object.assign(item, { title: g.title, pages: g.pages.length, ready: true });
                } catch { /* Favorites still downloading remain visible in the list. */ }
                items.push(item);
            }
        }
        return { version: 1, updatedAt: new Date().toISOString(), items };
    }

    router.get('/catalog', async (_req, res, next) => {
        try {
            if (!catalog || Date.now() - catalog.at > 10_000) {
                loading ??= loadCatalog().then(data => { catalog = { at: Date.now(), data }; return data; })
                    .finally(() => { loading = undefined; });
                await loading;
            }
            res.json(catalog!.data);
        } catch (error) { next(error); }
    });

    router.get('/:provider/:id/manifest', async (req, res) => {
        try {
            const { provider, id } = req.params;
            const g = await gallery(provider, id);
            let offset = 0;
            const pages = [];
            const revision = createHash('sha256');
            const thumbnailRevision = createHash('sha256');
            const thumbnails = [];
            let thumbnailOffset = 0;
            for (const name of g.pages) {
                const stat = await fs.lstat(path.join(g.dir, name));
                if (!stat.isFile() || !stat.size) throw new Error('Invalid page file');
                // Header inspection only: no image conversion or regenerated previews.
                const dimensions = await imageSizeFromFile(path.join(g.dir, name)).then(d =>
                    d.orientation && d.orientation >= 5 ? { width: d.height, height: d.width } : { width: d.width, height: d.height }
                ).catch(() => ({}));
                const page = { name, size: stat.size, offset, ...dimensions, url: `/offline-api/${provider}/${id}/pages/${name}` };
                revision.update(`${name}:${stat.size}:${stat.mtimeMs}\n`);
                pages.push(page);
                offset += stat.size;
                const thumbnail = g.thumbnails.get(numberOf(name));
                if (thumbnail) {
                    const s = await fs.lstat(path.join(g.dir, thumbnail));
                    if (s.isFile() && s.size) {
                        thumbnails.push({ name: thumbnail, size: s.size, offset: thumbnailOffset,
                            url: `/offline-api/${provider}/${id}/thumbnails/${thumbnail}` });
                        thumbnailRevision.update(`${thumbnail}:${s.size}:${s.mtimeMs}\n`);
                        thumbnailOffset += s.size;
                    }
                }
            }
            const key = `${provider}-${id}`;
            const strings = (value: unknown) => Array.isArray(value) ? value.filter(v => typeof v === 'string') : [];
            const metadata = { title: g.info.title, title_jpn: g.info.title_jpn, artists: strings(g.info.artist),
                groups: strings(g.info.group), parody: strings(g.info.parody), characters: strings(g.info.characters),
                tags: strings(g.info.tags), language: g.info.language, type: g.info.type, date: g.info.date };
            // Original revision input is deliberately unchanged. Existing phone packs
            // gain layout/metadata without invalidating or re-downloading their bytes.
            res.json({ key, title: g.title, metadata, revision: revision.digest('hex').slice(0, 24), pages, bytes: offset,
                thumbnails: thumbnails.length === pages.length ? { key, kind: 'thumbnails',
                    revision: thumbnailRevision.digest('hex').slice(0, 24), pages: thumbnails, bytes: thumbnailOffset } : null });
        } catch (error) { res.status(409).json({ error: (error as Error).message }); }
    });

    router.get('/:provider/:id/pages/:name', async (req, res) => {
        const { provider, id, name } = req.params;
        if (!providers.includes(provider as typeof providers[number]) || !validId(id) || !pagePattern(provider, id).test(name)) {
            res.status(400).end(); return;
        }
        const file = path.join(downloadRoot, provider, id, name);
        try {
            const stat = await fs.lstat(file);
            if (!stat.isFile() || !stat.size) { res.status(404).end(); return; }
            res.sendFile(file, { cacheControl: false, dotfiles: 'deny' });
        } catch { res.status(404).end(); }
    });
    router.get('/:provider/:id/thumbnails/:name', async (req, res) => {
        const { provider, id, name } = req.params;
        if (!providers.includes(provider as typeof providers[number]) || !validId(id) || !thumbPattern(provider, id).test(name)) {
            res.status(400).end(); return;
        }
        const file = path.join(downloadRoot, provider, id, name);
        try {
            const stat = await fs.lstat(file);
            if (!stat.isFile() || !stat.size) { res.status(404).end(); return; }
            res.sendFile(file, { cacheControl: false, dotfiles: 'deny' });
        } catch { res.status(404).end(); }
    });
    return router;
}
