import fs from 'fs';
import path from 'path';
import url from 'url';
import { Worker } from 'worker_threads';
import type { Request, Response } from 'express';
import { hitomi } from 'gallery-sources';
import { CONFIG } from './config.js';

const GALLERY_ROOT = path.join(CONFIG.MEDIA_ROOT, hitomi.gallerySubdir);

// Lazy cache: gallery ID → full directory path. Populated on first lookup,
// falls back to directory scan on miss, evicts on stale entry.
const galleryDirCache = new Map<string, string>();

function findGalleryDir(galleryId: string): string | null {
    // Check cache first
    const cached = galleryDirCache.get(galleryId);
    if (cached) {
        try {
            if (fs.statSync(cached).isDirectory()) return cached;
        } catch { /* stale — evict and rescan */ }
        galleryDirCache.delete(galleryId);
    }

    // Scan directory
    const prefix = `${galleryId} `;
    try {
        for (const entry of fs.readdirSync(GALLERY_ROOT)) {
            if (entry.startsWith(prefix)) {
                const fullPath = path.join(GALLERY_ROOT, entry);
                if (fs.statSync(fullPath).isDirectory()) {
                    galleryDirCache.set(galleryId, fullPath);
                    return fullPath;
                }
            }
        }
    } catch { /* directory not found */ }
    return null;
}

// Worker thread for off-main-thread sprite generation
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const worker = new Worker(path.join(__dirname, 'sprite-worker.js'));
let jobId = 0;
const pendingJobs = new Map<number, { resolve: (buf: Buffer) => void; reject: (err: Error) => void }>();

worker.on('message', (msg: { id: number; buffer?: Buffer; error?: string }) => {
    const job = pendingJobs.get(msg.id);
    if (!job) return;
    pendingJobs.delete(msg.id);
    if (msg.error) job.reject(new Error(msg.error));
    else job.resolve(msg.buffer!);
});

function generateSpriteInWorker(galleryDir: string, stripIdx: number, cachePath: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const id = ++jobId;
        pendingJobs.set(id, { resolve, reject });
        worker.postMessage({ id, galleryDir, stripIdx, cachePath });
    });
}

export const handleSpriteRequest = async (req: Request, res: Response) => {
    const galleryId = req.params.galleryId as string;
    const stripIndex = req.params.stripIndex as string;
    const stripIdx = parseInt(stripIndex, 10);

    if (isNaN(stripIdx) || stripIdx < 0) {
        return res.status(400).json({ error: 'Invalid strip index' });
    }

    const galleryDir = findGalleryDir(galleryId);
    if (!galleryDir) {
        return res.status(404).json({ error: 'Gallery not found' });
    }

    // Skip galleries still being downloaded
    if (fs.existsSync(path.join(GALLERY_ROOT, hitomi.downloadingMarker(galleryId)))) {
        return res.status(409).json({ error: 'Gallery is still downloading' });
    }

    // Check cache first
    const spritesDir = path.join(galleryDir, '.sprites');
    const cachePath = path.join(spritesDir, `strip_${stripIdx}.webp`);
    const forceRebuild = req.query.rebuild === '1';

    if (!forceRebuild && fs.existsSync(cachePath)) {
        res.setHeader('Content-Type', 'image/webp');
        res.setHeader('Cache-Control', 'public, max-age=31536000');
        return res.sendFile(cachePath, { dotfiles: 'allow' });
    }

    // Generate in worker thread (doesn't block Express event loop)
    try {
        const sprite = await generateSpriteInWorker(galleryDir, stripIdx, cachePath);
        res.setHeader('Content-Type', 'image/webp');
        res.setHeader('Cache-Control', 'public, max-age=31536000');
        res.send(sprite);
    } catch (e) {
        console.error(`Sprite generation error for gallery ${galleryId}, strip ${stripIdx}:`, e);
        res.status(500).json({ error: 'Failed to generate sprite' });
    }
};
