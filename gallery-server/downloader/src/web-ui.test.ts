import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { webUi } from './web-ui.js';

test('only the queue UI is served; the Gallery Reader app bundles its own UI', async t => {
    const app = express();
    app.use(webUi(path.resolve(import.meta.dirname, '../public')));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    for (const route of ['/downloader', '/downloader/']) {
        const response = await fetch(base + route);
        assert.equal(response.status, 200);
        assert.match(await response.text(), /<title>Queue Manager<\/title>/);
    }
    for (const route of ['/', '/app.js', '/index.html', '/offline/', '/sw.js']) {
        assert.equal((await fetch(base + route, { redirect: 'manual' })).status, 404, route);
    }
});
