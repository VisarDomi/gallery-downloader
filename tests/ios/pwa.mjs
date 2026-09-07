import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createController, createSession } from 'userscript-ios-test/controller';

const root = resolve(import.meta.dirname, '../..');
const controller = createController({ root, name: 'gallery-downloader', connectionTimeoutMs: 60000, commandTimeoutMs: 40000 });
const session = createSession({ controller });
const origin = 'https://192.168.1.197:7777';
async function command(code, options) {
    const foreground = await controller.foregroundClient();
    return controller.command(foreground.client, code, options);
}
try {
    await session.connect({ allowedHosts: ['192.168.1.197'] });
    console.log('Preflight:', await command('return { href: location.href, visibility: document.visibilityState };'));
    await session.navigate(origin + '/');
    const home = await command(`
        for (let i = 0; i < 140 && ![...document.querySelectorAll('.hs-thumb')].some(img => img.naturalWidth > 0); i++) await new Promise(r => setTimeout(r, 200));
        return { title: document.title, rows: document.querySelectorAll('.hs-row').length,
            loaded: [...document.querySelectorAll('.hs-thumb')].filter(img => img.naturalWidth > 0).length,
            status: document.getElementById('status')?.textContent, update: document.getElementById('sw-status')?.textContent,
            links: [...document.querySelectorAll('.thumb-link')].slice(0, 5).map(a => a.href),
            originals: performance.getEntriesByType('resource').filter(e => e.name.includes('/pages/')).length,
            boot: window.bootMarks };
    `);
    console.log('Home:', home);
    assert.equal(home.title, 'Gallery Reader'); assert.ok(home.loaded > 0); assert.equal(home.originals, 0);
    const selected = await command(`
        const db = await new Promise((resolve, reject) => { const r = indexedDB.open('gallery-offline-test-v1', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
        try {
            const states = await new Promise((resolve, reject) => { const r = db.transaction('downloads').objectStore('downloads').getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
            const saved = states.find(s => !s.kind && s.downloaded > 0);
            return saved ? { key: saved.key, downloaded: saved.downloaded } : null;
        } finally { db.close(); }
    `);
    console.log('Existing Safari download:', selected);
    // Navigate from a real strip (saved gallery if this Safari partition has one).
    if (selected) {
        const catalog = await command(`return (await (await fetch('/offline-api/catalog')).json()).items.map(i => i.key);`);
        const page = Math.floor(catalog.indexOf(selected.key) / 25) + 1;
        if (page > 1) await session.navigate(origin + '/?p=' + page);
    }
    const probe = await command(`
        const key = ${JSON.stringify(selected?.key || null)};
        for (let i = 0; i < 120 && !document.querySelector('.thumb-link'); i++) await new Promise(r => setTimeout(r, 200));
        const link = [...document.querySelectorAll('.thumb-link')].find(a => !key || new URL(a.href).searchParams.get('read') === key);
        if (!link) throw new Error('Target strip unavailable');
        const row = link.closest('.hs-row-wrap'), strip = link.parentElement;
        window.scrollTo(0, row.offsetTop); strip.scrollLeft = 200;
        globalThis.__pwaProbe = { row, strip, y: scrollY, x: strip.scrollLeft, persisted: false };
        addEventListener('pageshow', e => { globalThis.__pwaProbe.persisted = e.persisted; }, { once: true });
        return { href: link.href, home: location.href };
    `);
    await command(`location.href = ${JSON.stringify(probe.href)};`, { expectResult: false });
    await session.waitForNavigation(client => new URL(client.href).searchParams.has('read'), 'Reader');
    const reader = await command(`
        for (let i = 0; i < 100 && !document.querySelector('.hs-reader-img') && document.getElementById('reader-message')?.textContent === 'Opening saved pages…'; i++) await new Promise(r => setTimeout(r, 200));
        for (let i = 0; i < 60 && document.querySelector('.hs-reader-img') && ![...document.querySelectorAll('.hs-reader-img')].some(img => img.naturalWidth > 0); i++) await new Promise(r => setTimeout(r, 200));
        return { pages: document.querySelectorAll('.hs-reader-img').length, message: document.getElementById('reader-message')?.textContent,
            loaded: [...document.querySelectorAll('.hs-reader-img')].filter(img => img.naturalWidth > 0).length,
            controls: [...document.querySelectorAll('#reader button')].length };
    `);
    console.log('Reader:', reader);
    assert.equal(reader.controls, 0);
    if (selected) { assert.equal(reader.pages, selected.downloaded); assert.ok(reader.loaded > 0); }
    await command('history.back();', { expectResult: false });
    await session.waitForNavigation(client => client.href === probe.home, 'Back to home');
    await new Promise(r => setTimeout(r, 1500));
    const backCode = `
        const p = globalThis.__pwaProbe;
        return { href: location.href, persisted: p?.persisted, sameRow: !!p?.row?.isConnected, x: p?.strip?.scrollLeft, expectedX: p?.x, y: scrollY, expectedY: p?.y };
    `;
    let back;
    try { back = await command(backCode); }
    catch (error) {
        console.log('Back handoff retry:', error.message);
        back = await command(backCode); // Read-only retry after re-claiming the live tab.
    }
    console.log('bfcache:', back);
    assert.equal(back.persisted, true); assert.equal(back.sameRow, true);
    assert.equal(back.x, back.expectedX); assert.ok(Math.abs(back.y - back.expectedY) < 5);
    await session.navigate(origin + '/?p=23');
    const last = await command(`
        for (let i = 0; i < 100 && ![...document.querySelectorAll('.hs-thumb')].some(img => img.naturalWidth > 0); i++) await new Promise(r => setTimeout(r, 200));
        return { rows: document.querySelectorAll('.hs-row-wrap').length,
            imhentai: [...document.querySelectorAll('.thumb-link')].every(a => new URL(a.href).searchParams.get('read').startsWith('imhentai-')),
            loaded: [...document.querySelectorAll('.hs-thumb')].filter(img => img.naturalWidth > 0).length };
    `);
    console.log('IMHentai last page:', last);
    assert.equal(last.rows, 10); assert.equal(last.imhentai, true); assert.ok(last.loaded > 0);
    await command(`document.querySelector('.info-btn').click(); return true;`);
    const info = await command(`
        for (let i = 0; i < 40 && !document.querySelector('.hs-modal-row'); i++) await new Promise(r => setTimeout(r, 100));
        return { open: document.querySelector('dialog')?.open, rows: document.querySelectorAll('.hs-modal-row').length };
    `);
    console.log('Information dialog:', info); assert.equal(info.open, true); assert.ok(info.rows > 2);
    await command(`document.querySelector('dialog').close(); return true;`);
    console.log('PASS: source thumbnail home and native bfcache navigation; existing downloads were not changed.');
} finally {
    try { await session.cleanup(); } finally { session.close(); }
}
