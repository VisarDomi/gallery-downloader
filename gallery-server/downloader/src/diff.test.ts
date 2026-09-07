import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { computeDiff } from './diff.js';

test('provider-local diff separates complete, partial, missing, and unwanted galleries', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gallery-diff-'));
    try {
        fs.mkdirSync(path.join(root, '1'));
        fs.writeFileSync(path.join(root, '1', 'info.json'), '{}');
        fs.mkdirSync(path.join(root, '2'));
        fs.writeFileSync(path.join(root, '.downloading-2'), '');
        fs.mkdirSync(path.join(root, '9'));
        fs.writeFileSync(path.join(root, '9', 'info.json'), '{}');

        assert.deepEqual(computeDiff(new Set([1, 2, 3]), root), {
            toDownload: [3],
            toResume: [2],
            alreadyLocal: 1,
            unwantedLocal: [9],
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('source thumbnails are independently repaired without marking complete originals absent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gallery-thumbnails-'));
    const root = path.join(dir, 'imhentai');
    const gallery = path.join(root, '988447');
    fs.mkdirSync(gallery, { recursive: true });
    try {
        fs.writeFileSync(path.join(gallery, 'info.json'), JSON.stringify({ count: 2 }));
        fs.writeFileSync(path.join(gallery, 'imhentai_988447_0001.jpg'), 'one');
        fs.writeFileSync(path.join(gallery, 'imhentai_988447_0002.png'), 'two');
        fs.writeFileSync(path.join(gallery, 'imhentai_988447_thumb_0001.jpg'), 'thumb one');
        assert.deepEqual(computeDiff(new Set([988447]), root).toResume, [988447]);
        fs.writeFileSync(path.join(gallery, 'imhentai_988447_thumb_0002.jpg'), 'thumb two');
        assert.equal(computeDiff(new Set([988447]), root).alreadyLocal, 1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
