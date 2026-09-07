import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { completeSourceThumbnails, downloadFile, sourceThumbnailUrl } from './imhentai-downloader.js';
import { DownloadFailure } from './download-failure.js';

test('thumbnail pattern keeps the source extension past the initially listed ten pages', () => {
    const template = 'https://m9.imhentai.xxx/028/jnwqbic1ea/1t.jpg';
    assert.equal(sourceThumbnailUrl(template, 5), 'https://m9.imhentai.xxx/028/jnwqbic1ea/5t.jpg');
    assert.equal(sourceThumbnailUrl(template, 144), 'https://m9.imhentai.xxx/028/jnwqbic1ea/144t.jpg');
    assert.equal(sourceThumbnailUrl('https://m7.imhentai.xxx/022/hm8sbpr0d5/2t.jpg', 217), 'https://m7.imhentai.xxx/022/hm8sbpr0d5/217t.jpg');
    assert.throws(() => sourceThumbnailUrl('https://example.com/5.webp', 5));
});

test('gallery-reader parity: mixed originals, explicit thumbnail exceptions, and all remaining pages', () => {
    const base = 'https://m9.imhentai.xxx/028/jnwqbic1ea/';
    const images = Array.from({ length: 144 }, (_, i) => ({
        page: i + 1,
        fullUrl: `${base}${i + 1}.${i === 4 ? 'webp' : i === 1 ? 'png' : 'jpg'}`,
        thumbnailUrl: i < 10 ? `${base}${i + 1}t.jpg` : '',
    }));
    const originals = images.map(image => image.fullUrl);
    completeSourceThumbnails(images);
    assert.equal(images[1].thumbnailUrl, `${base}2t.jpg`);
    assert.equal(images[4].thumbnailUrl, `${base}5t.jpg`);
    assert.equal(images[143].thumbnailUrl, `${base}144t.jpg`);
    assert.deepEqual(images.map(image => image.fullUrl), originals);

    const exceptions = [
        { page: 1, thumbnailUrl: `${base}1t.webp?token=source` },
        { page: 2, thumbnailUrl: `${base}2t.jpg` },
        { page: 3, thumbnailUrl: '' },
    ];
    completeSourceThumbnails(exceptions);
    assert.equal(exceptions[1].thumbnailUrl, `${base}2t.jpg`);
    assert.equal(exceptions[2].thumbnailUrl, `${base}3t.webp?token=source`);
    assert.equal(sourceThumbnailUrl(`${base}1t.gif`, 144), `${base}144t.gif`);
    assert.throws(() => completeSourceThumbnails([{ page: 1, thumbnailUrl: '' }]), /no thumbnail URL/);
});

test('source file downloads skip saved files, validate image responses, and expose rate-limit cooldowns', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gallery-source-'));
    let requests = 0;
    const server = http.createServer((req, res) => {
        requests++;
        if (req.url === '/429') { res.writeHead(429, { 'Retry-After': '120' }); res.end('limited'); }
        else if (req.url === '/html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('challenge'); }
        else { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); res.end('source bytes'); }
    }).listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(dir, { recursive: true, force: true }); });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const file = path.join(dir, 'thumb.jpg');
    assert.equal(await downloadFile(base + '/ok', file), 'downloaded');
    const before = await fs.stat(file);
    assert.equal(await downloadFile(base + '/ok', file), 'reused');
    assert.equal((await fs.stat(file)).mtimeMs, before.mtimeMs);
    assert.equal(requests, 1);
    assert.equal(await fs.readFile(file, 'utf8'), 'source bytes');
    await assert.rejects(downloadFile(base + '/429', path.join(dir, 'limited.jpg')), (error: unknown) =>
        error instanceof DownloadFailure && error.status === 429 && error.retryAfterMs === 120_000 && error.asset === 'limited.jpg');
    await assert.rejects(downloadFile(base + '/html', path.join(dir, 'challenge.jpg')), /Non-image/);
    assert.deepEqual(await fs.readdir(dir), ['thumb.jpg']);
});
