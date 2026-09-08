import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

// The real shared shell and native adapter, backed by a deterministic bridge.
const executablePath = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
test('native shell puts content first, prioritizes visible rows, finishes other rows, and opens unsaved reader pages', { skip: !existsSync(executablePath) }, async () => {
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(() => {
            const items = Array.from({ length: 30 }, (_, i) => ({ key: `hitomi-${i + 1}`, id: String(i + 1), provider: 'hitomi', title: `Gallery ${i + 1}`, pages: 80, ready: true }));
            const image = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="300"><rect width="100" height="300" fill="#34495e"/></svg>');
            window.requests = [];
            window.webkit = { messageHandlers: { gallery: { async postMessage({ command, args = {} }) {
                window.requests.push({ command, key: args.key, index: args.index });
                if (command === 'init') return JSON.stringify({ supported: true, catalog: { version: 1, items }, downloads: [], running: false, message: 'Feedback' });
                if (command === 'describe' || command === 'open') {
                    await new Promise(resolve => setTimeout(resolve, 15));
                    return JSON.stringify({ manifest: { title: args.key, pages: Array.from({ length: 80 }, () => ({ width: 100, height: 300 })) }, state: { downloaded: 2, total: 80, complete: false } });
                }
                if (command === 'thumbnail' || command === 'page') return JSON.stringify({ url: image });
                return '{}';
            } } } };
        });
        await page.route('https://gallery.test/**', async route => {
            const name = new URL(route.request().url()).pathname.slice(1) || 'index.html';
            const source = name === 'index.html'
                ? (await readFile(new URL('../downloader/public/offline/index.html', import.meta.url), 'utf8')).replace('<script type="module" src="/app.js"></script>', '<script src="/native.js"></script><script defer src="/app.js"></script>')
                : await readFile(name === 'native.js' ? new URL('../../apps/ios/Resources/native.js', import.meta.url) : new URL(`../downloader/public/offline/${name}`, import.meta.url));
            await route.fulfill({ contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html', body: source });
        });
        await page.goto('https://gallery.test/');
        await page.waitForFunction(() => document.querySelector('.hs-thumb')?.naturalWidth > 0);
        await page.waitForFunction(() => document.querySelectorAll('.hs-row').length === 25);
        const home = await page.evaluate(() => ({
            firstElement: document.body.firstElementChild.id,
            galleryTop: document.getElementById('hs-grid').getBoundingClientRect().top,
            footerBelowPagination: document.getElementById('library-footer').getBoundingClientRect().top >= document.getElementById('pagination').getBoundingClientRect().bottom,
            firstThumbnail: requests.findIndex(r => r.command === 'thumbnail'),
            lastRow: requests.findIndex(r => r.command === 'describe' && r.key === 'hitomi-25'),
            continued: requests.some(r => r.command === 'continue')
        }));
        assert.equal(home.firstElement, 'library'); assert.equal(home.galleryTop, 0);
        assert.ok(home.footerBelowPagination); assert.ok(home.firstThumbnail >= 0 && home.firstThumbnail < home.lastRow);
        assert.ok(home.continued);
        if (process.env.GALLERY_UI_SCREENSHOT) await page.screenshot({ path: process.env.GALLERY_UI_SCREENSHOT });
        await page.goto('https://gallery.test/?read=hitomi-1&page=50');
        await page.waitForFunction(() => document.querySelector('#page-50 img')?.naturalWidth > 0);
        assert.equal(await page.locator('.page').count(), 80);
        assert.ok(await page.evaluate(() => requests.some(r => r.command === 'page' && r.index === 49)));
        assert.equal(await page.locator('#library-footer').isVisible(), false);
        assert.deepEqual(errors, []);
    } finally { await browser.close(); }
});
