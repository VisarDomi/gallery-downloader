import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

test('worker boots without OPFS, resumes a stopped transfer, reads offline, and repairs eviction', async t => {
    // Exercise the real worker protocol with deterministic browser API adapters.
    // This is not a claim about Safari's storage engine or device cold-launch time.
    const old = Object.fromEntries(['navigator', 'self', 'indexedDB', 'postMessage', 'fetch'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
    t.after(() => { for (const [key, descriptor] of Object.entries(old)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
    const stores = new Map(), files = new Map();
    let opened = false, opfsOpens = 0, mode = 'pause', firstPageRequests = 0, pageRequests = 0, thumbnailRequests = 0;
    const db = {
        createObjectStore(name) { stores.set(name, new Map()); }, close() {},
        transaction(name) {
            const tx = { objectStore() { return Object.fromEntries(['get', 'getAll', 'put'].map(method => [method, (...args) => {
                const request = {};
                setImmediate(() => {
                    const map = stores.get(name);
                    if (method === 'put') { map.set(args[1], structuredClone(args[0])); request.result = args[1]; }
                    else request.result = structuredClone(method === 'getAll' ? [...map.values()] : map.get(args[0]));
                    tx.oncomplete();
                });
                return request;
            }])); } };
            return tx;
        },
    };
    const root = { async getDirectoryHandle() { return root; }, async getFileHandle(name, { create } = {}) {
        if (!files.has(name)) {
            if (!create) throw new DOMException('Missing', 'NotFoundError');
            files.set(name, new Uint8Array());
        }
        return { async getFile() { return new Blob([files.get(name)]); }, async createSyncAccessHandle() {
            return {
                getSize() { return files.get(name).length; },
                truncate(size) { const b = new Uint8Array(size); b.set(files.get(name).subarray(0, size)); files.set(name, b); },
                write(chunk, { at }) { const b = new Uint8Array(Math.max(files.get(name).length, at + chunk.length)); b.set(files.get(name)); b.set(chunk, at); files.set(name, b); return chunk.length; },
                flush() {}, close() {},
            };
        } };
    } };
    const manifest = { key: 'hitomi-123', title: 'Test gallery', revision: 'a'.repeat(24), bytes: 11, pages: [
        { size: 5, offset: 0, name: 'hitomi_123_1.jpg', url: '/offline-api/hitomi/123/pages/hitomi_123_1.jpg' },
        { size: 6, offset: 5, name: 'hitomi_123_2.jpg', url: '/offline-api/hitomi/123/pages/hitomi_123_2.jpg' },
    ] };
    manifest.thumbnails = { key: manifest.key, kind: 'thumbnails', revision: 'b'.repeat(24), bytes: 4, pages: [
        { size: 2, offset: 0, name: 'hitomi_123_thumb_1.jpg', url: '/offline-api/hitomi/123/thumbnails/hitomi_123_thumb_1.jpg' },
        { size: 2, offset: 2, name: 'hitomi_123_thumb_2.jpg', url: '/offline-api/hitomi/123/thumbnails/hitomi_123_thumb_2.jpg' },
    ] };
    const catalog = { version: 1, items: [{ key: manifest.key, provider: 'hitomi', id: '123', title: manifest.title, ready: true }] };
    let events = [], sequence = 0;
    const requests = new Map();
    const globals = {
        self: {},
        navigator: { storage: { async getDirectory() { opfsOpens++; return root; } }, locks: { async request(_name, _options, fn) { return fn({}); } } },
        indexedDB: { open() { const request = {}; setImmediate(() => { request.result = db; if (!opened) { request.onupgradeneeded(); opened = true; } request.onsuccess(); }); return request; } },
        postMessage(message) { const data = structuredClone(message); if ('id' in data) { const request = requests.get(data.id); requests.delete(data.id); if (data.error) request.reject(new Error(data.error)); else request.resolve(data.result); } else events.push(data); },
        async fetch(url, options) {
            if (mode === 'offline') throw new TypeError('Network unavailable');
            if (url.endsWith('/catalog')) return Response.json(catalog);
            if (url.endsWith('/manifest')) return Response.json(manifest);
            if (url.includes('/thumbnails/')) { thumbnailRequests++; return new Response('tn', { headers: { 'content-type': 'image/jpeg' } }); }
            pageRequests++;
            if (url.endsWith('_1.jpg')) { firstPageRequests++; return new Response('first', { headers: { 'content-type': 'image/jpeg' } }); }
            if (mode === 'pause') return new Response(new ReadableStream({ start(controller) {
                controller.enqueue(new TextEncoder().encode('s'));
                options.signal.addEventListener('abort', () => controller.error(options.signal.reason), { once: true });
            } }), { headers: { 'content-type': 'image/jpeg' } });
            return new Response('second', { headers: { 'content-type': 'image/jpeg' } });
        },
    };
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
    const rpc = (command, args) => new Promise((resolve, reject) => { const id = ++sequence; requests.set(id, { resolve, reject }); void self.onmessage({ data: { id, command, args } }); });
    const until = async predicate => { for (let i = 0; i < 300; i++) { if (predicate()) return; await delay(10); } throw new Error('Timed out waiting for worker'); };
    await import(`../downloader/public/offline/worker.js?instance=first`);
    assert.equal((await rpc('init')).supported, true);
    await until(() => events.some(e => e.type === 'catalog' && e.source === 'PC'));
    assert.equal(opfsOpens, 0, 'startup must not open image storage');
    await rpc('download');
    await until(() => events.some(e => e.type === 'progress' && e.state.downloaded === 1));
    await rpc('stop');
    const filename = [...files.keys()].find(name => name.endsWith('.pages'));
    assert.equal(files.get(filename).length, 5, 'the interrupted second page is not committed');
    // Simulate bytes flushed immediately before a process died, without an IDB commit.
    files.set(filename, new TextEncoder().encode('firstBAD'));
    mode = 'full'; events = [];
    await rpc('download');
    await until(() => events.some(e => e.type === 'download-status' && !e.running));
    assert.equal(firstPageRequests, 1, 'resume must not download the committed first page again');
    assert.equal(new TextDecoder().decode(files.get(filename)), 'firstsecond');
    await rpc('stop');
    assert.equal(thumbnailRequests, 2, 'thumbnail checkpoints resume independently without fetching saved thumbnails again');
    // Upgrade an existing original-only installation: preserve its identity and
    // checkpoint, remove only the test thumbnail fixture, then backfill previews.
    const thumbnailFilename = [...files.keys()].find(name => name.endsWith('.thumbs'));
    files.delete(thumbnailFilename);
    stores.get('downloads').delete('hitomi-123:thumbs');
    const originalBefore = files.get(filename).slice();
    events = [];
    await rpc('download');
    await until(() => events.some(e => e.type === 'download-status' && !e.running));
    await rpc('stop');
    assert.equal(firstPageRequests, 1, 'thumbnail backfill must not re-download old original pages');
    assert.deepEqual(files.get(filename), originalBefore);
    assert.equal(thumbnailRequests, 4);
    const beforeBoot = opfsOpens, beforeRead = pageRequests;
    mode = 'offline'; events = [];
    await import(`../downloader/public/offline/worker.js?instance=second`);
    await rpc('init');
    assert.equal(opfsOpens, beforeBoot, 'offline restart must not open the gallery packs');
    assert.equal(events.find(e => e.type === 'catalog').downloads.find(s => s.key === manifest.key).downloaded, 2);
    assert.equal((await rpc('describe', { key: manifest.key })).manifest.pages.length, 2);
    assert.equal(opfsOpens, beforeBoot, 'metadata alone must not open any image directory');
    assert.equal(await (await rpc('thumbnail', { key: manifest.key, index: 1 })).blob.text(), 'tn');
    assert.equal(thumbnailRequests, 4, 'offline thumbnails must not use the network');
    const openedGallery = await rpc('open', { key: manifest.key });
    assert.equal(openedGallery.state.complete, true);
    assert.equal(await (await rpc('page', { index: 1 })).blob.text(), 'second');
    assert.equal(pageRequests, beforeRead, 'reader must not fetch images from the network');
    await assert.rejects(rpc('page', { index: 2 }), /not downloaded/);
    await rpc('close');
    files.delete(filename);
    await assert.rejects(rpc('open', { key: manifest.key }), /missing or incomplete/);
    mode = 'full'; events = [];
    await rpc('download');
    await until(() => events.some(e => e.type === 'download-status' && !e.running));
    await rpc('stop');
    assert.equal(firstPageRequests, 2);
    assert.equal(new TextDecoder().decode(files.get(filename)), 'firstsecond');
    assert.ok([...stores.get('downloads').values()].every(v => !(v instanceof Blob)));
});
