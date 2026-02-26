#!/usr/bin/env node
/**
 * Pre-generate sprite strips for all galleries that don't have them yet.
 * Run standalone: node dist/pregen-sprites.js
 * Designed to run daily via systemd timer.
 */

import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { hitomi } from 'gallery-sources';

const MEDIA_ROOT = '/home/visar/Pictures';
const GALLERY_ROOT = path.join(MEDIA_ROOT, hitomi.gallerySubdir);
const { maxPerStrip, thumbWidth, thumbHeight } = hitomi.sprite;

function getThumbFiles(galleryDir: string): string[] {
    try {
        return fs.readdirSync(galleryDir)
            .filter(f => f.includes(hitomi.thumbnailMarker))
            .sort();
    } catch {
        return [];
    }
}

async function generateStrip(galleryDir: string, stripIdx: number, thumbs: string[]): Promise<Buffer> {
    const start = stripIdx * maxPerStrip;
    const end = Math.min(start + maxPerStrip, thumbs.length);
    const stripThumbs = thumbs.slice(start, end);

    const resizedBuffers: Buffer[] = [];
    for (const thumb of stripThumbs) {
        const buf = await sharp(path.join(galleryDir, thumb))
            .resize(thumbWidth, thumbHeight, { fit: 'cover', position: 'centre' })
            .toBuffer();
        resizedBuffers.push(buf);
    }

    const totalWidth = stripThumbs.length * thumbWidth;
    const composites = resizedBuffers.map((buf, i) => ({
        input: buf,
        left: i * thumbWidth,
        top: 0,
    }));

    return sharp({
        create: {
            width: totalWidth,
            height: thumbHeight,
            channels: 3 as const,
            background: { r: 0, g: 0, b: 0 },
        },
    })
        .composite(composites)
        .webp({ quality: 80 })
        .toBuffer();
}

async function processGallery(galleryDir: string, galleryName: string): Promise<number> {
    // Fast check: if .sprites/ exists and has at least one strip, likely complete
    const spritesDir = path.join(galleryDir, '.sprites');
    try {
        const existing = fs.readdirSync(spritesDir);
        if (existing.length > 0) {
            // Verify: count expected strips from thumb count
            const thumbs = getThumbFiles(galleryDir);
            const expectedStrips = Math.ceil(thumbs.length / maxPerStrip);
            if (existing.length >= expectedStrips) return 0;
        }
    } catch {
        // .sprites doesn't exist — needs generation
    }

    const thumbs = getThumbFiles(galleryDir);
    if (thumbs.length === 0) return 0;

    const stripCount = Math.ceil(thumbs.length / maxPerStrip);
    let generated = 0;

    for (let i = 0; i < stripCount; i++) {
        const cachePath = path.join(spritesDir, `strip_${i}.webp`);
        if (fs.existsSync(cachePath)) continue;

        try {
            const sprite = await generateStrip(galleryDir, i, thumbs);
            fs.mkdirSync(spritesDir, { recursive: true });
            fs.writeFileSync(cachePath, sprite);
            generated++;
        } catch (e) {
            console.error(`  Error generating strip ${i} for ${galleryName}: ${e}`);
        }
    }

    return generated;
}

async function main() {
    const entries = fs.readdirSync(GALLERY_ROOT).filter(name => {
        if (name.startsWith('.')) return false;
        return fs.statSync(path.join(GALLERY_ROOT, name)).isDirectory();
    }).sort();

    console.log(`Scanning ${entries.length} galleries for missing sprites...`);

    let totalGenerated = 0;
    let galleriesProcessed = 0;
    let skipped = 0;
    const startTime = Date.now();

    for (const name of entries) {
        const galleryDir = path.join(GALLERY_ROOT, name);

        // Skip galleries still downloading
        const galleryId = name.split(' ')[0];
        if (fs.existsSync(path.join(GALLERY_ROOT, hitomi.downloadingMarker(galleryId)))) continue;

        const generated = await processGallery(galleryDir, name);
        if (generated > 0) {
            galleriesProcessed++;
            totalGenerated += generated;
            console.log(`  [${galleriesProcessed}] ${name.substring(0, 60)} — ${generated} strip(s)`);
        } else {
            skipped++;
            if (skipped % 500 === 0) console.log(`  ...skipped ${skipped} (already have sprites)`);
        }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\nDone. Generated ${totalGenerated} strips across ${galleriesProcessed} galleries in ${elapsed}s`);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
