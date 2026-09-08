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

test('reader and gallery positions survive a new web process, including strip offsets and real back navigation', { skip: !existsSync(executablePath) }, async () => {
    const browser = await chromium.launch({ executablePath, headless: true });
    const state = { lastPath: '/', libraryPath: '/', positions: {} };
    const sessions = new WeakMap();
    const routeKey = path => {
        const q = new URL(path, 'https://gallery.test').searchParams;
        return q.has('read') ? `reader:${q.get('read')}` : `library:${q.get('p') || 1}`;
    };
    const items = Array.from({ length: 50 }, (_, i) => ({ key: `hitomi-${i + 1}`, id: String(i + 1), provider: 'hitomi', title: `Gallery ${i + 1}`, pages: 80, ready: true }));
    const image = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="300"><rect width="100" height="300" fill="#34495e"/></svg>');
    async function openProcess() {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
        await context.exposeBinding('nativeBridge', async ({ page, frame }, { command, args = {} }) => {
            let session = sessions.get(page);
            if (!session) { session = { cold: true }; sessions.set(page, session); }
            const u = new URL(frame.url()), path = u.pathname + u.search;
            if (command === 'init') {
                session.document = args.document;
                const result = { supported: true, catalog: { version: 1, items }, downloads: [], running: false, message: '', position: state.positions[routeKey(path)] };
                if (session.cold) {
                    session.cold = false;
                    if (routeKey(state.lastPath).startsWith('reader:')) {
                        if (routeKey(path) === routeKey(state.libraryPath)) result.resumeReader = state.lastPath;
                        else { result.redirect = state.libraryPath; session.resumeReader = state.lastPath; }
                    } else if (routeKey(path) !== routeKey(state.lastPath)) result.redirect = state.lastPath;
                } else if (session.resumeReader) { result.resumeReader = session.resumeReader; session.resumeReader = undefined; }
                return JSON.stringify(result);
            }
            if (command === 'view-save' && args.document === session.document) {
                const p = args.position, key = routeKey(p.path);
                state.positions[key] = structuredClone(p); state.lastPath = p.path;
                if (key.startsWith('library:')) state.libraryPath = p.path;
            }
            if (command === 'describe' || command === 'open') return JSON.stringify({ manifest: { title: args.key, pages: Array.from({ length: 80 }, () => ({ width: 100, height: 300 })) }, state: { downloaded: 80, total: 80, complete: true } });
            if (command === 'thumbnail' || command === 'page') return JSON.stringify({ url: image });
            return '{}';
        });
        await context.addInitScript(() => { window.webkit = { messageHandlers: { gallery: { postMessage: request => window.nativeBridge(request) } } }; });
        await context.route('https://gallery.test/**', async route => {
            const name = new URL(route.request().url()).pathname.slice(1) || 'index.html';
            const source = name === 'index.html'
                ? (await readFile(new URL('../downloader/public/offline/index.html', import.meta.url), 'utf8')).replace('<script type="module" src="/app.js"></script>', '<script src="/native.js"></script><script defer src="/app.js"></script>')
                : await readFile(name === 'native.js' ? new URL('../../apps/ios/Resources/native.js', import.meta.url) : new URL(`../downloader/public/offline/${name}`, import.meta.url));
            await route.fulfill({ contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html', body: source });
        });
        const page = await context.newPage();
        await page.goto('https://gallery.test/');
        return { context, page };
    }
    try {
        let { context, page } = await openProcess();
        await page.waitForSelector('.thumb-link');
        await page.goto('https://gallery.test/?p=2');
        await page.waitForFunction(() => document.querySelectorAll('.hs-row').length === 25);
        await page.evaluate(async () => {
            dispatchEvent(new Event('pointerdown'));
            const row = [...document.querySelectorAll('.hs-row-wrap')][8];
            scrollTo(0, row.offsetTop + 90 - innerHeight / 2);
            row.querySelector('.hs-row').scrollLeft = 1337;
            await window.galleryViewState.save();
        });
        const library = structuredClone(state.positions['library:2']);
        assert.equal(library.anchor, 'hitomi-34'); assert.equal(library.strips['hitomi-34'], 1337);
        await context.close(); // No browser/session storage carried to the new process.
        ({ context, page } = await openProcess());
        await page.waitForURL('https://gallery.test/?p=2');
        await page.waitForFunction(() => [...document.querySelectorAll('.hs-row-wrap')].find(r => r.galleryItem.key === 'hitomi-34')?.querySelector('.hs-row')?.scrollLeft === 1337);
        assert.ok(Math.abs(await page.evaluate(() => scrollY) - library.y) < 2);
        await page.goto('https://gallery.test/?read=hitomi-34&page=50');
        await page.waitForSelector('#page-50 img');
        await page.evaluate(async () => {
            dispatchEvent(new Event('pointerdown'));
            const target = document.getElementById('page-50');
            scrollTo(0, target.offsetTop + target.offsetHeight * 0.37 - innerHeight / 2);
            await window.galleryViewState.save();
        });
        assert.equal(state.positions['reader:hitomi-34'].page, 49);
        assert.ok(Math.abs(state.positions['reader:hitomi-34'].fraction - 0.37) < 0.002);
        await context.close();
        ({ context, page } = await openProcess());
        await page.waitForURL('https://gallery.test/?read=hitomi-34&page=50');
        await page.waitForSelector('#page-50 img');
        await page.waitForFunction(() => {
            const rect = document.getElementById('page-50').getBoundingClientRect();
            return Math.abs((innerHeight / 2 - rect.top) / rect.height - 0.37) < 0.002;
        });
        // Image dimensions settling after paint must not move the saved anchor.
        await page.evaluate(() => { document.getElementById('page-49').style.aspectRatio = '1/4'; });
        await page.waitForFunction(() => {
            const rect = document.getElementById('page-50').getBoundingClientRect();
            return Math.abs((innerHeight / 2 - rect.top) / rect.height - 0.37) < 0.002;
        });
        await page.goBack();
        await page.waitForURL('https://gallery.test/?p=2');
        await page.waitForFunction(() => [...document.querySelectorAll('.hs-row-wrap')].find(r => r.galleryItem.key === 'hitomi-34')?.querySelector('.hs-row')?.scrollLeft === 1337);
        assert.ok(Math.abs(await page.evaluate(() => scrollY) - library.y) < 2);
        // An explicit thumbnail selection must win over the saved reader page.
        await page.goto('https://gallery.test/?read=hitomi-34&page=3');
        await page.waitForSelector('#page-3 img');
        assert.ok(await page.evaluate(() => Math.abs(document.getElementById('page-3').getBoundingClientRect().top - innerHeight / 2) < 2));
        await context.close();
    } finally { await browser.close(); }
});
