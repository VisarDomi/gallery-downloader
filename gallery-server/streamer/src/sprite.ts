import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import type { Request, Response } from 'express';
import { hitomi } from 'gallery-sources';
import { CONFIG } from './config.js';

const { maxPerStrip, thumbWidth, thumbHeight } = hitomi.sprite;
const GALLERY_ROOT = path.join(CONFIG.MEDIA_ROOT, hitomi.gallerySubdir);

function findGalleryDir(galleryId: string): string | null {
    const prefix = `${galleryId} `;
    try {
        const entries = fs.readdirSync(GALLERY_ROOT);
        for (const entry of entries) {
            if (entry.startsWith(prefix)) {
                const fullPath = path.join(GALLERY_ROOT, entry);
                if (fs.statSync(fullPath).isDirectory()) {
                    return fullPath;
                }
            }
        }
    } catch (_e) {
        // Directory not found
    }
    return null;
}

function getThumbFiles(galleryDir: string): string[] {
    try {
        const files = fs.readdirSync(galleryDir);
        return files
            .filter(f => f.includes(hitomi.thumbnailMarker))
            .sort();
    } catch (_e) {
        return [];
    }
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

    // Get thumbnail files for this strip
    const allThumbs = getThumbFiles(galleryDir);
    if (allThumbs.length === 0) {
        return res.status(404).json({ error: 'No thumbnails found' });
    }

    const start = stripIdx * maxPerStrip;
    if (start >= allThumbs.length) {
        return res.status(404).json({ error: 'Strip index out of range' });
    }

    const end = Math.min(start + maxPerStrip, allThumbs.length);
    const stripThumbs = allThumbs.slice(start, end);

    try {
        // Resize all thumbnails to uniform cells
        const resizedBuffers: Buffer[] = [];
        for (const thumb of stripThumbs) {
            const thumbPath = path.join(galleryDir, thumb);
            const buf = await sharp(thumbPath)
                .resize(thumbWidth, thumbHeight, { fit: 'cover', position: 'centre' })
                .toBuffer();
            resizedBuffers.push(buf);
        }

        // Stitch horizontally
        const totalWidth = stripThumbs.length * thumbWidth;
        const composites = resizedBuffers.map((buf, i) => ({
            input: buf,
            left: i * thumbWidth,
            top: 0,
        }));

        const sprite = await sharp({
            create: {
                width: totalWidth,
                height: thumbHeight,
                channels: 3,
                background: { r: 0, g: 0, b: 0 },
            },
        })
            .composite(composites)
            .webp({ quality: 80 })
            .toBuffer();

        // Cache to disk
        fs.mkdirSync(spritesDir, { recursive: true });
        fs.writeFileSync(cachePath, sprite);

        res.setHeader('Content-Type', 'image/webp');
        res.setHeader('Cache-Control', 'public, max-age=31536000');
        res.send(sprite);
    } catch (e) {
        console.error(`Sprite generation error for gallery ${galleryId}, strip ${stripIdx}:`, e);
        res.status(500).json({ error: 'Failed to generate sprite' });
    }
};
