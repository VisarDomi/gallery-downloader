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
