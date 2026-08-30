import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { durableAtomicWriteFileSync, durableUnlinkSync } from './durable-file.js';

test('durable atomic writes replace a file without leaving temporary files', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-file-'));
    const filePath = path.join(directory, 'state.json');
    try {
        durableAtomicWriteFileSync(filePath, 'first');
        durableAtomicWriteFileSync(filePath, 'second');
        assert.equal(fs.readFileSync(filePath, 'utf8'), 'second');
        assert.deepEqual(fs.readdirSync(directory), ['state.json']);
        durableUnlinkSync(filePath);
        assert.deepEqual(fs.readdirSync(directory), []);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
