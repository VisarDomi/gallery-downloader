import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { webUi } from './web-ui.js';

test('PWA is at root, queue UI is at /downloader, and /offline is removed', async t => {
    const app = express();
    app.use(webUi(path.resolve(import.meta.dirname, '../public')));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    assert.match(await (await fetch(base + '/')).text(), /<title>Gallery Reader<\/title>/);
    assert.equal((await fetch(base + '/?read=hitomi-123&page=5')).status, 200);
    for (const route of ['/downloader', '/downloader/']) {
        const response = await fetch(base + route);
        assert.equal(response.status, 200);
        assert.match(await response.text(), /<title>Queue Manager<\/title>/);
    }
    for (const route of ['/app.js', '/worker.js', '/storage.js', '/sw.js', '/icon.svg']) {
        assert.equal((await fetch(base + route)).status, 200, route);
    }
    const manifest = await (await fetch(base + '/manifest.webmanifest')).json() as { id: string; start_url: string; scope: string };
    assert.equal(manifest.id, '/');
    assert.equal(manifest.start_url, '/');
    assert.equal(manifest.scope, '/');
    for (const route of ['/offline', '/offline/', '/offline/sw.js', '/offline/index.html']) {
        assert.equal((await fetch(base + route, { redirect: 'manual' })).status, 404, route);
    }
});
