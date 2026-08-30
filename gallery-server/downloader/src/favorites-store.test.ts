import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalizeFavoriteIds, readFavorites, writeFavorites } from './favorites-store.js';

test('favorite snapshots preserve order, deduplicate, and round-trip atomically', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gallery-favorites-'));
    const filePath = path.join(directory, 'hitomi.json');
    try {
        assert.deepEqual(readFavorites(filePath, 'hitomi').ids, []);
        const written = writeFavorites(filePath, 'hitomi', [9, 3, 9, 7]);
        assert.deepEqual(written.ids, [9, 3, 7]);
        assert.deepEqual(readFavorites(filePath, 'hitomi'), written);
        assert.deepEqual(fs.readdirSync(directory), ['hitomi.json']);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('favorite snapshots reject invalid IDs', () => {
    assert.throws(() => normalizeFavoriteIds('1,2'));
    assert.throws(() => normalizeFavoriteIds([1, 0]));
    assert.throws(() => normalizeFavoriteIds([1, 2.5]));
});
