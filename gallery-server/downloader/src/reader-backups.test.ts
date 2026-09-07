import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import express from 'express';
import { BackupStore, readerBackups } from './reader-backups.js';

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-backup-test-'));
    return { root, store: new BackupStore(root), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const data = (ids: number[]) => ({ version: 1, indexedDB: { favorites: ids, searches: [], page: 1, scroll: {} } });

test('isolated phones/providers; exactly current and previous; idempotent retries', () => {
    const { root, store, cleanup } = fixture();
    try {
        const id = randomUUID();
        const put = (ids: number[], baseRevision: string | null) => store.put('gallery-reader', 'hitomi', id, { label: 'iPhone', data: data(ids), baseRevision });
        const first = put([1], null);
        assert.equal(first.previous, null);
        assert.deepEqual(put([1], null), first);
        const second = put([1, 2], first.current.revision);
        const third = put([1, 2, 3], second.current.revision);
        assert.deepEqual(third.previous, second.current);
        assert.equal(Object.keys(third).length, 4);
        assert.throws(() => put([], first.current.revision), /CONFLICT/);
        assert.throws(() => put([], third.current.revision), /local data is now empty/);
        assert.deepEqual(store.read('gallery-reader', 'hitomi', id), third);
        const copy = store.put('gallery-reader', 'hitomi', randomUUID(), { label: 'Restored phone', data: third.current.data, baseRevision: null });
        assert.notEqual(copy.id, id);
        assert.equal(store.list('gallery-reader', 'hitomi').length, 2);
        assert.equal(store.list('gallery-reader', 'imhentai').length, 0);
        assert.equal(fs.statSync(store.file('gallery-reader', 'hitomi', id)).mode & 0o777, 0o600);
        assert.equal(fs.statSync(root).mode & 0o777, 0o700);
        assert.equal(fs.readdirSync(store.directory('gallery-reader', 'hitomi')).length, 2);
        assert.deepEqual(new BackupStore(root).read('gallery-reader', 'hitomi', id), third);
    } finally { cleanup(); }
});

test('invalid namespaces, IDs and snapshots are rejected', () => {
    const { store, cleanup } = fixture();
    try {
        assert.throws(() => store.list('../elsewhere', 'hitomi'));
        assert.throws(() => store.list('gallery-reader', 'asurascans'));
        assert.throws(() => store.read('gallery-reader', 'hitomi', '../secret'));
        assert.throws(() => store.put('gallery-reader', 'hitomi', randomUUID(), { label: 'Phone', data: null, baseRevision: null }));
    } finally { cleanup(); }
});

test('HTTP backups require private key, allow only reader origins, and never cache', async () => {
    const { root, cleanup } = fixture();
    const app = express();
    app.use('/api/reader-backups', readerBackups(root));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/reader-backups/gallery-reader/hitomi`;
    try {
        const denied = await fetch(base);
        assert.equal(denied.status, 401);
        assert.equal(denied.headers.get('cache-control'), 'no-store');
        assert.equal(denied.headers.get('access-control-allow-origin'), null);
        const untrusted = await fetch(base, { headers: { Origin: 'https://untrusted.invalid' } });
        assert.equal(untrusted.headers.get('access-control-allow-origin'), null);
        const preflight = await fetch(base, { method: 'OPTIONS', headers: { Origin: 'https://hitomi.la', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'X-Reader-Backup-Key, Content-Type' } });
        assert.equal(preflight.status, 204);
        assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://hitomi.la');
        const allowedButUnauthenticated = await fetch(base, { headers: { Origin: 'https://hitomi.la' } });
        assert.equal(allowedButUnauthenticated.status, 401);
        const headers = { 'X-Reader-Backup-Key': fs.readFileSync(path.join(root, 'access-key'), 'utf8'), 'Content-Type': 'application/json' };
        const saved = await fetch(base + '/' + randomUUID(), { method: 'PUT', headers, body: JSON.stringify({ label: 'Phone', baseRevision: null, data: data([7, 8]) }) });
        assert.equal(saved.status, 200);
        assert.equal((await (await fetch(base, { headers })).json() as unknown[]).length, 1);
    } finally {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        cleanup();
    }
});
