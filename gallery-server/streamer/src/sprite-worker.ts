import { parentPort } from 'worker_threads';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { hitomi } from 'gallery-sources';

const { maxPerStrip, thumbWidth, thumbHeight } = hitomi.sprite;

interface Job {
    id: number;
    galleryDir: string;
    stripIdx: number;
    cachePath: string;
}

parentPort!.on('message', async (job: Job) => {
    try {
        const thumbs = fs.readdirSync(job.galleryDir)
            .filter(f => f.includes(hitomi.thumbnailMarker))
            .sort();

        const start = job.stripIdx * maxPerStrip;
        if (start >= thumbs.length) {
            parentPort!.postMessage({ id: job.id, error: 'Strip index out of range' });
            return;
        }

        const end = Math.min(start + maxPerStrip, thumbs.length);
        const stripThumbs = thumbs.slice(start, end);

        const resizedBuffers: Buffer[] = [];
        for (const thumb of stripThumbs) {
            const buf = await sharp(path.join(job.galleryDir, thumb))
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

        const sprite = await sharp({
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

        // Cache to disk
        fs.mkdirSync(path.dirname(job.cachePath), { recursive: true });
        fs.writeFileSync(job.cachePath, sprite);

        parentPort!.postMessage({ id: job.id, buffer: sprite });
    } catch (e) {
        parentPort!.postMessage({ id: job.id, error: String(e) });
    }
});
