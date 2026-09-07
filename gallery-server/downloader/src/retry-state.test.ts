import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RetryState } from './retry-state.js';
import { DownloadFailure, retryAfter } from './download-failure.js';
import { protectBrowserMetrics } from './headful-chromium.js';

test('404 gets one fresh attempt; failures survive restarts until explicitly cleared', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gallery-retry-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'retry.json');
    let state = new RetryState(file, () => 1000);
    state.begin('gallery');
    assert.equal(state.fail('gallery', new DownloadFailure('HTTP 404', 404)).nextRetryAt, 31_000);
    state = new RetryState(file, () => 31_000);
    state.begin('gallery');
    assert.equal(state.fail('gallery', new DownloadFailure('HTTP 404', 404)).status, 'failed');
    state = new RetryState(file);
    assert.equal(state.blocked('gallery'), true);
    assert.throws(() => state.begin('gallery'), /manual retry/);
    state.clear('gallery'); state.begin('gallery');
    assert.equal(state.get('gallery')!.attempts, 1);
});

test('temporary failures honor Retry-After, preserve their budget, and stop after six attempts', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gallery-retry-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'retry.json');
    let state = new RetryState(file, () => 0);
    state.begin('gallery');
    assert.equal(state.fail('gallery', new DownloadFailure('HTTP 429', 429, 600_000, 'page 101')).nextRetryAt, 600_000);
    for (let attempt = 2; attempt <= 6; attempt++) {
        state = new RetryState(file, () => 0);
        state.begin('gallery');
        const job = state.fail('gallery', new TypeError('fetch failed'));
        assert.equal(job.attempts, attempt);
        assert.equal(job.status, attempt === 6 ? 'failed' : 'retrying');
    }
    assert.equal(new RetryState(file).blocked('gallery'), true);
    assert.equal(retryAfter('120', 0), 120_000);
    assert.equal(retryAfter('Thu, 01 Jan 1970 00:02:00 GMT', 0), 120_000);
});

test('crashes consume reserved attempts; corrupt retry state fails closed', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gallery-retry-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'retry.json');
    let state = new RetryState(file);
    for (let i = 0; i < 6; i++) { state.begin('gallery'); state = new RetryState(file); }
    assert.equal(state.blocked('gallery'), true);
    fs.writeFileSync(file, '{');
    assert.throws(() => new RetryState(file));
});

test('metrics protection creates a non-writable directory and rejects symlinks', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gallery-metrics-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    protectBrowserMetrics(dir);
    assert.equal(fs.statSync(path.join(dir, 'BrowserMetrics')).mode & 0o777, 0o500);
    fs.rmdirSync(path.join(dir, 'BrowserMetrics'));
    fs.symlinkSync(os.tmpdir(), path.join(dir, 'BrowserMetrics'));
    assert.throws(() => protectBrowserMetrics(dir));
});
