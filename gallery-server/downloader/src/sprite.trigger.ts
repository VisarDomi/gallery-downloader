import fs from 'fs';
import path from 'path';
import http from 'http';
import { hitomi } from 'gallery-sources';
import { CONFIG } from './config.js';

const SOURCE_DIR = path.join(CONFIG.WORKING_DIR, hitomi.gallerySubdir);
const SOCKET_PATH = '/run/user/1000/gallery-sprite-gen.sock';
const THUMB_MARKER = '_thumb_';

function findGalleryDir(galleryId: string): string | null {
    const fullPath = path.join(SOURCE_DIR, galleryId);
    try {
        if (fs.statSync(fullPath).isDirectory()) return fullPath;
    } catch { /* dir not found */ }
    return null;
}

export function countThumbs(galleryDir: string): number {
    try {
        return fs.readdirSync(galleryDir).filter(f => f.includes(THUMB_MARKER)).length;
    } catch {
        return 0;
    }
}

export function triggerSpriteGeneration(galleryId: string, preThumbCount: number) {
    setImmediate(() => {
        try {
            const galleryDir = findGalleryDir(galleryId);
            if (!galleryDir) return;

            const currentCount = countThumbs(galleryDir);
            if (currentCount === preThumbCount) return;

            const spritesDir = path.join(galleryDir, '.sprites');
            if (fs.existsSync(spritesDir)) {
                fs.rmSync(spritesDir, { recursive: true, force: true });
                console.log(`[sprite] deleted stale .sprites/ for ${galleryId}`);
            }

            const stripCount = Math.ceil(currentCount / hitomi.sprite.maxPerStrip);
            console.log(`[sprite] triggering ${stripCount} strip(s) for ${galleryId} (${currentCount} thumbs)`);

            for (let i = 0; i < stripCount; i++) {
                const cachePath = path.join(spritesDir, `strip_${i}.webp`);
                const body = JSON.stringify({ galleryDir, stripIndex: i, cachePath });
                const req = http.request({
                    socketPath: SOCKET_PATH,
                    path: '/generate',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(body),
                    },
                }, () => { /* response ignored */ });
                req.on('error', (err) => {
                    console.error(`[sprite] strip ${i} request failed: ${err.message}`);
                });
                req.write(body);
                req.end();
            }
        } catch (err) {
            console.error(`[sprite] trigger failed for ${galleryId}:`, err);
        }
    });
}
