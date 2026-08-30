import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { deleteGalleries, findPublishedGalleryIds } from './gallery-delete.js';

test('provider-local deletion removes loose data, CBZ, and Hitomi archive entries', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gallery-delete-'));
    const workingDir = path.join(root, 'pictures');
    const komgaRoot = path.join(root, 'komga');
    const galleryRoot = path.join(workingDir, 'gallery-dl', 'hitomi');
    const cbzRoot = path.join(komgaRoot, '_oneshots');
    fs.mkdirSync(path.join(galleryRoot, '123'), { recursive: true });
    fs.mkdirSync(cbzRoot, { recursive: true });
    fs.writeFileSync(path.join(galleryRoot, '123', 'info.json'), '{}');
    fs.writeFileSync(path.join(cbzRoot, 'hitomi-123.cbz'), 'zip');

    const archivePath = path.join(workingDir, 'gallery-dl', 'hitomi.sqlite3');
    const database = new Database(archivePath);
    database.exec('CREATE TABLE archive (entry TEXT PRIMARY KEY)');
    database.prepare('INSERT INTO archive VALUES (?)').run('hitomi123_1');
    database.close();

    try {
        assert.deepEqual(deleteGalleries('hitomi', [123], { workingDir, komgaLibraryRoot: komgaRoot }), {
            deleted: [123],
            skipped: [],
        });
        assert.equal(fs.existsSync(path.join(galleryRoot, '123')), false);
        assert.equal(fs.existsSync(path.join(cbzRoot, 'hitomi-123.cbz')), false);
        const verify = new Database(archivePath, { readonly: true });
        const row = verify.prepare('SELECT count(*) AS count FROM archive').get() as { count: number };
        assert.equal(row.count, 0);
        verify.close();
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('active gallery deletion is skipped without touching its files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gallery-delete-active-'));
    const workingDir = path.join(root, 'pictures');
    const komgaRoot = path.join(root, 'komga');
    const galleryRoot = path.join(workingDir, 'gallery-dl', 'imhentai');
    fs.mkdirSync(path.join(galleryRoot, '456'), { recursive: true });
    fs.writeFileSync(path.join(galleryRoot, '456', 'info.json'), '{}');
    fs.writeFileSync(path.join(galleryRoot, '.downloading-456'), '');

    try {
        assert.deepEqual(deleteGalleries('imhentai', [456], { workingDir, komgaLibraryRoot: komgaRoot }), {
            deleted: [],
            skipped: [{ id: 456, reason: 'currently downloading' }],
        });
        assert.equal(fs.existsSync(path.join(galleryRoot, '456', 'info.json')), true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('published gallery ids are provider-qualified', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gallery-published-'));
    const cbzRoot = path.join(root, '_oneshots');
    fs.mkdirSync(cbzRoot, { recursive: true });
    fs.writeFileSync(path.join(cbzRoot, 'hitomi-20.cbz'), 'x');
    fs.writeFileSync(path.join(cbzRoot, 'hitomi-3.cbz'), 'x');
    fs.writeFileSync(path.join(cbzRoot, 'imhentai-20.cbz'), 'x');
    fs.writeFileSync(path.join(cbzRoot, 'notes.txt'), 'x');

    try {
        assert.deepEqual(findPublishedGalleryIds('hitomi', root), [3, 20]);
        assert.deepEqual(findPublishedGalleryIds('imhentai', root), [20]);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
