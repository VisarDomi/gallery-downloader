import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

test('service worker caches only the tiny shell and never intercepts catalog or image requests', async () => {
    const root = fileURLToPath(new URL('../downloader/public/offline/', import.meta.url));
    const listeners = new Map(); let resources;
    const context = vm.createContext({ URL, Set, fetch() { throw new Error('Unexpected network'); },
        caches: { async open() { return { async addAll(urls) { resources = urls; }, async match(url) { return url; } }; } },
        self: { registration: { scope: 'https://test.local/' }, addEventListener(type, handler) { listeners.set(type, handler); } },
    });
    vm.runInContext(readFileSync(path.join(root, 'sw.js'), 'utf8'), context);
    let installed;
    listeners.get('install')({ waitUntil(promise) { installed = promise; } });
    await installed;
    let total = 0;
    for (const resource of resources) total += statSync(path.join(root, resource === './' ? 'index.html' : resource)).size;
    assert.ok(total < 100_000, `shell should remain tiny, got ${total} bytes`);
    for (const url of ['https://test.local/offline-api/catalog', 'https://test.local/offline-api/hitomi/123/pages/hitomi_123_1.jpg', 'https://test.local/downloader', 'https://test.local/offline/', 'https://test.local/socket.io/socket.io.js']) {
        listeners.get('fetch')({ request: { method: 'GET', url }, respondWith() { assert.fail('Intercepted non-shell request'); } });
    }
    let response;
    listeners.get('fetch')({ request: { method: 'GET', url: 'https://test.local/' }, respondWith(promise) { response = promise; } });
    assert.equal(await response, 'https://test.local/');
    for (const suffix of ['?p=23', '?read=imhentai-123&page=5']) {
        listeners.get('fetch')({ request: { method: 'GET', mode: 'navigate', url: 'https://test.local/' + suffix }, respondWith(promise) { response = promise; } });
        assert.equal(await response, 'https://test.local/');
    }
});
