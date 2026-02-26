import fs from 'fs';
import path from 'path';
import http from 'http';
import type { Request, Response } from 'express';
import { hitomi } from 'gallery-sources';
import { CONFIG } from './config.js';

const GALLERY_ROOT = path.join(CONFIG.MEDIA_ROOT, hitomi.gallerySubdir);
const SOCKET_PATH = '/run/user/1000/gallery-sprite-gen.sock';

// Gallery ID → full directory path. Populated once on startup by scanning
// GALLERY_ROOT, then kept current via addGalleryDir() for new downloads.
const galleryDirCache = new Map<string, string>();

// Build the full cache at startup so request-time lookups are O(1)
try {
    for (const entry of fs.readdirSync(GALLERY_ROOT)) {
        if (entry.startsWith('.')) continue;
        const spaceIdx = entry.indexOf(' ');
        if (spaceIdx > 0) {
            galleryDirCache.set(entry.slice(0, spaceIdx), path.join(GALLERY_ROOT, entry));
        }
    }
    console.log(`[sprite] cached ${galleryDirCache.size} gallery dirs`);
} catch { /* GALLERY_ROOT doesn't exist yet */ }

/** Add a newly-downloaded gallery to the cache (called externally if needed) */
export function addGalleryDir(galleryId: string, fullPath: string) {
    galleryDirCache.set(galleryId, fullPath);
}

function findGalleryDir(galleryId: string): string | null {
    const cached = galleryDirCache.get(galleryId);
    if (cached) return cached;

    // Cache miss — new gallery downloaded after startup. Scan once for this ID.
    const prefix = `${galleryId} `;
    try {
        for (const entry of fs.readdirSync(GALLERY_ROOT)) {
            if (entry.startsWith(prefix)) {
                const fullPath = path.join(GALLERY_ROOT, entry);
                galleryDirCache.set(galleryId, fullPath);
                return fullPath;
            }
        }
    } catch { /* dir not found */ }
    return null;
}

function requestSpriteGeneration(galleryDir: string, stripIdx: number, cachePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ galleryDir, stripIndex: stripIdx, cachePath });
        const req = http.request(
            {
                socketPath: SOCKET_PATH,
                path: '/generate',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
            },
            (res) => {
                let data = '';
                res.on('data', (chunk) => (data += chunk));
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.ok) resolve();
                        else reject(new Error(parsed.error || 'sprite-gen failed'));
                    } catch {
                        reject(new Error(`sprite-gen bad response: ${data}`));
                    }
                });
            },
        );
        req.on('error', (err) => reject(new Error(`sprite-gen connect: ${err.message}`)));
        req.write(body);
        req.end();
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
    const markerPath = path.join(GALLERY_ROOT, hitomi.downloadingMarker(galleryId));
    try { await fs.promises.access(markerPath); return res.status(409).json({ error: 'Gallery is still downloading' }); } catch { /* no marker — good */ }

    // Check cache first
    const spritesDir = path.join(galleryDir, '.sprites');
    const cachePath = path.join(spritesDir, `strip_${stripIdx}.webp`);
    const forceRebuild = req.query.rebuild === '1';

    if (!forceRebuild) {
        try {
            await fs.promises.access(cachePath);
            res.setHeader('Content-Type', 'image/webp');
            res.setHeader('Cache-Control', 'public, max-age=31536000');
            return res.sendFile(cachePath, { dotfiles: 'allow' });
        } catch { /* not cached — generate */ }
    }

    // Request generation from sprite-gen daemon (runs at idle CPU priority)
    try {
        await requestSpriteGeneration(galleryDir, stripIdx, cachePath);
        res.setHeader('Content-Type', 'image/webp');
        res.setHeader('Cache-Control', 'public, max-age=31536000');
        return res.sendFile(cachePath, { dotfiles: 'allow' });
    } catch (e) {
        console.error(`Sprite generation error for gallery ${galleryId}, strip ${stripIdx}:`, e);
        res.status(500).json({ error: 'Failed to generate sprite' });
    }
};
